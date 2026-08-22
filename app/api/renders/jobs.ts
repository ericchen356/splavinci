/**
 * The create-a-render job: intake-composer -> environment-builder, run off the
 * back of an HTTP request instead of a terminal.
 *
 * WHY A JOB AND NOT A REQUEST
 * A Marble generation is minutes of polling followed by a download that can be
 * hundreds of megabytes. Holding a POST open for that loses the work to any
 * proxy timeout, any laptop lid, any refresh — and gives the browser nothing to
 * render but a spinner. So POST starts a job and returns its id, and the client
 * polls GET /api/jobs/<id> for phase, percent and the last thing that happened.
 *
 * WHY A MODULE-LEVEL MAP
 * This is a prototype registry, deliberately: one process, in memory, gone on
 * restart, and wrong the moment this runs on more than one instance. A real
 * deployment needs the job in a database (or the queue that owns the worker) so
 * that any instance can answer the poll. Nothing outside this file depends on
 * where the map lives, so that swap is local.
 *
 * WHY THE PIPELINE IS NOT REIMPLEMENTED HERE
 * `composeIntake` and `buildEnvironment` are the same two calls the CLI makes
 * (lib/marble/cli.ts), with the same options, writing the same room.spz +
 * collider.glb + scene.json under public/generated/<id>/. This file adds only
 * what a browser needs and a terminal does not: files that arrived as bytes
 * rather than paths, and progress that can be polled.
 *
 * SERVER ONLY. node:fs, node:os, and a live network client.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';

import {
  DEFAULT_MODEL,
  MarbleError,
  buildEnvironment,
  composeIntake,
  inspectGlb,
  isMarbleError,
  readProgress,
  type EnvironmentBuildOptions,
  type EnvironmentBuildResult,
  type EnvironmentInput,
  type MarbleOperation,
} from '@/lib/marble';

/* -------------------------------------------------------------------------- */
/* the seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stage 2, as a value rather than an import.
 *
 * `buildEnvironment` is the real thing: it uploads the photos, starts a paid
 * generation and downloads the result. Everything else in this file is written
 * against this signature so the paid call can be swapped for one that is not.
 */
export type EnvironmentBuilder = (
  input: EnvironmentInput,
  options: EnvironmentBuildOptions,
) => Promise<EnvironmentBuildResult>;

/**
 * ==========================================================================
 * THE ONLY PLACE A LIVE, BILLED MARBLE GENERATION IS STARTED.
 * ==========================================================================
 *
 * Below this function nothing knows whether it is talking to World Labs. Above
 * it, `buildEnvironment` is the real API client and every call costs the
 * account credits (https://platform.worldlabs.ai/billing).
 *
 * Two ways to get the mock instead:
 *
 *   MARBLE_MOCK=1                 in the server's environment — wins over
 *                                 everything, so a machine can be pinned to
 *                                 "never spend money" for a whole session.
 *   mock=1                        on the POST body — honoured only outside
 *                                 production, so the UI can offer it as a
 *                                 checkbox against a dev server that was
 *                                 started without the env var.
 *
 * The mock writes a real, openable capture (see `mockBuildEnvironment`), so the
 * whole flow — validation, progress, the list, /plan?capture=<id> — is
 * exercisable without a single request leaving the machine.
 */
function resolveBuilder(requestedMock: boolean): { build: EnvironmentBuilder; mock: boolean } {
  if (mockForcedByEnv() || (requestedMock && process.env.NODE_ENV !== 'production')) {
    return { build: mockBuildEnvironment, mock: true };
  }
  return { build: buildEnvironment, mock: false };
}

/** True when this server may not call Marble at all, whatever the request says. */
export function mockForcedByEnv(): boolean {
  const flag = process.env.MARBLE_MOCK?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/* -------------------------------------------------------------------------- */
/* public shapes                                                              */
/* -------------------------------------------------------------------------- */

export type JobPhase =
  | 'queued'
  | 'intake'
  | 'uploading'
  | 'generating'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'cancelled';

/** What a poll returns. Everything here is safe to show a user. */
export type JobView = {
  id: string;
  /** Capture id and folder name; also the `?capture=` value once it is done. */
  setId: string;
  name: string;
  phase: JobPhase;
  /** 0..1, monotonic. See `PHASE_FLOOR` for how honest each stretch is. */
  progress: number;
  /** One line describing what is happening right now. */
  message: string;
  /** Tail of the builder's own log, newest last. */
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  error: { message: string; hint: string | null; kind: string | null } | null;
  /** The finished capture's id, or null. Present only on `done`. */
  renderId: string | null;
  /** Whether this job used the mock builder rather than the paid API. */
  mock: boolean;
};

/** One uploaded file, already read off the multipart body. */
export type IncomingFile = {
  name: string;
  bytes: Uint8Array;
};

export type CreateRenderInput = {
  /** Display name. Empty means "derive one from the description". */
  name: string;
  /** The layout sentence composeIntake folds into the prompt. Required. */
  description: string;
  /** Materials, era, light, mood. Optional. */
  keywords: string;
  photos: IncomingFile[];
  blueprint: IncomingFile | null;
  /** Client asked for the mock builder. Ignored in production. */
  mock: boolean;
};

/* -------------------------------------------------------------------------- */
/* the registry                                                               */
/* -------------------------------------------------------------------------- */

type Job = {
  view: JobView;
  abort: AbortController;
  /** Where the uploaded bytes were staged, so a cancel can clean up. */
  scratchDir: string | null;
  /** Elapsed at the last generation poll, for the ramp in `generatingProgress`. */
  generationStartedAt: number | null;
};

/**
 * Pinned to globalThis, not just to the module.
 *
 * `next dev` re-evaluates a route's module graph on hot reload, and a plain
 * module-level Map would take every in-flight job with it — a generation that
 * is still running and still billing would simply become unpollable.
 */
const globalScope = globalThis as unknown as { __splavinciRenderJobs?: Map<string, Job> };
const JOBS: Map<string, Job> = (globalScope.__splavinciRenderJobs ??= new Map<string, Job>());

/** Finished jobs are kept only long enough for the client to see the result. */
const JOB_TTL_MS = 30 * 60_000;
const MAX_LOG_LINES = 200;

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    const finished = job.view.finishedAt ? Date.parse(job.view.finishedAt) : null;
    if (finished !== null && now - finished > JOB_TTL_MS) JOBS.delete(id);
  }
}

export function getJob(id: string): JobView | null {
  const job = JOBS.get(id);
  return job ? snapshot(job) : null;
}

/** Abort a running job. Returns null when there is no such job. */
export function cancelJob(id: string): JobView | null {
  const job = JOBS.get(id);
  if (!job) return null;
  if (!isTerminal(job.view.phase)) {
    job.abort.abort();
    // Recorded here rather than in the catch, so the phase is right the instant
    // the user clicks even though the builder unwinds a moment later.
    job.view.phase = 'cancelled';
    job.view.message = 'Cancelled.';
    job.view.finishedAt = new Date().toISOString();
  }
  return snapshot(job);
}

function isTerminal(phase: JobPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

function snapshot(job: Job): JobView {
  const started = Date.parse(job.view.startedAt);
  const end = job.view.finishedAt ? Date.parse(job.view.finishedAt) : Date.now();
  return { ...job.view, log: [...job.view.log], elapsedMs: Math.max(0, end - started) };
}

/* -------------------------------------------------------------------------- */
/* progress                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where each phase starts on the bar.
 *
 * Only the download stretch is measured — the client reports received bytes
 * against Content-Length. Generation has no number at all: Marble's operation
 * metadata carries a status string and a description, never a percentage
 * (see `readProgress`), so that stretch is an elapsed-time ramp and is labelled
 * with Marble's own words rather than pretending the figure means something.
 */
const PHASE_FLOOR: Record<JobPhase, number> = {
  queued: 0,
  intake: 0.02,
  uploading: 0.08,
  generating: 0.18,
  downloading: 0.78,
  done: 1,
  failed: 1,
  cancelled: 1,
};

const GENERATION_CEILING = 0.78;
/** Time constant of the generation ramp. Docs put a typical world at ~5 min. */
const GENERATION_TAU_MS = 240_000;

/** Each downloaded asset owns a slice of the bar, in the order build.ts fetches. */
const DOWNLOAD_SPANS: Record<string, [number, number]> = {
  'collider.glb': [0.78, 0.86],
  'room.spz': [0.86, 0.99],
};

function advance(job: Job, to: number): void {
  // Monotonic on purpose: a bar that goes backwards reads as a fault, and every
  // input here is an estimate that can disagree with the previous one.
  job.view.progress = Math.min(1, Math.max(job.view.progress, to));
}

function enter(job: Job, phase: JobPhase): void {
  if (isTerminal(job.view.phase)) return;
  job.view.phase = phase;
  advance(job, PHASE_FLOOR[phase]);
  if (phase === 'generating' && job.generationStartedAt === null) {
    job.generationStartedAt = Date.now();
  }
}

/** Matches the `  <file> <n>%` lines fetchVerified writes while downloading. */
const DOWNLOAD_LINE = /^\s+(\S+\.(?:spz|glb))\s+(\d{1,3})%$/;

/**
 * The builder's log, read as a progress channel.
 *
 * `log` is the only observability hook `buildEnvironment` exposes, and the
 * pipeline under lib/marble/ belongs to another workstream — so rather than add
 * structured events there, this reads the lines the CLI already prints. The
 * three patterns matched below are phase boundaries; everything else is kept
 * verbatim for the log tail and changes nothing.
 */
function onLogLine(job: Job, line: string): void {
  job.view.log.push(line);
  if (job.view.log.length > MAX_LOG_LINES) job.view.log.shift();

  const download = DOWNLOAD_LINE.exec(line);
  if (download) {
    const [, file, percent] = download;
    enter(job, 'downloading');
    const span = DOWNLOAD_SPANS[file];
    if (span) advance(job, span[0] + (span[1] - span[0]) * (Number(percent) / 100));
    job.view.message = `Downloading ${file} — ${percent}%`;
    return;
  }

  if (/^(uploading|inlining) /.test(line)) {
    enter(job, 'uploading');
    job.view.message = line;
    return;
  }
  if (/^starting .*generation/.test(line) || /^(resuming operation|fetching existing world)/.test(line)) {
    enter(job, 'generating');
    job.view.message = 'Marble is generating the world…';
    return;
  }
  if (/^writing to /.test(line)) {
    enter(job, 'downloading');
    job.view.message = 'Downloading assets…';
  }
}

/** Structured half of the generation phase: Marble's own status text. */
function onPoll(job: Job, op: MarbleOperation, elapsedMs: number): void {
  enter(job, 'generating');
  const detail = readProgress(op);
  if (detail) job.view.message = detail;
  const since = job.generationStartedAt === null ? elapsedMs : Date.now() - job.generationStartedAt;
  const ramp = 1 - Math.exp(-since / GENERATION_TAU_MS);
  advance(job, PHASE_FLOOR.generating + (GENERATION_CEILING - PHASE_FLOOR.generating) * ramp);
}

/* -------------------------------------------------------------------------- */
/* naming                                                                     */
/* -------------------------------------------------------------------------- */

const GENERATED_DIR = resolve(process.cwd(), 'public', 'generated');

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Strip anything that could climb out of the scratch directory. */
function safeFileName(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-64) || 'photo';
}

/**
 * A folder name that is stable, readable in a URL, and not already taken.
 *
 * The date suffix is not decoration: two renders of the same room from the same
 * name is the normal case, and silently writing the second one over the first
 * would destroy a capture someone had already opened.
 */
async function reserveSetId(name: string, description: string): Promise<string> {
  const base = slugify(name) || slugify(description.split(/[.,;]/)[0] ?? '') || 'render';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  let candidate = `${base}-${stamp}`;
  for (let n = 2; await exists(join(GENERATED_DIR, candidate)); n += 1) {
    candidate = `${base}-${stamp}-${n}`;
  }
  return candidate;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* start                                                                      */
/* -------------------------------------------------------------------------- */

export async function startRenderJob(input: CreateRenderInput): Promise<JobView> {
  sweep();

  const name = input.name.trim() || firstSentence(input.description) || 'Untitled render';
  const setId = await reserveSetId(name, input.description);
  const { build, mock } = resolveBuilder(input.mock);

  const job: Job = {
    abort: new AbortController(),
    scratchDir: null,
    generationStartedAt: null,
    view: {
      id: randomUUID(),
      setId,
      name,
      phase: 'queued',
      progress: 0,
      message: mock ? 'Queued (mock builder — nothing will be sent to Marble).' : 'Queued.',
      log: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      error: null,
      renderId: null,
      mock,
    },
  };
  JOBS.set(job.view.id, job);

  // Deliberately not awaited: the POST answers with the id while this runs on.
  // Nothing rejects out of `run`, so there is no unhandled rejection to catch.
  void run(job, input, build);

  return snapshot(job);
}

function firstSentence(text: string): string {
  const trimmed = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return trimmed.replace(/[.!?]+$/, '').slice(0, 64);
}

async function run(job: Job, input: CreateRenderInput, build: EnvironmentBuilder): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'splavinci-intake-'));
  job.scratchDir = scratch;

  try {
    enter(job, 'intake');
    job.view.message = 'Checking the photos and composing the prompt…';

    const photoPaths: string[] = [];
    for (const [index, photo] of input.photos.entries()) {
      const path = join(scratch, `${String(index + 1).padStart(2, '0')}-${safeFileName(photo.name)}`);
      await writeFile(path, photo.bytes);
      photoPaths.push(path);
    }

    /* composeIntake requires a blueprint path that exists — it never opens the
       file, but it refuses to invent a layout for one it cannot account for.
       When the user uploads no floor plan the layout genuinely did come from
       the sentence they typed, so that sentence is written to a file and named
       as the source. Provenance then says "layout.txt", which is true, rather
       than pointing at a photo that is not a plan. */
    const blueprintPath = join(scratch, input.blueprint ? safeFileName(input.blueprint.name) : 'layout.txt');
    await writeFile(
      blueprintPath,
      input.blueprint ? input.blueprint.bytes : `${input.description.trim()}\n`,
    );

    const intake = await composeIntake({
      blueprint: { path: blueprintPath, layoutDescription: input.description },
      photos: photoPaths,
      keywords: input.keywords,
    });
    onLogLine(job, `composed prompt: ${intake.composedPrompt}`);

    const result = await build(
      { composedPrompt: intake.composedPrompt, images: intake.images },
      {
        setId: job.view.setId,
        displayName: job.view.name,
        deepVerify: true,
        // Read straight back out by lib/renders.ts: `name` becomes the row's
        // title and `description` its blurb, so the list needs no second store.
        provenance: {
          name: job.view.name,
          description: input.description.trim(),
          layoutDescription: intake.layoutDescription,
          keywords: intake.keywords,
          blueprint: input.blueprint ? input.blueprint.name : null,
          blueprintSupplied: Boolean(input.blueprint),
          photos: input.photos.map((photo) => photo.name),
          createdVia: 'web-upload',
          ...(job.view.mock ? { mock: true } : {}),
        },
        log: (line) => onLogLine(job, line),
        wait: { onPoll: (op, elapsedMs) => onPoll(job, op, elapsedMs) },
        signal: job.abort.signal,
      },
    );

    await writeThumbnail(result.dir, input.photos[0]);

    job.view.phase = 'done';
    job.view.progress = 1;
    job.view.renderId = result.setId;
    job.view.message = job.view.mock
      ? 'Done (mock capture — the assets were copied, not generated).'
      : 'Done.';
    job.view.finishedAt = new Date().toISOString();
  } catch (error) {
    if (job.abort.signal.aborted) {
      job.view.phase = 'cancelled';
      job.view.message = 'Cancelled.';
      // A cancel can land mid-download; the capture folder is half-written and
      // must not survive to be listed as a render.
      await rm(join(GENERATED_DIR, job.view.setId), { recursive: true, force: true });
    } else {
      job.view.phase = 'failed';
      job.view.error = describeError(error);
      job.view.message = job.view.error.message;
    }
    job.view.finishedAt ??= new Date().toISOString();
  } finally {
    await rm(scratch, { recursive: true, force: true });
    job.scratchDir = null;
  }
}

function describeError(error: unknown): NonNullable<JobView['error']> {
  if (isMarbleError(error)) {
    return { message: error.message, hint: error.hint ?? null, kind: error.kind };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    hint: null,
    kind: null,
  };
}

/**
 * The first interior photo, as the capture's still.
 *
 * A copy rather than a resize: nothing in this project decodes an image, and a
 * generated capture with no picture on its row is far worse than one whose
 * picture is larger than it needs to be. lib/renders.ts looks for exactly these
 * names.
 */
async function writeThumbnail(dir: string, photo: IncomingFile | undefined): Promise<void> {
  if (!photo) return;
  const ext = extname(photo.name).slice(1).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return;
  try {
    await writeFile(join(dir, `thumbnail.${ext}`), photo.bytes);
  } catch {
    // A capture without a still is still a capture.
  }
}

/* -------------------------------------------------------------------------- */
/* the mock builder                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Everything `buildEnvironment` does except spend money.
 *
 * It stages through the same phases at roughly the same shape, emits the same
 * log lines and the same operation snapshots, and — crucially — leaves a real
 * capture on disk: room.spz, collider.glb and a scene.json in the exact format
 * lib/renders.ts parses, so the new render appears in the list and opens in
 * /plan like any other. The assets are copied from a capture that already
 * exists rather than synthesised, because a splat this code invented would load
 * as an empty room and prove nothing.
 *
 * The collider copy is run through the real `inspectGlb`, so a donor that is
 * broken fails here the same way a bad download would.
 */
async function mockBuildEnvironment(
  input: EnvironmentInput,
  options: EnvironmentBuildOptions,
): Promise<EnvironmentBuildResult> {
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const setId = options.setId ?? `mock-${Date.now()}`;
  /* `outDir` is honoured by the real builder for the CLI's benefit; the mock
     always writes where the app serves from, so the path stays a literal the
     bundler can trace (see findDonorCapture). */
  const dir = join(GENERATED_DIR, setId);

  log('MOCK BUILDER — no request will be sent to World Labs and nothing will be billed.');

  const donor = await findDonorCapture(setId);
  if (!donor) {
    throw new MarbleError({
      kind: 'input',
      message: 'The mock builder needs one existing capture to copy assets from.',
      hint:
        'It looks for a folder under public/generated/ containing room.spz, ' +
        'collider.glb and scene.json. Generate one for real, or unset MARBLE_MOCK.',
    });
  }

  for (const image of input.images) {
    const bytes = (await stat(image)).size;
    log(`uploading ${basename(image)} (${bytes} bytes)`);
    await pause(350, signal);
  }

  log(
    `starting multi-image generation with ${input.images.length} photo(s) on ` +
      `${options.model ?? DEFAULT_MODEL}`,
  );
  const operationId = `mock-op-${randomUUID().slice(0, 8)}`;
  log(`operation ${operationId}`);

  const startedAt = Date.now();
  for (const stage of MOCK_STAGES) {
    await pause(1_100, signal);
    const elapsed = Date.now() - startedAt;
    options.wait?.onPoll?.(mockOperation(operationId, stage), elapsed);
    log(`  ${Math.round(elapsed / 1000)}s  RUNNING - ${stage}`);
  }

  await mkdir(dir, { recursive: true });
  log(`writing to ${relative(process.cwd(), dir) || dir}`);

  const collider = await copyWithProgress(donor, dir, 'collider.glb', log, signal);
  const inspection = inspectGlb(await readFile(join(dir, 'collider.glb')));
  log(`  collider: ${inspection.meshCount} mesh(es), ${inspection.primitiveCount} primitive(s)`);

  const splat = await copyWithProgress(donor, dir, 'room.spz', log, signal);

  /* scene.json is written inline by lib/marble/build.ts, so there is no shared
     writer to call. Patching the donor's own file instead of hand-rolling a
     second copy of that shape means the mock cannot drift out of step with the
     format the real builder emits — whatever build.ts adds, the donor has. */
  const scene = JSON.parse(await readFile(join(donor, 'scene.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const donorFiles = (scene.files ?? {}) as Record<string, unknown>;
  const donorSplat = (donorFiles.splat ?? {}) as Record<string, unknown>;
  const donorCollider = (donorFiles.collider ?? {}) as Record<string, unknown>;
  const placement = readPlacement(scene.splatTransform);

  const scenePath = join(dir, 'scene.json');
  await writeFile(
    scenePath,
    `${JSON.stringify(
      {
        ...scene,
        source: 'mock',
        generator: 'app/api/renders/jobs.ts (mockBuildEnvironment)',
        generatedAt: new Date().toISOString(),
        mock: {
          note: 'No Marble generation happened. Geometry copied from another capture.',
          copiedFrom: basename(donor),
        },
        world: { id: `mock-world-${setId}`, marbleUrl: null, model: null, caption: null, operationId },
        prompt: input.composedPrompt,
        provenance: options.provenance ?? null,
        files: {
          ...donorFiles,
          splat: { ...donorSplat, file: 'room.spz', url: null, bytes: splat },
          collider: {
            ...donorCollider,
            file: 'collider.glb',
            url: null,
            bytes: collider,
            meshes: inspection.meshCount,
            primitives: inspection.primitiveCount,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    setId,
    dir,
    operationId,
    worldId: `mock-world-${setId}`,
    worldMarbleUrl: null,
    model: options.model ?? DEFAULT_MODEL,
    caption: null,
    splat: {
      file: 'room.spz',
      url: '',
      bytes: splat,
      sha256: '',
      spzKey: typeof donorSplat.spzKey === 'string' ? donorSplat.spzKey : '500k',
    },
    extraSplats: [],
    collider: { file: 'collider.glb', url: '', bytes: collider, sha256: '', inspection, loader: null },
    semantics: null,
    placement,
    scenePath,
  };
}

/** Status descriptions in the shape Marble's operation metadata carries them. */
const MOCK_STAGES = [
  'preparing inputs',
  'reconstructing geometry',
  'training gaussians',
  'baking collider mesh',
  'packaging assets',
] as const;

function mockOperation(operationId: string, description: string): MarbleOperation {
  return {
    operation_id: operationId,
    done: false,
    metadata: { progress: { status: 'RUNNING', description } },
  };
}

function readPlacement(value: unknown): EnvironmentBuildResult['placement'] {
  const record = (value ?? {}) as Record<string, unknown>;
  const vec = (v: unknown): [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')
      ? [v[0] as number, v[1] as number, v[2] as number]
      : [0, 0, 0];
  return {
    position: vec(record.position),
    rotation: vec(record.rotation),
    scale: typeof record.scale === 'number' ? record.scale : 1,
  };
}

/**
 * A finished capture to lift geometry from. Never the folder being written.
 *
 * Every path is rebuilt from the same `process.cwd()/public/generated` literal
 * rather than taken as a parameter. Turbopack resolves filesystem access
 * statically at build time, and a root it cannot see through makes it trace the
 * entire project into the server bundle — which on this repo means the splats
 * and colliders under public/, hundreds of megabytes of them.
 */
async function findDonorCapture(excludeId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await readdir(join(process.cwd(), 'public', 'generated'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== excludeId)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    const complete = await Promise.all(
      ['room.spz', 'collider.glb', 'scene.json'].map((file) =>
        exists(join(process.cwd(), 'public', 'generated', entry, file)),
      ),
    );
    if (complete.every(Boolean)) return join(process.cwd(), 'public', 'generated', entry);
  }
  return null;
}

/** Copy one asset, narrating it the way `fetchVerified` narrates a download. */
async function copyWithProgress(
  donor: string,
  dir: string,
  file: string,
  log: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<number> {
  await copyFile(join(donor, file), join(dir, file));
  const bytes = (await stat(join(dir, file))).size;
  for (const percent of [20, 50, 80, 100]) {
    await pause(220, signal);
    log(`  ${file} ${percent}%`);
  }
  log(`  ${file} ${bytes} bytes  sha256 mock`);
  return bytes;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePause, reject) => {
    if (signal?.aborted) {
      reject(new MarbleError({ kind: 'timeout', message: 'Aborted.' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePause();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MarbleError({ kind: 'timeout', message: 'Aborted.' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
