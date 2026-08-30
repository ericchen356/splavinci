'use client';

/**
 * Bringing a capture you already have.
 *
 * Two screens in one component, because they are one act. First the files —
 * name, splat, collision mesh, optional still — uploaded one at a time so the
 * bar means something on a half-gigabyte splat. Then the review, which is the
 * part that earns the flow: the server has read both files by then, and what it
 * measured is on screen beside the one decision no measurement can make for the
 * user, which way up the splat was authored.
 *
 * WHY THE REVIEW EXISTS. Getting the orientation wrong does not fail. The walk
 * grid still rasterises, the path still plans, the flythrough still plays, and
 * the camera flies through a room that is upside down. Asking before the files
 * have been read would be asking blind; asking after means the answer comes
 * with evidence attached and the numbers move as the user changes it.
 *
 * The proposal shown here is computed by `proposeAlignment` — the same function
 * the route runs when it writes scene.json, on the same measurements. So this
 * is a preview of the result rather than an illustration of it. The server
 * recomputes rather than trusting what comes back.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/Icon';
import { DropZone, Field, FileTile, Step } from '@/components/home/FormParts';
import {
  proposeAlignment,
  sizeOf,
  uprightEvidence,
  type Alignment,
} from '@/lib/upload/align';
import type { Vec3 } from '@/lib/types';
// Type-only where the module is server-side, so its node: imports never reach
// the browser bundle.
import type { DraftAnalysis, DraftView } from '@/app/api/uploads/drafts';
import {
  CAPTURE_ORIENTATIONS,
  COLLIDER_ACCEPT_ATTRIBUTE,
  MAX_DESCRIPTION_CHARS,
  ORIENTATION_HINT,
  ORIENTATION_LABEL,
  SPLAT_ACCEPT_ATTRIBUTE,
  THUMBNAIL_ACCEPT_ATTRIBUTE,
  formatBytes,
  validateCaptureUpload,
  type CaptureOrientation,
  type UploadField,
  type UploadSlot,
} from '@/app/api/uploads/limits';

/* ========================================================================== */
/* transfer                                                                   */
/* ========================================================================== */

type ServerError = { field: UploadField | 'draft'; message: string; hint?: string | null };

/**
 * PUT one file, with progress.
 *
 * XMLHttpRequest rather than fetch, for the one thing fetch still cannot do:
 * report how much of a request body has gone out. On a 300 MB splat that is the
 * difference between a progress bar and a frozen screen.
 *
 * The request stays open past the last byte — the server reads the file it has
 * just been handed before it answers — so `onProgress` reaching 1 means "sent",
 * not "done", and the caller says so.
 */
function putFile(
  draftId: string,
  slot: UploadSlot,
  file: File,
  onProgress: (fraction: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<DraftView> {
  return new Promise((settle, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    const query = `slot=${slot}&filename=${encodeURIComponent(file.name)}`;
    xhr.open('PUT', `/api/uploads/${encodeURIComponent(draftId)}?${query}`);
    xhr.responseType = 'text';

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('error', () =>
      reject({ field: slot, message: `The upload of ${file.name} failed to reach the server.` }),
    );
    xhr.addEventListener('abort', () => reject({ field: slot, message: 'Upload cancelled.' }));
    xhr.addEventListener('load', () => {
      let body: { draft?: DraftView; errors?: ServerError[] } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        reject({
          field: slot,
          message: `The server answered the upload of ${file.name} with ${xhr.status} and no JSON.`,
        });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.draft) {
        settle(body.draft);
        return;
      }
      reject(body.errors?.[0] ?? { field: slot, message: `The upload failed (${xhr.status}).` });
    });

    xhr.send(file);
  });
}

/* ========================================================================== */
/* the form                                                                   */
/* ========================================================================== */

type Phase = 'choose' | 'uploading' | 'review' | 'finishing';

type Chosen = Partial<Record<UploadSlot, File>>;

export function UploadForm({
  onAdded,
  onCancel,
}: {
  /** The finished capture's id, once scene.json is on disk. */
  onAdded: (setId: string, alignment: Alignment) => void;
  onCancel: () => void;
}) {
  const [files, setFiles] = useState<Chosen>({});
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState<Partial<Record<UploadField, boolean>>>({});

  const [phase, setPhase] = useState<Phase>('choose');
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [progress, setProgress] = useState<Partial<Record<UploadSlot, number>>>({});
  const [active, setActive] = useState<UploadSlot | null>(null);
  const [failure, setFailure] = useState<ServerError | null>(null);

  const [orientation, setOrientation] = useState<CaptureOrientation | null>(null);
  const [fit, setFit] = useState(true);

  const transfers = useRef<XMLHttpRequest[]>([]);

  const errors = useMemo(
    () =>
      validateCaptureUpload({
        splat: files.splat ?? null,
        collider: files.collider ?? null,
        thumbnail: files.thumbnail ?? null,
        name,
        description,
      }),
    [files, name, description],
  );

  const errorFor = (field: UploadField): string | null => {
    if (failure && failure.field === field) return failure.message;
    return touched[field]
      ? (errors.find((error) => error.field === field)?.message ?? null)
      : null;
  };

  /** Slots the server already holds, so a retry only sends what is missing. */
  const staged = useMemo(
    () => new Set((draft?.files ?? []).map((file) => file.slot)),
    [draft],
  );

  const analysis = draft?.analysis ?? null;

  const choose = useCallback((slot: UploadSlot, file: File | null) => {
    setTouched((was) => ({ ...was, [slot]: true }));
    setFailure(null);
    setFiles((current) => {
      const next = { ...current };
      if (file) next[slot] = file;
      else delete next[slot];
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* upload                                                                  */
  /* ---------------------------------------------------------------------- */

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({ splat: true, collider: true, thumbnail: true, name: true, description: true });
    setFailure(null);
    if (errors.length > 0) return;

    setPhase('uploading');
    try {
      let current = draft;
      if (!current) {
        const response = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, description }),
        });
        const body = (await response.json()) as { draft?: DraftView; errors?: ServerError[] };
        if (!response.ok || !body.draft) {
          throw body.errors?.[0] ?? { field: 'draft' as const, message: 'Could not open the upload.' };
        }
        current = body.draft;
        setDraft(current);
      }

      /* Splat first. It is the long one and the one most likely to be refused,
         and finding that out after a 60 MB collider has gone up is worse than
         finding it out before. Slots the server already holds are skipped, so
         a retry after one bad file does not resend the good ones. */
      const order: UploadSlot[] = ['splat', 'collider', 'thumbnail'];
      for (const slot of order) {
        const file = files[slot];
        const held: DraftView = current;
        if (!file || held.files.some((staged) => staged.slot === slot)) continue;
        setActive(slot);
        setProgress((was) => ({ ...was, [slot]: 0 }));
        current = await putFile(
          held.id,
          slot,
          file,
          (fraction) => setProgress((was) => ({ ...was, [slot]: fraction })),
          (xhr) => transfers.current.push(xhr),
        );
        setDraft(current);
      }

      setActive(null);
      const measured = current.analysis;
      if (measured) {
        setOrientation((already) => already ?? measured.guess.orientation);
        setPhase('review');
      } else {
        // Both required files are staged or the loop would not have finished,
        // so this only happens if the server could not read one of them.
        setPhase('choose');
      }
    } catch (error) {
      setActive(null);
      setFailure(normalise(error));
      setPhase('choose');
    } finally {
      transfers.current = [];
    }
  };

  /* ---------------------------------------------------------------------- */
  /* finish                                                                  */
  /* ---------------------------------------------------------------------- */

  const finish = async () => {
    if (!draft || !orientation) return;
    setPhase('finishing');
    setFailure(null);
    try {
      const response = await fetch(`/api/uploads/${encodeURIComponent(draft.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description, orientation, fit }),
      });
      const body = (await response.json()) as {
        setId?: string;
        alignment?: Alignment;
        errors?: ServerError[];
      };
      if (!response.ok || !body.setId || !body.alignment) {
        throw body.errors?.[0] ?? { field: 'draft' as const, message: 'The capture could not be written.' };
      }
      onAdded(body.setId, body.alignment);
    } catch (error) {
      setFailure(normalise(error));
      setPhase('review');
    }
  };

  const discard = useCallback(async () => {
    for (const xhr of transfers.current) xhr.abort();
    transfers.current = [];
    if (draft) {
      // Best effort: the sweep in drafts.ts collects the folder either way.
      await fetch(`/api/uploads/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }).catch(
        () => {},
      );
    }
    onCancel();
  }, [draft, onCancel]);

  /* ---------------------------------------------------------------------- */
  /* render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (phase === 'review' || phase === 'finishing') {
    return (
      <ReviewPanel
        analysis={analysis}
        orientation={orientation}
        onOrientation={setOrientation}
        fit={fit}
        onFit={setFit}
        busy={phase === 'finishing'}
        failure={failure}
        onFinish={finish}
        onDiscard={discard}
      />
    );
  }

  const busy = phase === 'uploading';
  const totalBytes = (Object.values(files) as File[]).reduce((sum, file) => sum + file.size, 0);
  const summary = [
    files.splat ? 'splat' : null,
    files.collider ? 'collision mesh' : null,
    files.thumbnail ? 'still' : null,
    totalBytes > 0 ? formatBytes(totalBytes) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <form className="home-card" onSubmit={upload} noValidate aria-labelledby="upload-heading">
      <div className="home-card__head">
        <h2 className="home-card__title" id="upload-heading">
          Upload a capture
        </h2>
        <span className="home-card__meta">{summary || 'nothing added yet'}</span>
      </div>

      <p className="home-note" data-tone="info">
        <Icon name="info" />
        <span>
          A splat you already have, with the collision mesh that goes with it. Nothing is
          generated and no credits are spent — the files are read to work out how they sit in
          one world, and you confirm that before anything is added.
        </span>
      </p>

      <Step n={1} title="Splat">
        <SlotZone
          slot="splat"
          file={files.splat}
          staged={staged.has('splat')}
          label="Drop the splat, or choose a file"
          sublabel="SPZ or PLY"
          accept={SPLAT_ACCEPT_ATTRIBUTE}
          error={errorFor('splat')}
          busy={busy}
          progress={progress.splat}
          active={active === 'splat'}
          onChoose={choose}
        />
      </Step>

      <Step n={2} title="Collision mesh">
        <SlotZone
          slot="collider"
          file={files.collider}
          staged={staged.has('collider')}
          label="Drop the collision mesh, or choose a file"
          sublabel="GLB — a .gltf needs its .bin siblings and cannot be uploaded alone"
          accept={COLLIDER_ACCEPT_ATTRIBUTE}
          error={errorFor('collider')}
          busy={busy}
          progress={progress.collider}
          active={active === 'collider'}
          onChoose={choose}
        />
      </Step>

      <Step n={3} title="Name it">
        <Field
          label="Name"
          hint="Shown in the list."
          error={errorFor('name')}
          onBlur={() => setTouched((was) => ({ ...was, name: true }))}
        >
          {(props) => (
            <input
              {...props}
              className="home-input"
              type="text"
              value={name}
              disabled={busy}
              placeholder="Kiln Terrace"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Description"
          hint={`What the space is. Up to ${MAX_DESCRIPTION_CHARS} characters.`}
          optional
          error={errorFor('description')}
          onBlur={() => setTouched((was) => ({ ...was, description: true }))}
        >
          {(props) => (
            <textarea
              {...props}
              className="home-input home-input--area"
              rows={2}
              value={description}
              disabled={busy}
              placeholder="Top-floor studio, captured on a phone and cleaned up in Postshot."
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
      </Step>

      <Step n={4} title="Still" optional>
        {files.thumbnail ? (
          <FileTile
            file={files.thumbnail}
            note={staged.has('thumbnail') ? 'uploaded' : undefined}
            onRemove={busy || staged.has('thumbnail') ? undefined : () => choose('thumbnail', null)}
          />
        ) : (
          <DropZone
            label="Drop a still for the library row, or choose one"
            sublabel="JPG, PNG or WebP"
            accept={THUMBNAIL_ACCEPT_ATTRIBUTE}
            compact
            invalid={Boolean(errorFor('thumbnail'))}
            error={errorFor('thumbnail')}
            onFiles={(chosen) => choose('thumbnail', chosen[0] ?? null)}
          />
        )}
      </Step>

      {failure && (
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" />
          <span>
            {failure.message}
            {failure.hint && <span className="home-note__hint">{failure.hint}</span>}
          </span>
        </p>
      )}

      <div className="home-actions">
        <button type="submit" className="home-pill home-pill--accent" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload and measure'}
        </button>
        <button type="button" className="home-pill" onClick={discard}>
          Cancel
        </button>
      </div>

      {(touched.splat || touched.collider) && errors.length > 0 && !busy && (
        <p className="home-note" data-tone="warn" role="status">
          <Icon name="alert" /> {errors.length}{' '}
          {errors.length === 1 ? 'field needs' : 'fields need'} attention before this can start.
        </p>
      )}
    </form>
  );
}

function normalise(error: unknown): ServerError {
  if (error && typeof error === 'object' && 'message' in error && 'field' in error) {
    return error as ServerError;
  }
  return {
    field: 'draft',
    message: error instanceof Error ? error.message : String(error),
  };
}

/* ========================================================================== */
/* one file slot                                                              */
/* ========================================================================== */

/**
 * A dropzone that becomes a tile once a file is chosen, and a progress bar
 * while that file is going up.
 *
 * The bar reaching the end is not the end: the server reads the file before it
 * answers, and on a large splat that is several seconds of nothing. Saying
 * "Measuring" there is the difference between a pause and a hang.
 */
function SlotZone({
  slot,
  file,
  staged,
  label,
  sublabel,
  accept,
  error,
  busy,
  progress,
  active,
  onChoose,
}: {
  slot: UploadSlot;
  file: File | undefined;
  staged: boolean;
  label: string;
  sublabel?: string;
  accept: string;
  error: string | null;
  busy: boolean;
  progress: number | undefined;
  active: boolean;
  onChoose: (slot: UploadSlot, file: File | null) => void;
}) {
  if (!file) {
    return (
      <DropZone
        label={label}
        sublabel={sublabel}
        accept={accept}
        invalid={Boolean(error)}
        error={error}
        onFiles={(chosen) => onChoose(slot, chosen[0] ?? null)}
      />
    );
  }

  const percent = Math.round((progress ?? 0) * 100);
  const measuring = active && percent >= 100;
  const note = staged ? 'uploaded' : active ? (measuring ? 'measuring…' : `${percent}%`) : undefined;

  return (
    <>
      <FileTile
        file={file}
        note={note}
        onRemove={busy || staged ? undefined : () => onChoose(slot, null)}
      />
      {active && (
        <div
          className="home-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`Uploading ${file.name}`}
        >
          <span className="home-bar__fill" style={{ inlineSize: `${percent}%` }} />
        </div>
      )}
      {error && (
        <p className="home-field__error" role="alert">
          <Icon name="error" /> {error}
        </p>
      )}
    </>
  );
}

/* ========================================================================== */
/* review                                                                     */
/* ========================================================================== */

const METRES = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/**
 * A box, as three numbers. The unit is dropped for an unfitted splat: in the
 * file's own coordinates a "metre" is whatever the trainer decided it was, and
 * printing one would be stating something nobody has measured.
 */
function formatSize(size: Vec3, unit = true): string {
  const parts = `${METRES.format(size[0])} × ${METRES.format(size[1])} × ${METRES.format(size[2])}`;
  return unit ? `${parts} m` : parts;
}

function ReviewPanel({
  analysis,
  orientation,
  onOrientation,
  fit,
  onFit,
  busy,
  failure,
  onFinish,
  onDiscard,
}: {
  analysis: DraftAnalysis | null;
  orientation: CaptureOrientation | null;
  onOrientation: (value: CaptureOrientation) => void;
  fit: boolean;
  onFit: (value: boolean) => void;
  busy: boolean;
  failure: ServerError | null;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const chosen = orientation ?? analysis?.guess.orientation ?? 'y-down';

  const alignment = useMemo(
    () =>
      analysis
        ? proposeAlignment({
            splat: analysis.splat,
            collider: analysis.collider,
            orientation: chosen,
            fit,
          })
        : null,
    [analysis, chosen, fit],
  );

  if (!analysis || !alignment) {
    return (
      <section className="home-card">
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" /> The files were uploaded but not measured. Start again.
        </p>
        <div className="home-actions">
          <button type="button" className="home-pill" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </section>
    );
  }

  const { splat, collider, guess, colliderWarning } = analysis;
  const evidence = uprightEvidence(splat.profile, chosen);
  const match = matchVerdict(alignment.footprintError);

  return (
    <section className="home-card" aria-labelledby="review-heading">
      <div className="home-card__head">
        <h2 className="home-card__title" id="review-heading">
          Check the fit
        </h2>
        <span className="home-card__meta">
          {compact(splat.splatCount)} splats · {compact(collider.triangles)} triangles
        </span>
      </div>

      <dl className="home-facts">
        <Fact term="Splat" detail={`${splat.format.toUpperCase()}, ${compact(splat.splatCount)} splats`}>
          {formatSize(alignment.splatExtent)}
        </Fact>
        <Fact
          term="Collision mesh"
          detail={`${collider.meshes} ${collider.meshes === 1 ? 'mesh' : 'meshes'}, floor ${
            collider.floorSource === 'derived'
              ? 'derived from face normals'
              : collider.floorSource === 'meshes'
                ? 'named in the file'
                : 'not found'
          }`}
        >
          {formatSize(alignment.colliderExtent)}
        </Fact>
        <Fact
          term="Placement"
          detail={
            alignment.fitted
              ? `scaled ×${alignment.placement.scale.toFixed(3)}, floor set on the walk surface`
              : 'left in the file’s own units and origin'
          }
        >
          {alignment.fitted ? `${METRES.format(alignment.placement.position[1])} m lift` : 'as authored'}
        </Fact>
      </dl>

      <p className="home-note" data-tone={match.tone} role="status">
        <Icon name={match.tone === 'ok' ? 'check' : match.tone === 'warn' ? 'alert' : 'error'} />
        <span>{match.message(alignment.footprintError)}</span>
      </p>

      {colliderWarning && (
        <p className="home-note" data-tone="warn">
          <Icon name="alert" /> {colliderWarning}
        </p>
      )}

      <fieldset className="home-choice">
        <legend className="home-choice__legend">
          Which way up was the splat authored?
          <span className="home-choice__note">
            {guess.confidence === 'clear' ? 'Measured: ' : 'Not measurable: '}
            {guess.reason}
          </span>
        </legend>

        {CAPTURE_ORIENTATIONS.map((option) => (
          <label key={option} className="home-choice__option" data-selected={option === chosen || undefined}>
            <input
              type="radio"
              name="orientation"
              value={option}
              checked={option === chosen}
              disabled={busy}
              onChange={() => onOrientation(option)}
            />
            <span className="home-choice__label">
              {ORIENTATION_LABEL[option]}
              {option === guess.orientation && (
                <span className="home-chip home-chip--ink">Measured</span>
              )}
            </span>
            <span className="home-choice__hint">{ORIENTATION_HINT[option]}</span>
          </label>
        ))}

        {/* The number behind the choice, updated as it changes. Interiors are
            bottom-heavy; a ratio under 1 is the room the wrong way up. */}
        <p className="home-choice__evidence">
          This way up, {formatRatio(evidence.ratio)} of the splat opacity sits in the lower half
          of the room.
        </p>
      </fieldset>

      <label className="home-toggle">
        <input
          type="checkbox"
          checked={fit}
          disabled={busy}
          onChange={(event) => onFit(event.target.checked)}
        />
        <span>
          <strong>Fit the splat to the collision mesh</strong>
          <span className="home-toggle__hint">
            Scales the splat so the two agree on the room&rsquo;s footprint and sets its floor on
            the walk surface. Turn this off only if the two files are already in one world —
            {' '}the splat is then placed exactly as authored, at{' '}
            {formatSize(sizeOf(splat.bounds), false)} in its own units.
          </span>
        </span>
      </label>

      {failure && (
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" />
          <span>
            {failure.message}
            {failure.hint && <span className="home-note__hint">{failure.hint}</span>}
          </span>
        </p>
      )}

      <div className="home-actions">
        <button type="button" className="home-pill home-pill--accent" onClick={onFinish} disabled={busy}>
          {busy ? 'Adding…' : 'Add to library'}
        </button>
        <button type="button" className="home-pill" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <p className="home-cost">
          The alignment is written into the capture and can be checked on the plan screen —
          turn the collider wireframe on and see whether the walls line up.
        </p>
      </div>
    </section>
  );
}

function Fact({
  term,
  detail,
  children,
}: {
  term: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="home-facts__row">
      <dt className="home-facts__term">{term}</dt>
      <dd className="home-facts__value">
        <strong>{children}</strong>
        <span className="home-facts__detail">{detail}</span>
      </dd>
    </div>
  );
}

/** How much to trust a fit, by how far the two footprints disagree. */
function matchVerdict(error: number): {
  tone: 'ok' | 'warn' | 'danger';
  message: (error: number) => string;
} {
  if (error <= 0.06) {
    return {
      tone: 'ok',
      message: (value) =>
        `The two files agree on the room's footprint to within ${percent(value)} — they are ` +
        `describing the same space.`,
    };
  }
  if (error <= 0.2) {
    return {
      tone: 'warn',
      message: (value) =>
        `The footprints disagree by ${percent(value)}. That is survivable — a splat usually ` +
        `runs a little past the walls the mesh models — but check the fit on the plan screen.`,
    };
  }
  return {
    tone: 'danger',
    message: (value) =>
      `The footprints disagree by ${percent(value)}. Either these are not the same room, or ` +
      `the orientation below is wrong — a Z-up file read as Y-up gets exactly this.`,
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'all';
  const share = ratio / (1 + ratio);
  return `${Math.round(share * 100)}%`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
