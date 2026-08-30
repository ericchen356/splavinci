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
 * rather than paths, a video turned into frames, and progress that can be
 * polled.
 *
 * EVERY JOB SPENDS MONEY. `buildEnvironment` is the live World Labs client and
 * there is no builder behind it that is not — a submission that reaches this
 * file starts a billed generation (https://platform.worldlabs.ai/billing). The
 * cancel path exists because of that, not in spite of it.
 *
 * SERVER ONLY. node:fs, node:os, a child process, and a live network client.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

import {
  MarbleError,
  buildEnvironment,
  composeIntake,
  isMarbleError,
  readProgress,
  type MarbleOperation,
} from '@/lib/marble';
import { GENERATED_DIR, reserveSetId, safeFileName } from './folders';
import { framesToExtract } from './limits';

/* -------------------------------------------------------------------------- */
/* public shapes                                                              */
/* -------------------------------------------------------------------------- */

export type JobPhase =
  | 'queued'
  | 'intake'
  /** Pulling stills out of an uploaded walkthrough. Tens of seconds, not zero. */
  | 'extracting'
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
};

/** One uploaded file, already read off the multipart body. */
export type IncomingFile = {
  name: string;
  bytes: Uint8Array;
};

export type CreateRenderInput = {
  /** Display name. Empty means "derive one from the description". */
  name: string;
  /** The layout sentence composeIntake folds into the prompt. Optional. */
  description: string;
  /** Materials, era, light, mood. Optional. */
  keywords: string;
  photos: IncomingFile[];
  /** A walkthrough clip. Frames from it join `photos` as views of one space. */
  video: IncomingFile | null;
  blueprint: IncomingFile | null;
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
  extracting: 0.04,
  uploading: 0.1,
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
/* start                                                                      */
/* -------------------------------------------------------------------------- */

export async function startRenderJob(input: CreateRenderInput): Promise<JobView> {
  sweep();

  const name = input.name.trim() || firstSentence(input.description) || 'Untitled render';
  const setId = await reserveSetId(name, input.description);

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
      message: 'Queued.',
      log: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      error: null,
      renderId: null,
    },
  };
  JOBS.set(job.view.id, job);

  // Deliberately not awaited: the POST answers with the id while this runs on.
  // Nothing rejects out of `run`, so there is no unhandled rejection to catch.
  void run(job, input);

  return snapshot(job);
}

function firstSentence(text: string): string {
  const trimmed = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return trimmed.replace(/[.!?]+$/, '').slice(0, 64);
}

async function run(job: Job, input: CreateRenderInput): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'splavinci-intake-'));
  job.scratchDir = scratch;

  try {
    enter(job, 'intake');
    job.view.message = 'Reading the upload…';

    const photoPaths: string[] = [];
    for (const [index, photo] of input.photos.entries()) {
      const path = join(scratch, `${String(index + 1).padStart(2, '0')}-${safeFileName(photo.name, 'photo')}`);
      await writeFile(path, photo.bytes);
      photoPaths.push(path);
    }

    const framePaths = input.video
      ? await videoFrames(job, scratch, input.video, photoPaths.length)
      : [];
    const images = [...photoPaths, ...framePaths];

    /* WHY THE VIDEO RUN SWITCHES photoRole.
       Intake defaults to 'inspiration' — one anchor photo sent, the rest turned
       into adjectives — because a set of stock interiors is usually several
       different rooms being asserted to be one, and Marble reconciles that
       contradiction by collaging them. Frames of a single continuous walk are
       the opposite case: they really are views of one space, which is what
       multi-image reconstruction is for. That only holds if the whole sweep is
       sent, so a run with frames in it goes as 'views' and a photos-only run
       keeps the cautious default. */
    job.view.message = 'Composing the prompt…';
    const intake = await composeIntake(
      {
        blueprint: {
          path: await writeLayoutSource(scratch, input),
          layoutDescription: layoutSentence(input),
        },
        photos: images,
        keywords: input.keywords,
      },
      framePaths.length > 0 ? { photoRole: 'views' } : {},
    );
    onLogLine(job, `composed prompt: ${intake.composedPrompt}`);

    const result = await buildEnvironment(
      { composedPrompt: intake.composedPrompt, images: intake.images },
      {
        setId: job.view.setId,
        displayName: job.view.name,
        deepVerify: true,
        /* Stated rather than inferred. buildWorldPrompt turns reconstruction on
           by itself above 4 images, so a 3-photo-plus-5-frame set would get it
           and a 4-frame set would not — and the reason to reconstruct here is
           what the images ARE, not how many of them there are. */
        ...(framePaths.length > 0 ? { reconstructImages: true } : {}),
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
          video: input.video ? input.video.name : null,
          videoFrames: framePaths.length,
          createdVia: 'web-upload',
        },
        log: (line) => onLogLine(job, line),
        wait: { onPoll: (op, elapsedMs) => onPoll(job, op, elapsedMs) },
        signal: job.abort.signal,
      },
    );

    await writeThumbnail(result.dir, await stillFor(input, framePaths));

    job.view.phase = 'done';
    job.view.progress = 1;
    job.view.renderId = result.setId;
    job.view.message = 'Done.';
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

/* -------------------------------------------------------------------------- */
/* the layout sentence                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the prompt says the layout is.
 *
 * The field is optional on the form and `composeIntake` will not proceed
 * without a sentence — deliberately, since it refuses to invent a reading of a
 * plan it cannot see. So an empty field is answered with where the layout
 * genuinely came from rather than with a guess at rooms. It is a weaker prompt
 * than a typed sentence, and it is meant to be: in that case the views are
 * carrying the geometry and the text should not contradict them.
 */
function layoutSentence(input: CreateRenderInput): string {
  const typed = input.description.trim();
  if (typed) return typed;
  return input.video
    ? 'the one continuous interior walked through in these frames, in the order they were taken'
    : 'the one continuous interior shown in these photographs';
}

/**
 * A blueprint path `composeIntake` can stat.
 *
 * It requires one that exists — it never opens the file, but it refuses to
 * account for a plan it cannot find. With no floor plan uploaded the layout
 * really did come from the sentence, so the sentence is written to a file and
 * named as the source: provenance then says "layout.txt", which is true, rather
 * than pointing at a photo that is not a plan.
 */
async function writeLayoutSource(scratch: string, input: CreateRenderInput): Promise<string> {
  const path = join(scratch, input.blueprint ? safeFileName(input.blueprint.name) : 'layout.txt');
  await writeFile(path, input.blueprint ? input.blueprint.bytes : `${layoutSentence(input)}\n`);
  return path;
}

/* -------------------------------------------------------------------------- */
/* the still                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The capture's still.
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

/** The first photo, or a frame off the clip when the capture is video-only. */
async function stillFor(
  input: CreateRenderInput,
  framePaths: string[],
): Promise<IncomingFile | undefined> {
  if (input.photos[0]) return input.photos[0];
  const frame = framePaths[0];
  if (!frame) return undefined;
  try {
    return { name: basename(frame), bytes: await readFile(frame) };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* video frames                                                               */
/* -------------------------------------------------------------------------- */

/** A swift compile plus one exact seek per frame, on a long 4K clip. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

/** What the extractor prints per frame, and what it names the file. */
const FRAME_LINE = /^frame-\d+\.jpg\s/;
const FRAME_FILE = /^frame-\d+\.jpg$/;

/**
 * Stage 0 for a walkthrough: a clip in, JPEGs on disk out.
 *
 * The clip itself never reaches World Labs. A video media asset validates as an
 * `image_prompt` and then fails the generation with a 500, so there is no video
 * world-prompt to send; what there is, is multi-image reconstruction, and
 * evenly spaced frames of one real walk are the input it was built for.
 *
 * How many frames: whatever is left of Marble's eight after the photos the user
 * also attached (see `framesToExtract`, and MAX_PHOTOS_WITH_VIDEO for why the
 * form guarantees at least four remain).
 */
async function videoFrames(
  job: Job,
  scratch: string,
  video: IncomingFile,
  photoCount: number,
): Promise<string[]> {
  enter(job, 'extracting');
  const wanted = framesToExtract(photoCount);
  job.view.message = `Extracting ${wanted} frames from the video…`;

  const videoPath = join(scratch, safeFileName(video.name, 'walkthrough.mov'));
  await writeFile(videoPath, video.bytes);

  const outDir = join(scratch, 'frames');
  await mkdir(outDir, { recursive: true });

  onLogLine(job, `extracting ${wanted} frames from ${basename(videoPath)}`);
  await runExtractor(job, videoPath, outDir, wanted);

  const written = (await readdir(outDir))
    .filter((entry) => FRAME_FILE.test(entry))
    .sort()
    .map((entry) => join(outDir, entry));

  /* The one outcome that must not be allowed to pass quietly. An extractor that
     wrote nothing but exited 0 would otherwise leave a photo-only generation
     that costs the same money and answers a question nobody asked. */
  if (written.length === 0) {
    throw new MarbleError({
      kind: 'input',
      message: `No frames could be read from ${video.name}.`,
      hint:
        'The container opened but every seek failed, so the clip is probably ' +
        'truncated or carries no video track. Re-export it as an MP4, or upload ' +
        'photos instead.',
    });
  }

  onLogLine(job, `extracted ${written.length} frame(s)`);
  return written;
}

/**
 * `swift scripts/video-frames.swift`, as a child process.
 *
 * AVFoundation rather than a decoder in this process, because it is already on
 * every Mac and a phone video should not need ffmpeg installed first. The price
 * is a child process, and every way one can fail — no toolchain, an unreadable
 * container, a seek that throws, a hang — is turned into a MarbleError here so
 * that it surfaces on the job the same way a rejected upload does.
 */
function runExtractor(job: Job, video: string, outDir: string, count: number): Promise<void> {
  const script = resolve(process.cwd(), 'scripts', 'video-frames.swift');

  return new Promise((settle, reject) => {
    const child = spawn('swift', [script, video, outDir, String(count)], {
      signal: job.abort.signal,
      timeout: EXTRACT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let pending = '';
    let stderr = '';
    let done = 0;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // One line per completed seek is the only progress a one-shot child
      // process gives us, so the bar is driven off the lines as they arrive
      // rather than off the exit code.
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!FRAME_LINE.test(line)) continue;
        done += 1;
        onLogLine(job, `  ${line.trim()}`);
        job.view.message = `Extracting frames from the video — ${done} of ${count}`;
        advance(
          job,
          PHASE_FLOOR.extracting +
            (PHASE_FLOOR.uploading - PHASE_FLOOR.extracting) * (done / count),
        );
      }
    });

    child.stderr.setEncoding('utf8');
    /* Tail only. `swift <file>` compiles before it runs and prints a deprecation
       block for the AVFoundation calls every single time — on a success too —
       so the buffer is mostly noise, and the sentence that explains a failure is
       whatever the script printed last. */
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });

    child.on('error', (cause: NodeJS.ErrnoException) => {
      if (job.abort.signal.aborted) {
        reject(cause);
        return;
      }
      reject(
        cause.code === 'ENOENT'
          ? new MarbleError({
              kind: 'input',
              message: 'Frame extraction needs Swift, and `swift` is not on this machine.',
              hint:
                'Install the Xcode command line tools with `xcode-select --install`, ' +
                'or upload photos instead of a video.',
              cause,
            })
          : new MarbleError({
              kind: 'input',
              message: `Frame extraction could not start: ${cause.message}`,
              cause,
            }),
      );
    });

    child.on('close', (code, signal) => {
      if (job.abort.signal.aborted) {
        reject(new MarbleError({ kind: 'timeout', message: 'Aborted.' }));
        return;
      }
      if (code === 0) {
        settle();
        return;
      }
      reject(
        new MarbleError({
          kind: 'input',
          message: signal
            ? `Frame extraction was stopped after ${Math.round(EXTRACT_TIMEOUT_MS / 1000)}s (${signal}).`
            : `Frame extraction failed reading ${basename(video)} (exit ${code}).`,
          hint: lastLines(stderr, 3) || 'The extractor printed nothing to explain it.',
        }),
      );
    });
  });
}

/** The end of a stderr buffer, which is where the reason for an exit lands. */
function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
}
