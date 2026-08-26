'use client';

/**
 * The library — the way into the product.
 *
 * Two jobs, in this order of importance:
 *
 *   1. CHOOSE A CAPTURE. This list is the only place a capture is picked. The
 *      plan screen used to carry a switcher, and switching mid-session silently
 *      discarded the waypoints you had just placed; choosing a room is a
 *      library act, so it happens before you are in the editor. Each row is a
 *      link to /plan?capture=<id> and nothing else.
 *   2. MAKE ONE. Photos and/or a walkthrough video, an optional floor plan and
 *      an optional sentence about the layout go to /api/renders, which runs the
 *      same two-stage Marble pipeline the CLI runs. That takes minutes, so the
 *      POST only starts a job and this screen polls it.
 *
 * A client component in one file on purpose. Server-rendering the list would
 * save a frame of skeleton, but it would need a second file for the interactive
 * half, and everything here — dropzone, validation, polling — is interactive.
 */

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/Icon';
import { registerAssetSets } from '@/lib/assets';
import type { RenderSummary } from '@/lib/renders';
// Type-only, so the node:fs in these modules never reaches the browser bundle.
import type { FieldError } from './api/renders/limits';
import type { JobView } from './api/renders/jobs';
import {
  ACCEPT_ATTRIBUTE,
  VIDEO_ACCEPT_ATTRIBUTE,
  formatBytes,
  validateUpload,
} from './api/renders/limits';

/** Fast enough that the bar moves, slow enough that a 30-minute build is ~1800 polls. */
const POLL_MS = 1_000;

type Field = FieldError['field'];

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function isTerminal(phase: JobView['phase']): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

/* ========================================================================== */
/* page                                                                       */
/* ========================================================================== */

export default function Home() {
  const [renders, setRenders] = useState<RenderSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  /** The capture this session just made, so it is findable in a long list. */
  const [freshId, setFreshId] = useState<string | null>(null);

  const loadRenders = useCallback(async () => {
    try {
      const response = await fetch('/api/renders', { cache: 'no-store' });
      if (!response.ok) throw new Error(`the render list returned ${response.status}`);
      const body = (await response.json()) as { renders: RenderSummary[] };
      // Without this, /plan?capture=<id> resolves an id it has never heard of
      // and quietly opens the default room instead. Client-side navigation
      // keeps this module alive, so registering here is enough for the links
      // below; a cold load straight into /plan is not covered.
      registerAssetSets(body.renders.map((row) => row.assetSet));
      setRenders(body.renders);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
      setRenders((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadRenders();
  }, [loadRenders]);

  /* Poll while a build is in flight. Each response re-runs this effect, which
     schedules the next tick — so the loop stops the moment a phase is terminal
     without a second piece of state saying so. */
  useEffect(() => {
    if (!job || isTerminal(job.phase)) return;
    let stopped = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' });
        if (response.status === 404) {
          if (!stopped) {
            setJob({
              ...job,
              phase: 'failed',
              error: {
                message: 'The server lost track of this build (it restarted).',
                hint: 'Any generation already paid for is still running at World Labs.',
                kind: null,
              },
            });
          }
          return;
        }
        // A 500, or a proxy answering with an HTML error page, is a dropped
        // poll and not news about the build. Without this the undefined `job`
        // it parses to unmounts the panel and stops the loop, and a generation
        // that is still running and still billing disappears off the screen.
        if (!response.ok) throw new Error(`the job endpoint returned ${response.status}`);
        const body = (await response.json()) as { job?: JobView };
        if (!body.job) throw new Error('the job endpoint answered without a job');
        if (!stopped) setJob(body.job);
      } catch {
        // A dropped poll is not a failed build. The next tick asks again.
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };

    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job]);

  /* A finished build means a new folder under public/generated, which only the
     server can see. */
  const finishedId = job?.phase === 'done' ? job.renderId : null;
  useEffect(() => {
    if (!finishedId) return;
    setFreshId(finishedId);
    void loadRenders();
  }, [finishedId, loadRenders]);

  const startJob = useCallback((started: JobView) => {
    setJob(started);
    setCreating(false);
  }, []);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    try {
      const response = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
      const body = (await response.json()) as { job?: JobView };
      if (body.job) setJob(body.job);
    } catch {
      // The abort is the server's to honour; if the request never landed the
      // next poll will show the build still running, which is the truth.
    }
  }, [job]);

  const showForm = creating && !(job && !isTerminal(job.phase));

  return (
    <main className="home">
      <header className="home__head">
        <div>
          <h1 className="home__title">splavinci</h1>
          <p className="home__lede">
            Author a camera flythrough through a captured room. Pick a capture to plan a
            path in it, or build a new one from photos or a walkthrough video.
          </p>
        </div>
        <button
          type="button"
          className="home-pill home-pill--accent"
          onClick={() => {
            setCreating((open) => !open);
            setJob(null);
          }}
          aria-expanded={showForm}
        >
          {showForm ? 'Cancel' : 'New render'}
        </button>
      </header>

      {job && <JobPanel job={job} onCancel={cancelJob} onDismiss={() => setJob(null)} />}

      {showForm && <CreateForm onStarted={startJob} />}

      <RenderList
        renders={renders}
        error={listError}
        freshId={freshId}
        onCreate={() => setCreating(true)}
      />
    </main>
  );
}

/* ========================================================================== */
/* the list                                                                   */
/* ========================================================================== */

function RenderList({
  renders,
  error,
  freshId,
  onCreate,
}: {
  renders: RenderSummary[] | null;
  error: string | null;
  freshId: string | null;
  onCreate: () => void;
}) {
  return (
    <section className="home-card" aria-labelledby="renders-heading">
      <div className="home-card__head">
        <h2 className="home-card__title" id="renders-heading">
          Renders
        </h2>
        <span className="home-card__meta">
          {renders === null
            ? 'loading…'
            : `${renders.length} ${renders.length === 1 ? 'capture' : 'captures'}`}
        </span>
      </div>

      {error && (
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" /> Could not load the list — {error}.
        </p>
      )}

      {renders === null ? (
        <ul className="home-renders" aria-hidden="true">
          {[0, 1].map((n) => (
            <li key={n} className="home-render home-render--skeleton" />
          ))}
        </ul>
      ) : renders.length === 0 ? (
        <button type="button" className="home-empty" onClick={onCreate}>
          <span className="home-empty__title">No captures yet</span>
          <span className="home-empty__body">
            Build one from a handful of interior photos, or from a video of a walk
            through the space.
          </span>
        </button>
      ) : (
        <ul className="home-renders">
          {renders.map((render) => (
            <li key={render.id}>
              <RenderRow render={render} fresh={render.id === freshId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenderRow({ render, fresh }: { render: RenderSummary; fresh: boolean }) {
  const facts = [
    render.splatBytes === null ? null : formatBytes(render.splatBytes),
    render.approxSplats === null ? null : `${compactCount(render.approxSplats)} splats`,
    render.createdAt === null ? null : DATE.format(new Date(render.createdAt)),
  ].filter((fact): fact is string => fact !== null);

  return (
    <Link
      href={`/plan?capture=${encodeURIComponent(render.id)}`}
      className="home-render"
      data-fresh={fresh || undefined}
      data-missing={render.present ? undefined : true}
    >
      <span className="home-render__thumb">
        {render.thumbnail ? (
          /* Plain <img>: these are user uploads under public/, sized by CSS, and
             next/image would add an optimiser round trip for a 72px square. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={render.thumbnail} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="home-render__glyph" aria-hidden="true">
            {render.label.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>

      <span className="home-render__text">
        <span className="home-render__line">
          <strong className="home-render__name">{render.label}</strong>
          {facts.length > 0 && <span className="home-render__facts">{facts.join(' · ')}</span>}
          {fresh && <span className="home-chip home-chip--ink">New</span>}
          {render.source === 'builtin' && <span className="home-chip">Bundled</span>}
          {!render.present && <span className="home-chip home-chip--warn">Files missing</span>}
        </span>
        <span className="home-render__desc">{render.description}</span>
      </span>

      <span className="home-render__go" aria-hidden="true">
        <Icon name="chevron-right" />
      </span>
    </Link>
  );
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/* ========================================================================== */
/* progress                                                                   */
/* ========================================================================== */

const PHASE_LABEL: Record<JobView['phase'], string> = {
  queued: 'Queued',
  intake: 'Composing the prompt',
  extracting: 'Extracting frames',
  uploading: 'Uploading images',
  generating: 'Generating the world',
  downloading: 'Downloading assets',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function JobPanel({
  job,
  onCancel,
  onDismiss,
}: {
  job: JobView;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const running = !isTerminal(job.phase);
  const percent = Math.round(job.progress * 100);

  return (
    <section className="home-card" aria-labelledby="job-heading">
      <div className="home-card__head">
        <h2 className="home-card__title" id="job-heading">
          {job.name}
        </h2>
        <span className="home-card__meta">
          {PHASE_LABEL[job.phase]} · {formatElapsed(job.elapsedMs)}
        </span>
      </div>

      <div
        className="home-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-labelledby="job-heading"
        data-state={job.phase}
      >
        <span className="home-bar__fill" style={{ inlineSize: `${percent}%` }} />
      </div>

      {/* Polite, not assertive: this changes every second and would otherwise
          talk over everything else a screen reader user is doing. */}
      <p className="home-job__status" aria-live="polite" aria-busy={running}>
        <span className="home-job__percent">{percent}%</span>
        {job.message}
      </p>

      {job.error && (
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" />
          <span>
            {job.error.message}
            {job.error.hint && <span className="home-note__hint">{job.error.hint}</span>}
          </span>
        </p>
      )}

      {job.log.length > 0 && (
        <details className="home-job__details">
          <summary>Build log</summary>
          <pre className="home-job__log">{job.log.join('\n')}</pre>
        </details>
      )}

      <div className="home-actions">
        {running ? (
          <button type="button" className="home-pill" onClick={onCancel}>
            Stop this build
          </button>
        ) : (
          <>
            {job.phase === 'done' && job.renderId && (
              <Link
                href={`/plan?capture=${encodeURIComponent(job.renderId)}`}
                className="home-pill home-pill--accent"
              >
                Open in plan
              </Link>
            )}
            <button type="button" className="home-pill" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/* ========================================================================== */
/* the upload form                                                            */
/* ========================================================================== */

function CreateForm({ onStarted }: { onStarted: (job: JobView) => void }) {
  const [photos, setPhotos] = useState<File[]>([]);
  const [video, setVideo] = useState<File | null>(null);
  const [blueprint, setBlueprint] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errors = useMemo(
    () => validateUpload({ photos, video, blueprint, description, keywords, name }),
    [photos, video, blueprint, description, keywords, name],
  );
  const errorFor = (field: Field): string | null =>
    touched[field] ? (errors.find((error) => error.field === field)?.message ?? null) : null;

  const addPhotos = useCallback((files: File[]) => {
    setTouched((was) => ({ ...was, photos: true }));
    setPhotos((current) => {
      // Same file dropped twice is a slip, not an instruction; Marble counts it
      // against an 8-image cap either way.
      const seen = new Set(current.map(fileKey));
      return [...current, ...files.filter((file) => !seen.has(fileKey(file)))];
    });
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({
      photos: true,
      video: true,
      blueprint: true,
      description: true,
      keywords: true,
      name: true,
    });
    setSubmitError(null);
    if (errors.length > 0) return;

    setSubmitting(true);
    try {
      const body = new FormData();
      for (const photo of photos) body.append('photos', photo);
      if (video) body.append('video', video);
      if (blueprint) body.append('blueprint', blueprint);
      body.set('name', name);
      body.set('description', description);
      body.set('keywords', keywords);

      const response = await fetch('/api/renders', { method: 'POST', body });
      const payload = (await response.json()) as { job?: JobView; errors?: FieldError[] };
      if (!response.ok) {
        setSubmitError(
          payload.errors?.map((error) => error.message).join(' ') ??
            `The server refused the upload (${response.status}).`,
        );
        return;
      }
      if (payload.job) onStarted(payload.job);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const totalBytes =
    photos.reduce((sum, file) => sum + file.size, 0) + (blueprint?.size ?? 0) + (video?.size ?? 0);
  // Only what is actually attached. "0 photos" beside a 60 MB video was the
  // form counting a thing the user had chosen not to give it.
  const summary = [
    photos.length > 0 ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}` : null,
    video ? 'video' : null,
    blueprint ? 'floor plan' : null,
    totalBytes > 0 ? formatBytes(totalBytes) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <form className="home-card" onSubmit={submit} noValidate aria-labelledby="create-heading">
      <div className="home-card__head">
        <h2 className="home-card__title" id="create-heading">
          New render
        </h2>
        <span className="home-card__meta">{summary || 'nothing added yet'}</span>
      </div>

      {/* One step, because it is one requirement: either half satisfies it, and
          splitting them into steps 1 and 2 would read as "do both". */}
      <Step n={1} title="Photos or video">
        <DropZone
          label="Drop photos here, or choose files"
          sublabel="JPG, PNG or WebP"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          invalid={Boolean(errorFor('photos'))}
          error={errorFor('photos')}
          onFiles={addPhotos}
        />
        {photos.length > 0 && (
          <ul className="home-files">
            {photos.map((file) => (
              <li key={fileKey(file)}>
                <FileTile
                  file={file}
                  onRemove={() =>
                    setPhotos((current) => current.filter((other) => fileKey(other) !== fileKey(file)))
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {/* Two stacked dropzones read as "fill in both". This is the only thing
            on the step that says they are alternatives. */}
        <span className="home-or" aria-hidden="true">
          or
        </span>

        {video ? (
          <FileTile file={video} onRemove={() => setVideo(null)} />
        ) : (
          <DropZone
            label="Drop a walkthrough video, or choose a file"
            sublabel="MOV, MP4 or M4V"
            accept={VIDEO_ACCEPT_ATTRIBUTE}
            invalid={Boolean(errorFor('video'))}
            error={errorFor('video')}
            compact
            onFiles={(files) => {
              setTouched((was) => ({ ...was, video: true }));
              setVideo(files[0] ?? null);
            }}
          />
        )}
      </Step>

      <Step n={2} title="Floor plan" optional>
        {blueprint ? (
          <FileTile file={blueprint} onRemove={() => setBlueprint(null)} />
        ) : (
          <DropZone
            label="Drop a floor plan, or choose a file"
            sublabel="JPG, PNG or WebP"
            accept={ACCEPT_ATTRIBUTE}
            invalid={Boolean(errorFor('blueprint'))}
            error={errorFor('blueprint')}
            compact
            onFiles={(files) => {
              setTouched((was) => ({ ...was, blueprint: true }));
              setBlueprint(files[0] ?? null);
            }}
          />
        )}
      </Step>

      <Step n={3} title="Describe the space" optional>
        <Field
          label="Layout"
          hint="Room count and what leads to what."
          optional
          error={errorFor('description')}
          onBlur={() => setTouched((was) => ({ ...was, description: true }))}
        >
          {(props) => (
            <textarea
              {...props}
              className="home-input home-input--area"
              rows={3}
              value={description}
              placeholder="an open-plan kitchen leading into a living room, two bedrooms off a hallway"
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>

        <div className="home-pair">
          <Field
            label="Keywords"
            hint="Materials, era, light, mood."
            optional
            error={errorFor('keywords')}
            onBlur={() => setTouched((was) => ({ ...was, keywords: true }))}
          >
            {(props) => (
              <input
                {...props}
                className="home-input"
                type="text"
                value={keywords}
                placeholder="warm oak floors, mid-century furniture, morning light"
                onChange={(event) => setKeywords(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Name"
            hint="Shown in the list."
            optional
            error={errorFor('name')}
            onBlur={() => setTouched((was) => ({ ...was, name: true }))}
          >
            {(props) => (
              <input
                {...props}
                className="home-input"
                type="text"
                value={name}
                placeholder="Maple Street"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        </div>
      </Step>

      <div className="home-actions">
        <button
          type="submit"
          className="home-pill home-pill--accent"
          disabled={submitting}
          aria-describedby="create-cost"
        >
          {submitting ? 'Starting…' : 'Create render'}
        </button>

        {/* Not a caption about the machinery — the one consequence of pressing
            the button that is not visible on the screen. */}
        <p className="home-cost" id="create-cost">
          Every build runs a real Marble generation and spends World Labs credits.
        </p>
      </div>

      {submitError && (
        <p className="home-note" data-tone="danger" role="alert">
          <Icon name="error" /> {submitError}
        </p>
      )}
      {(touched.photos || touched.video) && errors.length > 0 && (
        <p className="home-note" data-tone="warn" role="status">
          <Icon name="alert" /> {errors.length} {errors.length === 1 ? 'field needs' : 'fields need'} attention
          before this can start.
        </p>
      )}
    </form>
  );
}

/** Identity for a File the DOM does not give us. Good enough to de-duplicate. */
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/* ========================================================================== */
/* form parts                                                                 */
/* ========================================================================== */

/* A numbered step. No slot for a caption beside the title: the ones that were
   there explained how the pipeline works, which is not a thing anyone filling
   in this form needs to know. What the field accepts stays, on the control. */
function Step({
  n,
  title,
  optional,
  children,
}: {
  n: number;
  title: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="home-step">
      <div className="home-step__head">
        <span className="home-step__n" aria-hidden="true">
          {n}
        </span>
        <span className="home-step__title">
          {title}
          {optional && <span className="home-step__optional">optional</span>}
        </span>
      </div>
      <div className="home-step__body">{children}</div>
    </section>
  );
}

/**
 * A real file input with a drop target draped over it.
 *
 * The input is the control: it is what Tab reaches, what Enter opens, and what
 * the label names. Dragging is an accelerator layered on top, never the only
 * route in — WCAG 2.2 requires a single-pointer alternative for any drag the
 * page invents, and a div with an onDrop handler is exactly that trap.
 */
function DropZone({
  label,
  sublabel,
  accept,
  multiple,
  compact,
  invalid,
  error,
  onFiles,
}: {
  label: string;
  sublabel?: string;
  /** Filters the picker only. A drop bypasses it, so `validateUpload` is the check. */
  accept: string;
  multiple?: boolean;
  compact?: boolean;
  invalid?: boolean;
  error?: string | null;
  onFiles: (files: File[]) => void;
}) {
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const subId = `${inputId}-sub`;
  const errorId = `${inputId}-error`;
  const [over, setOver] = useState(false);
  /* dragenter/dragleave fire for every child the pointer crosses; a depth count
     is the only way to know the pointer actually left the zone. */
  const depth = useRef(0);

  return (
    <>
      <label
        className="home-drop"
        htmlFor={inputId}
        data-over={over || undefined}
        data-invalid={invalid || undefined}
        data-compact={compact || undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setOver(false);
          const dropped = Array.from(event.dataTransfer.files);
          if (dropped.length > 0) onFiles(multiple ? dropped : dropped.slice(0, 1));
        }}
      >
        {/* Named by the visible text rather than by the wrapping <label>: a file
            input's implicit label is resolved inconsistently, and the one thing
            that must never be in doubt is what this control is called. */}
        <input
          id={inputId}
          className="visually-hidden"
          type="file"
          accept={accept}
          multiple={multiple}
          aria-labelledby={labelId}
          aria-invalid={invalid || undefined}
          aria-describedby={[sublabel ? subId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (chosen.length > 0) onFiles(chosen);
            // Cleared so re-picking the same file after a remove still fires.
            event.target.value = '';
          }}
        />
        <span className="home-drop__label" id={labelId}>
          {label}
        </span>
        {sublabel && (
          <span className="home-drop__sub" id={subId}>
            {sublabel}
          </span>
        )}
      </label>
      {error && (
        <p className="home-field__error" id={errorId} role="alert">
          <Icon name="error" /> {error}
        </p>
      )}
    </>
  );
}

function FileTile({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="home-file">
      <span className="home-file__name" title={file.name}>
        {file.name}
      </span>
      <span className="home-file__size">{formatBytes(file.size)}</span>
      <button
        type="button"
        className="home-file__remove"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/**
 * Label, hint, control, error — wired together by id.
 *
 * A render prop rather than a wrapper so the input keeps its own type and
 * value binding while this owns the parts that must agree: `id` on the label,
 * `aria-describedby` pointing at both the hint and the error, `aria-invalid`
 * when there is one.
 */
function Field({
  label,
  hint,
  optional,
  error,
  onBlur,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  error: string | null;
  onBlur: () => void;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
    onBlur: () => void;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="home-field">
      <label className="home-field__label" htmlFor={id}>
        {label}
        {optional && <span className="home-field__optional">optional</span>}
      </label>
      {children({
        id,
        'aria-describedby': described || undefined,
        'aria-invalid': error ? true : undefined,
        onBlur,
      })}
      {hint && (
        <p className="home-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="home-field__error" id={errorId} role="alert">
          <Icon name="error" /> {error}
        </p>
      )}
    </div>
  );
}
