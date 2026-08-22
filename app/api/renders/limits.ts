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
export const MIN_PHOTOS = 1;

export const ACCEPTED_EXTENSIONS = SUPPORTED_IMAGE_EXTENSIONS;
/** For the file input's `accept`, which matches on MIME type, not extension. */
export const ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/webp';

/** Per file. Above this a photo is almost certainly a raw camera dump. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Across the whole request, so eight large photos cannot become a 200 MB POST. */
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

/** Long enough to describe a layout; short enough not to be an essay. */
export const MIN_DESCRIPTION_CHARS = 12;
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_KEYWORDS_CHARS = 300;
export const MAX_NAME_CHARS = 64;

/** A validation failure, addressed to the field that caused it. */
export type FieldError = { field: 'photos' | 'blueprint' | 'description' | 'keywords' | 'name'; message: string };

/** Just the parts of a File both sides can see. Keeps this module DOM-free. */
export type CandidateFile = { name: string; size: number };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isAcceptedImage(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
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
  blueprint: CandidateFile | null;
  description: string;
  keywords: string;
  name: string;
}): FieldError[] {
  const errors: FieldError[] = [];
  const { photos, blueprint } = input;

  if (photos.length < MIN_PHOTOS) {
    errors.push({ field: 'photos', message: 'Add at least one interior photo.' });
  }
  if (photos.length > MAX_PHOTOS) {
    errors.push({
      field: 'photos',
      message: `Marble accepts at most ${MAX_PHOTOS} photos; ${photos.length} were added.`,
    });
  }

  for (const file of [...photos, ...(blueprint ? [blueprint] : [])]) {
    const field = blueprint && file === blueprint ? 'blueprint' : 'photos';
    if (!isAcceptedImage(file.name)) {
      errors.push({
        field,
        message: `${file.name} is not a ${ACCEPTED_EXTENSIONS.join('/')} image. Nothing here re-encodes a file, so convert it first.`,
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

  const total = [...photos, ...(blueprint ? [blueprint] : [])].reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    errors.push({
      field: 'photos',
      message: `${formatBytes(total)} of images in one upload; the limit is ${formatBytes(MAX_TOTAL_BYTES)}.`,
    });
  }

  const description = input.description.trim();
  if (description.length < MIN_DESCRIPTION_CHARS) {
    errors.push({
      field: 'description',
      message:
        'Describe the layout in a sentence — room count and what leads to what. ' +
        'It is the only thing that tells Marble the shape of the house.',
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
