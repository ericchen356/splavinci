/**
 * Turn a phone walkthrough into the photo list Marble's reconstruction mode
 * wants.
 *
 * Marble has no working video path — a video media asset passes validation as
 * an `image_prompt` and then fails the generation with a server 500. What does
 * work is `multi-image` with `reconstruct_images: true`, and that mode wants
 * exactly what a walkthrough is: several genuine views of ONE real space. A
 * stock-photo set can never satisfy that (see IntakeOptions.photoRole); a video
 * of a room satisfies it by construction.
 *
 * The extraction itself is scripts/video-frames.swift — AVFoundation, so a
 * stock Mac needs nothing installed. This module is the seam that makes that
 * script part of the pipeline instead of a thing you run by hand first.
 *
 * Everything here fails loudly. A missing `swift`, an unreadable video or a
 * short frame set must NOT degrade into "render the scene from fewer/no
 * frames": the frames ARE the geometry for a video scene, so a partial
 * extraction is a different scene, not a slightly worse one.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MarbleError } from '@/lib/marble/errors';

const SWIFT_SCRIPT = resolve(import.meta.dirname, '..', 'video-frames.swift');

/** `frame-01.jpg` … as written by video-frames.swift. */
const FRAME_RE = /^frame-\d+\.jpg$/;

export type ExtractFramesInput = {
  /** Absolute path to the source video. */
  videoPath: string;
  /** Absolute path to the directory the frames are written into. */
  outDir: string;
  /** How many evenly spaced frames to pull. */
  count: number;
  log?: (line: string) => void;
};

function fail(message: string, hint?: string, cause?: unknown): never {
  throw new MarbleError({
    kind: 'input',
    message,
    ...(hint ? { hint } : {}),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Extract `count` evenly spaced frames and return their absolute paths, in
 * order. The output directory is cleared of previous `frame-*.jpg` first, so a
 * run at a lower count cannot leave a stale frame behind to be picked up as if
 * it belonged to this extraction.
 */
export async function extractVideoFrames(input: ExtractFramesInput): Promise<string[]> {
  const { videoPath, outDir, count } = input;
  const log = input.log ?? (() => {});

  if (!Number.isInteger(count) || count < 1) {
    fail(`Frame count must be a positive integer, got ${count}.`);
  }

  let info;
  try {
    info = statSync(videoPath);
  } catch (cause) {
    fail(
      `Video not found or not readable: ${videoPath}`,
      'A video scene resolves its "video.path" against the scene folder, the same way photos resolve.',
      cause,
    );
  }
  if (!info.isFile()) fail(`Video is not a file: ${videoPath}`);
  if (info.size === 0) fail(`Video is empty (0 bytes): ${videoPath}`);

  await mkdir(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (FRAME_RE.test(name)) rmSync(resolve(outDir, name));
  }

  log(`frames   extracting ${count} from ${videoPath}`);

  const run = spawnSync('swift', [SWIFT_SCRIPT, videoPath, outDir, String(count)], {
    encoding: 'utf8',
  });

  if (run.error) {
    const missing = (run.error as NodeJS.ErrnoException).code === 'ENOENT';
    fail(
      missing
        ? 'Cannot run `swift`, which is what extracts the frames from the video.'
        : `Failed to run \`swift ${SWIFT_SCRIPT}\`: ${run.error.message}`,
      missing
        ? 'Install the Xcode command line tools (`xcode-select --install`). Frame extraction uses ' +
          'AVFoundation precisely so nothing else has to be installed — but it is macOS-only.'
        : undefined,
      run.error,
    );
  }

  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || '').trim();
    fail(
      `Frame extraction failed (swift exited ${run.status ?? 'on a signal'}).` +
        (detail ? `\n${detail}` : ''),
      'Check that the file is a video macOS can decode — the same check as opening it in QuickTime.',
    );
  }

  const frames = readdirSync(outDir)
    .filter((name) => FRAME_RE.test(name))
    .sort()
    .map((name) => resolve(outDir, name))
    .filter((path) => statSync(path).size > 0);

  if (frames.length === 0) {
    const detail = (run.stdout || run.stderr || '').trim();
    fail(
      `Frame extraction produced no frames from ${videoPath}.` + (detail ? `\n${detail}` : ''),
      'The video decoded but no still could be written. Nothing is rendered from a video scene ' +
        'without its frames — the frames are the geometry, so this is not something to render past.',
    );
  }

  if (frames.length < count) {
    fail(
      `Frame extraction produced ${frames.length} of ${count} requested frames.`,
      'A video scene is defined by exactly the frames it names, so a short set is treated as a ' +
        'failure rather than rendered as a different scene. Lower "video.frames" (or --frames) to ' +
        `${frames.length} if that is what you want, and the run becomes reproducible again.`,
    );
  }

  log(`frames   ${frames.length} written to ${outDir}`);
  return frames;
}
