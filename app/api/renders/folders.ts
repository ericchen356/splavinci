/**
 * Where a capture lives on disk, and what it may be called.
 *
 * Shared by the two ways a folder under public/generated/ comes into existence
 * — a Marble build (./jobs.ts) and a direct upload (../uploads/drafts.ts) —
 * because they have to agree. Both write into the same directory that
 * lib/renders.ts scans, both take a name from a user, and both must never
 * silently write over a capture someone has already opened.
 *
 * SERVER ONLY: node:fs and node:path.
 */

import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const GENERATED_DIR = resolve(process.cwd(), 'public', 'generated');

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Strip anything that could climb out of the directory it is written into. */
export function safeFileName(name: string, fallback = 'file'): string {
  return basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-64) || fallback;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A folder name that is stable, readable in a URL, and not already taken.
 *
 * The date suffix is not decoration: two captures of the same room under the
 * same name is the normal case, and silently writing the second one over the
 * first would destroy a capture someone had already opened.
 */
export async function reserveSetId(name: string, fallbackText = ''): Promise<string> {
  const base = slugify(name) || slugify(fallbackText.split(/[.,;]/)[0] ?? '') || 'render';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  let candidate = `${base}-${stamp}`;
  for (let n = 2; await exists(join(GENERATED_DIR, candidate)); n += 1) {
    candidate = `${base}-${stamp}-${n}`;
  }
  return candidate;
}
