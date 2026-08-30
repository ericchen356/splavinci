/**
 * Bringing a capture you already have into the library.
 *
 * The generate path (../renders/jobs.ts) spends minutes and money to produce a
 * splat and a collider. This one is handed both, so everything expensive falls
 * away and what is left is the two things a capture still needs before it can
 * be planned in: proof that the files are what they claim to be, and a
 * statement of how they sit in the same world. See lib/upload/align.ts for why
 * the second one cannot be assumed.
 *
 * WHY A DRAFT AND NOT ONE REQUEST
 * A splat is up to two thirds of a gigabyte. `request.formData()` buffers a
 * multipart body in memory before a handler sees a byte of it, so a one-shot
 * POST would hold the whole capture in the dev server's heap — and would give
 * the browser one opaque wait with no progress in it. Instead a draft reserves
 * the capture folder, each file is streamed into it by its own PUT, and the
 * measurements come back with the last one. The user reads what was measured
 * and chooses the orientation BEFORE anything is committed, which matters
 * because the one thing that cannot be measured from the bytes is which way up
 * the file was authored.
 *
 * WHY THE STAGING AREA IS THE DESTINATION
 * Files are written as `<final name>.part` inside the capture folder itself,
 * not into a temp dir. Two reasons. There is no cross-device rename to fail on
 * — `os.tmpdir()` and the project are routinely on different volumes. And
 * lib/renders.ts lists only folders that carry a scene.json, so a draft is
 * invisible to the library until the moment it is finished, without anything
 * having to hide it.
 *
 * WHY A MODULE-LEVEL MAP
 * Same prototype registry as jobs.ts, with the same caveat: one process, in
 * memory, gone on restart, wrong the moment this runs on more than one
 * instance. Unlike a job, a lost draft leaves bytes on disk — so every draft
 * folder carries a `.upload-draft.json` marker and `sweepDrafts` deletes the
 * abandoned ones. The marker is what makes that safe: a Marble build's folder
 * is also incomplete for minutes at a time and does not carry one.
 *
 * SERVER ONLY: node:fs, node:crypto, and three.js by way of the collider scan.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isMarbleError } from '@/lib/marble';
import {
  colliderFrameWarning,
  guessOrientation,
  proposeAlignment,
  type Alignment,
  type OrientationGuess,
  type SplatScan,
} from '@/lib/upload/align';
import { scanCollider, type ColliderInspection } from '@/lib/upload/colliderScan';
import { SplatScanError, scanSplat } from '@/lib/upload/splatScan';

import { GENERATED_DIR, reserveSetId, safeFileName } from '../renders/folders';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  extensionOf,
  isAcceptedFor,
  isCaptureOrientation,
  maxBytesFor,
  splatKindOf,
  type CaptureOrientation,
  type UploadSlot,
} from './limits';

/* -------------------------------------------------------------------------- */
/* public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** One staged file, as the client sees it. */
export type StagedFile = {
  slot: UploadSlot;
  /** What the user called it. */
  originalName: string;
  /** What it was written as, and what it will be called in the capture. */
  storedAs: string;
  bytes: number;
  sha256: string;
};

/**
 * Everything measured off the two files, handed over whole.
 *
 * The client re-runs `proposeAlignment` on exactly this, so the placement shown
 * beside an orientation is the placement that orientation produces. The server
 * recomputes it from its own copy at finalise time and never trusts the numbers
 * that come back.
 */
export type DraftAnalysis = {
  splat: SplatScan;
  collider: ColliderInspection;
  /** The default for the orientation control, and why. */
  guess: OrientationGuess;
  /** Something wrong with the collider itself, or null. */
  colliderWarning: string | null;
};

export type DraftView = {
  id: string;
  setId: string;
  name: string;
  description: string;
  files: StagedFile[];
  /** Present once both the splat and the collider have landed and been read. */
  analysis: DraftAnalysis | null;
  expiresAt: string;
};

export class UploadError extends Error {
  readonly field: UploadSlot | 'name' | 'description' | 'draft';
  readonly hint: string | null;
  readonly status: number;

  constructor(input: {
    field: UploadError['field'];
    message: string;
    hint?: string | null;
    status?: number;
  }) {
    super(input.message);
    this.name = 'UploadError';
    this.field = input.field;
    this.hint = input.hint ?? null;
    this.status = input.status ?? 400;
  }
}

/* -------------------------------------------------------------------------- */
/* the registry                                                               */
/* -------------------------------------------------------------------------- */

type Draft = {
  view: DraftView;
  dir: string;
  staged: Map<UploadSlot, StagedFile>;
  splatScan: SplatScan | null;
  colliderScan: ColliderInspection | null;
  /** Set while a PUT is writing, so two uploads of one slot cannot interleave. */
  busy: Set<UploadSlot>;
};

/**
 * Pinned to globalThis for the same reason jobs.ts is: `next dev` re-evaluates
 * a route's module graph on hot reload, and a plain module-level Map would
 * strand a half-uploaded capture on disk with nothing left that knows its id.
 */
const globalScope = globalThis as unknown as { __splavinciUploadDrafts?: Map<string, Draft> };
const DRAFTS: Map<string, Draft> = (globalScope.__splavinciUploadDrafts ??= new Map<string, Draft>());

/** Long enough to upload half a gigabyte on a slow line and then think. */
const DRAFT_TTL_MS = 2 * 60 * 60_000;

/** Written into every draft folder; the only thing that makes a sweep safe. */
const MARKER_FILE = '.upload-draft.json';
const PART_SUFFIX = '.part';

const FINAL_NAME: Record<UploadSlot, (extension: string) => string> = {
  splat: (extension) => `room.${extension}`,
  collider: () => 'collider.glb',
  // lib/renders.ts looks for exactly these names when it builds a list row.
  thumbnail: (extension) => `thumbnail.${extension === 'jpeg' ? 'jpg' : extension}`,
};

function view(draft: Draft): DraftView {
  return {
    ...draft.view,
    files: [...draft.staged.values()],
    analysis:
      draft.splatScan && draft.colliderScan
        ? {
            splat: draft.splatScan,
            collider: draft.colliderScan,
            guess: guessOrientation(draft.splatScan),
            colliderWarning: colliderFrameWarning(draft.colliderScan),
          }
        : null,
  };
}

export function getDraft(id: string): DraftView | null {
  const draft = DRAFTS.get(id);
  return draft ? view(draft) : null;
}

/* -------------------------------------------------------------------------- */
/* sweeping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Delete drafts that were abandoned, on disk as well as in memory.
 *
 * Two populations. Drafts this process still knows about, which expire by TTL.
 * And folders left by a previous process — a restart, a crash, a hot reload
 * that took the map with it — which are found by their marker file and its
 * timestamp. Only marked folders are ever touched, so a Marble build that is
 * mid-download when this runs is not at risk.
 */
export async function sweepDrafts(): Promise<void> {
  const now = Date.now();

  for (const [id, draft] of DRAFTS) {
    if (Date.parse(draft.view.expiresAt) < now) {
      DRAFTS.delete(id);
      await rm(draft.dir, { recursive: true, force: true });
    }
  }

  let entries: string[] = [];
  try {
    const dirents = await readdir(GENERATED_DIR, { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return; // Nothing has ever been written here.
  }

  const live = new Set([...DRAFTS.values()].map((draft) => draft.view.setId));
  for (const entry of entries) {
    if (live.has(entry)) continue;
    const dir = join(GENERATED_DIR, entry);
    try {
      const marker = JSON.parse(await readFile(join(dir, MARKER_FILE), 'utf8')) as {
        createdAt?: unknown;
      };
      const createdAt = typeof marker.createdAt === 'string' ? Date.parse(marker.createdAt) : 0;
      if (now - createdAt > DRAFT_TTL_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // No marker, or an unreadable one: not a draft, so not ours to delete.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* create                                                                     */
/* -------------------------------------------------------------------------- */

export async function createDraft(input: {
  name: string;
  description: string;
}): Promise<DraftView> {
  const name = input.name.trim();
  if (!name) {
    throw new UploadError({ field: 'name', message: 'Give the capture a name.' });
  }
  if (name.length > MAX_NAME_CHARS) {
    throw new UploadError({
      field: 'name',
      message: `Keep the name under ${MAX_NAME_CHARS} characters.`,
    });
  }
  const description = input.description.trim().slice(0, MAX_DESCRIPTION_CHARS);

  await sweepDrafts();

  const setId = await reserveSetId(name);
  const dir = join(GENERATED_DIR, setId);
  await mkdir(dir, { recursive: true });

  const createdAt = new Date();
  await writeFile(
    join(dir, MARKER_FILE),
    `${JSON.stringify({ createdAt: createdAt.toISOString(), name }, null, 2)}\n`,
    'utf8',
  );

  const draft: Draft = {
    dir,
    staged: new Map(),
    splatScan: null,
    colliderScan: null,
    busy: new Set(),
    view: {
      id: randomUUID(),
      setId,
      name,
      description,
      files: [],
      analysis: null,
      expiresAt: new Date(createdAt.getTime() + DRAFT_TTL_MS).toISOString(),
    },
  };
  DRAFTS.set(draft.view.id, draft);
  return view(draft);
}

export async function discardDraft(id: string): Promise<boolean> {
  const draft = DRAFTS.get(id);
  if (!draft) return false;
  DRAFTS.delete(id);
  await rm(draft.dir, { recursive: true, force: true });
  return true;
}

/* -------------------------------------------------------------------------- */
/* staging                                                                    */
/* -------------------------------------------------------------------------- */

/** The draft, or the one error every route here answers a stale id with. */
function mustGetDraft(id: string): Draft {
  const draft = DRAFTS.get(id);
  if (!draft) {
    throw new UploadError({
      field: 'draft',
      message: 'This upload is no longer open.',
      hint: 'The server restarted, or it sat unfinished for two hours. Start it again.',
      status: 404,
    });
  }
  return draft;
}

/**
 * Stream one file into the draft folder, hashing as it goes.
 *
 * The cap is enforced against the bytes that actually arrive rather than
 * against a Content-Length header, because the header is the client's claim
 * and the disk write is the thing being protected. A body that runs over is
 * cut off and the partial file deleted.
 */
export async function stageFile(
  id: string,
  slot: UploadSlot,
  originalName: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<DraftView> {
  const draft = mustGetDraft(id);
  const name = safeFileName(originalName, `capture.${slot}`);

  if (!isAcceptedFor(slot, name)) {
    throw new UploadError({ field: slot, message: `${name} is not an accepted ${slot} file.` });
  }
  if (!body) {
    throw new UploadError({ field: slot, message: `${name} arrived with no body.` });
  }
  if (draft.busy.has(slot)) {
    throw new UploadError({
      field: slot,
      message: `Another upload of the ${slot} is already in progress.`,
      status: 409,
    });
  }

  const extension = extensionOf(name);
  const storedAs = FINAL_NAME[slot](extension);
  const partPath = join(draft.dir, `${storedAs}${PART_SUFFIX}`);
  const cap = maxBytesFor(slot);

  draft.busy.add(slot);
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(
      async function* count() {
        for await (const chunk of source) {
          const buffer = chunk as Buffer;
          bytes += buffer.length;
          if (bytes > cap) {
            throw new UploadError({
              field: slot,
              message: `${name} is larger than the ${Math.round(cap / (1024 * 1024))} MB limit.`,
              status: 413,
            });
          }
          hash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(partPath),
    );
  } catch (error) {
    await rm(partPath, { force: true });
    draft.busy.delete(slot);
    draft.staged.delete(slot);
    if (slot === 'splat') draft.splatScan = null;
    if (slot === 'collider') draft.colliderScan = null;
    throw error instanceof UploadError
      ? error
      : new UploadError({
          field: slot,
          message: `${name} could not be written: ${error instanceof Error ? error.message : String(error)}`,
          status: 500,
        });
  }

  if (bytes === 0) {
    await rm(partPath, { force: true });
    draft.busy.delete(slot);
    throw new UploadError({ field: slot, message: `${name} is empty.` });
  }

  draft.staged.set(slot, {
    slot,
    originalName: name,
    storedAs,
    bytes,
    sha256: hash.digest('hex'),
  });

  try {
    await measure(draft, slot, partPath, name);
  } finally {
    draft.busy.delete(slot);
  }

  return view(draft);
}

/**
 * Read what just landed.
 *
 * Deliberately inside the PUT the user is already waiting on: they have just
 * watched a progress bar fill, and a few more seconds under "Measuring" is a
 * better place for this than a separate request that has to be explained.
 */
async function measure(
  draft: Draft,
  slot: UploadSlot,
  path: string,
  name: string,
): Promise<void> {
  if (slot === 'thumbnail') return;

  try {
    if (slot === 'splat') {
      const kind = splatKindOf(name);
      if (!kind) throw new SplatScanError(`${name} is neither .spz nor .ply.`);
      draft.splatScan = await scanSplat(path, kind);
      return;
    }
    draft.colliderScan = await scanCollider(path);
  } catch (error) {
    // The bytes are on disk but they are not a capture. Drop the slot so the
    // form asks for the file again rather than offering to finish.
    await rm(path, { force: true });
    draft.staged.delete(slot);
    if (slot === 'splat') draft.splatScan = null;
    else draft.colliderScan = null;

    if (error instanceof SplatScanError) {
      throw new UploadError({ field: slot, message: error.message, hint: error.hint });
    }
    if (isMarbleError(error)) {
      throw new UploadError({ field: slot, message: error.message, hint: error.hint ?? null });
    }
    throw new UploadError({
      field: slot,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* finish                                                                     */
/* -------------------------------------------------------------------------- */

export type FinishInput = {
  name?: string;
  description?: string;
  orientation: CaptureOrientation;
  /** False keeps the splat in its own units, turned but not scaled or moved. */
  fit: boolean;
};

export type FinishResult = {
  setId: string;
  alignment: Alignment;
};

/**
 * Turn the draft into a capture: rename the parts, write scene.json, drop the
 * marker.
 *
 * scene.json last and the marker after it, in that order. Until scene.json
 * exists the folder is not a render to lib/renders.ts, and while the marker
 * exists the folder is a sweepable draft — so an interruption anywhere in here
 * leaves something that is either fully a capture or fully collectable, never
 * a half-listed row.
 */
export async function finishDraft(id: string, input: FinishInput): Promise<FinishResult> {
  const draft = mustGetDraft(id);

  const splat = draft.staged.get('splat');
  const collider = draft.staged.get('collider');
  if (!splat || !draft.splatScan) {
    throw new UploadError({ field: 'splat', message: 'The splat has not been uploaded yet.' });
  }
  if (!collider || !draft.colliderScan) {
    throw new UploadError({
      field: 'collider',
      message: 'The collision mesh has not been uploaded yet.',
    });
  }
  if (!isCaptureOrientation(input.orientation)) {
    throw new UploadError({ field: 'splat', message: 'Unknown orientation.' });
  }
  if (draft.busy.size > 0) {
    throw new UploadError({
      field: 'draft',
      message: 'A file is still uploading.',
      status: 409,
    });
  }

  const name = (input.name ?? draft.view.name).trim() || draft.view.name;
  const description = (input.description ?? draft.view.description)
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);

  // Recomputed here from the server's own scan. The form ran the same function
  // to show the user what they were choosing, and its answer is not input.
  const alignment = proposeAlignment({
    splat: draft.splatScan,
    collider: draft.colliderScan,
    orientation: input.orientation,
    fit: input.fit,
  });

  const thumbnail = draft.staged.get('thumbnail');
  for (const file of [splat, collider, ...(thumbnail ? [thumbnail] : [])]) {
    await rename(join(draft.dir, `${file.storedAs}${PART_SUFFIX}`), join(draft.dir, file.storedAs));
  }

  await writeFile(
    join(draft.dir, 'scene.json'),
    `${JSON.stringify(sceneJson({ draft, name, description, alignment, splat, collider, thumbnail }), null, 2)}\n`,
    'utf8',
  );
  await rm(join(draft.dir, MARKER_FILE), { force: true });

  DRAFTS.delete(id);
  return { setId: draft.view.setId, alignment };
}

function sceneJson(input: {
  draft: Draft;
  name: string;
  description: string;
  alignment: Alignment;
  splat: StagedFile;
  collider: StagedFile;
  thumbnail: StagedFile | undefined;
}): Record<string, unknown> {
  const { draft, alignment } = input;
  const splatScan = draft.splatScan as SplatScan;
  const colliderScan = draft.colliderScan as ColliderInspection;

  return {
    source: 'user-upload',
    generator: 'app/api/uploads',
    generatedAt: new Date().toISOString(),
    provenance: {
      name: input.name,
      description: input.description,
      createdVia: 'web-upload',
      uploadedFiles: {
        splat: input.splat.originalName,
        collider: input.collider.originalName,
        thumbnail: input.thumbnail?.originalName ?? null,
      },
      orientation: alignment.orientation,
      fittedToCollider: alignment.fitted,
    },
    splatTransform: alignment.placement,
    /* Explicit, and identity unless someone edits it. An uploaded collider is
       the frame everything else is placed into — it is not turned or scaled,
       because there is nothing to check it against. lib/renders.ts reads this
       key rather than assuming the Marble convention. */
    colliderTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    /* Kept because it is the evidence for the transform above, and a capture
       whose alignment is questioned later has nowhere else to answer from. */
    measurements: {
      splatBounds: splatScan.bounds,
      splatRawBounds: splatScan.rawBounds,
      splatsSampled: splatScan.sampled,
      colliderBounds: colliderScan.bounds,
      colliderFloorBounds: colliderScan.floorBounds,
      colliderFloorSource: colliderScan.floorSource,
      splatExtentAfterFit: alignment.splatExtent,
      colliderExtent: alignment.colliderExtent,
      residual: alignment.residual,
      footprintError: alignment.footprintError,
    },
    files: {
      splat: {
        file: input.splat.storedAs,
        url: null,
        bytes: input.splat.bytes,
        sha256: input.splat.sha256,
        splats: splatScan.splatCount,
        format: splatScan.format,
      },
      collider: {
        file: input.collider.storedAs,
        url: null,
        bytes: input.collider.bytes,
        sha256: input.collider.sha256,
        meshes: colliderScan.meshes,
        triangles: colliderScan.triangles,
      },
    },
  };
}
