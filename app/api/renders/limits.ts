/**
 * What the upload form will accept, stated once.
 *
 * Both sides need these numbers: the browser, so a 90 MB photo is refused
 * beside the field instead of after a two-minute upload, and the route, because
 * a client-side check is a courtesy and never a control. Two copies of a limit
 * drift, and the direction they drift in is "the server rejects something the
 * form promised was fine", so there is exactly one copy and it lives here.
 *
 * Deliberately free of node: imports — this module is pulled into the client
 * bundle by the upload form. It imports only from lib/marble/api.ts, which is
 * the wire-format adapter and is itself pure.
 */

import { MAX_IMAGES_RECONSTRUCT, SUPPORTED_IMAGE_EXTENSIONS } from '@/lib/marble/api';

/** Marble's own ceiling in reconstruction mode. Exceeding it fails at their end. */
export const MAX_PHOTOS = MAX_IMAGES_RECONSTRUCT;

/**
 * ==========================================================================
 * THE IMAGE BUDGET, AND HOW A VIDEO SPLITS IT
 * ==========================================================================
 *
 * Photos and video frames spend the same allowance. Marble reconstructs from
 * ONE list of images and MAX_IMAGES_RECONSTRUCT is all of it, so a clip cannot
 * simply be added on top of a full set of photos — something has to give, and
 * the only question is which half.
 *
 * Half each. Frames are the stronger evidence: one continuous walk through one
 * real room is precisely the case reconstruction mode exists for, where a set
 * of stills is usually several different rooms asserted to be one. But someone
 * who attached photos as well meant them, and silently dropping a file the
 * form accepted is worse than fitting fewer frames. Four frames is the floor at
 * which a sweep still reads as a sweep rather than as four more stills — so the
 * video keeps four and the photos may take the other four.
 */
export const MAX_PHOTOS_WITH_VIDEO = 4;

/** Frames to ask the extractor for, given the photos sharing the budget. */
export function framesToExtract(photoCount: number): number {
  return Math.max(0, MAX_IMAGES_RECONSTRUCT - photoCount);
}

export const ACCEPTED_EXTENSIONS = SUPPORTED_IMAGE_EXTENSIONS;
/** For the file input's `accept`, which matches on MIME type, not extension. */
export const ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/webp';

/**
 * What AVFoundation will open without anything installed on the machine.
 *
 * scripts/video-frames.swift is the extractor and it is AVFoundation, so the
 * accepted list is that framework's native container set rather than a wish
 * list. Nothing here transcodes, so an mkv or a webm has to be converted first.
 */
export const ACCEPTED_VIDEO_EXTENSIONS = ['mov', 'mp4', 'm4v'] as const;
export const VIDEO_ACCEPT_ATTRIBUTE = 'video/quicktime,video/mp4,video/x-m4v';

/** Per file. Above this a photo is almost certainly a raw camera dump. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Across the whole request, so eight large photos cannot become a 200 MB POST. */
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

/**
 * Per video, and counted separately from MAX_TOTAL_BYTES.
 *
 * A 50 s 4K clip off a phone lands around 70 MB, so this is roughly three of
 * those. The ceiling is ours rather than Marble's — the route buffers the file
 * into memory before writing it to the scratch dir, and a gigabyte of that in
 * one request is how a dev server dies.
 */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Long enough to describe a layout; short enough not to be an essay. */
export const MIN_DESCRIPTION_CHARS = 12;
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_KEYWORDS_CHARS = 300;
export const MAX_NAME_CHARS = 64;

/** A validation failure, addressed to the field that caused it. */
export type FieldError = {
  field: 'photos' | 'video' | 'blueprint' | 'description' | 'keywords' | 'name';
  message: string;
};

/** Just the parts of a File both sides can see. Keeps this module DOM-free. */
export type CandidateFile = { name: string; size: number };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isAcceptedImage(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function isAcceptedVideo(name: string): boolean {
  return (ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Every problem with a submission, not just the first.
 *
 * Returning the whole list lets the form mark each offending field at once;
 * stopping at the first turns fixing three mistakes into three round trips.
 */
export function validateUpload(input: {
  photos: readonly CandidateFile[];
  video: CandidateFile | null;
  blueprint: CandidateFile | null;
  description: string;
  keywords: string;
  name: string;
}): FieldError[] {
  const errors: FieldError[] = [];
  const { photos, video, blueprint } = input;

  /* Photos OR a video, not one of each: a walkthrough is a complete account of
     a room on its own, and so is a set of stills of it. */
  if (photos.length === 0 && !video) {
    errors.push({ field: 'photos', message: 'Add interior photos, a walkthrough video, or both.' });
  }

  const photoCap = video ? MAX_PHOTOS_WITH_VIDEO : MAX_PHOTOS;
  if (photos.length > photoCap) {
    errors.push({
      field: 'photos',
      message: video
        ? `With a video, at most ${MAX_PHOTOS_WITH_VIDEO} photos — the rest of Marble's ` +
          `${MAX_IMAGES_RECONSTRUCT}-image budget goes to frames from the clip. ${photos.length} were added.`
        : `Marble accepts at most ${MAX_PHOTOS} photos; ${photos.length} were added.`,
    });
  }

  for (const file of [...photos, ...(blueprint ? [blueprint] : [])]) {
    const field = blueprint && file === blueprint ? 'blueprint' : 'photos';
    if (!isAcceptedImage(file.name)) {
      errors.push({
        field,
        message: `${file.name} is not a ${ACCEPTED_EXTENSIONS.join('/')} image. Convert it first.`,
      });
    } else if (file.size === 0) {
      errors.push({ field, message: `${file.name} is empty.` });
    } else if (file.size > MAX_FILE_BYTES) {
      errors.push({
        field,
        message: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}.`,
      });
    }
  }

  if (video) {
    if (!isAcceptedVideo(video.name)) {
      errors.push({
        field: 'video',
        message: `${video.name} is not a ${ACCEPTED_VIDEO_EXTENSIONS.join('/')} video. Convert it first.`,
      });
    } else if (video.size === 0) {
      errors.push({ field: 'video', message: `${video.name} is empty.` });
    } else if (video.size > MAX_VIDEO_BYTES) {
      errors.push({
        field: 'video',
        message: `${video.name} is ${formatBytes(video.size)}; the limit is ${formatBytes(MAX_VIDEO_BYTES)}.`,
      });
    }
  }

  const total = [...photos, ...(blueprint ? [blueprint] : [])].reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    errors.push({
      field: 'photos',
      message: `${formatBytes(total)} of images in one upload; the limit is ${formatBytes(MAX_TOTAL_BYTES)}.`,
    });
  }

  /* Optional, but not "optional-ish": three words is worse than nothing,
     because it lands in the prompt as an assertion about the layout. */
  const description = input.description.trim();
  if (description.length > 0 && description.length < MIN_DESCRIPTION_CHARS) {
    errors.push({
      field: 'description',
      message:
        'Describe the layout in a sentence — room count and what leads to what — or leave it empty.',
    });
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push({
      field: 'description',
      message: `${description.length} characters; keep it under ${MAX_DESCRIPTION_CHARS}.`,
    });
  }

  if (input.keywords.trim().length > MAX_KEYWORDS_CHARS) {
    errors.push({
      field: 'keywords',
      message: `Keep keywords under ${MAX_KEYWORDS_CHARS} characters.`,
    });
  }
  if (input.name.trim().length > MAX_NAME_CHARS) {
    errors.push({ field: 'name', message: `Keep the name under ${MAX_NAME_CHARS} characters.` });
  }

  return errors;
}
