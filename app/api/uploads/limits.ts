/**
 * What the "upload an existing capture" form will accept, stated once.
 *
 * Same contract as app/api/renders/limits.ts and for the same reason: the
 * browser needs these numbers so a wrong file is refused beside the field
 * rather than after a 200 MB upload, and the route needs them because a
 * client-side check is a courtesy and never a control.
 *
 * Deliberately free of node: imports and of anything DOM — this module is
 * pulled into the client bundle by the upload form AND imported by the route
 * handler that stages the bytes.
 */

import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, extensionOf, formatBytes } from '../renders/limits';

export { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, extensionOf, formatBytes };

/* -------------------------------------------------------------------------- */
/* what a capture is made of                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three files a capture can arrive as. The first two are required: a splat
 * with no collider cannot be planned in — the path generator rasterises its
 * walk grid straight out of collider triangles, and with none it produces a
 * grid with no walls in it rather than an error.
 */
export type UploadSlot = 'splat' | 'collider' | 'thumbnail';

export const UPLOAD_SLOTS: readonly UploadSlot[] = ['splat', 'collider', 'thumbnail'] as const;

export function isUploadSlot(value: string): value is UploadSlot {
  return (UPLOAD_SLOTS as readonly string[]).includes(value);
}

/**
 * Splat containers this app can actually render.
 *
 * Spark opens more than these, but lib/scene/assetTypes.ts models the source as
 * `'spz' | 'ply'` and lib/scene/loaders.ts resolves a URL to one of those two.
 * Accepting a .splat here would put a file in the library that every screen
 * downstream describes wrongly, so the list is the app's list rather than the
 * renderer's.
 */
export const SPLAT_EXTENSIONS = ['spz', 'ply'] as const;
/** The picker filters on MIME type and neither of these has a registered one. */
export const SPLAT_ACCEPT_ATTRIBUTE = '.spz,.ply';

/**
 * GLB only, not .gltf.
 *
 * A .gltf is a JSON manifest that points at sibling .bin and texture files by
 * relative path. Uploading one alone gives GLTFLoader a document whose buffers
 * resolve to 404s, and the failure lands on the plan screen rather than here.
 * GLB carries its geometry in the same file, which is the whole reason the
 * pipeline uses it.
 */
export const COLLIDER_EXTENSIONS = ['glb'] as const;
export const COLLIDER_ACCEPT_ATTRIBUTE = '.glb,model/gltf-binary';

export const THUMBNAIL_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export const THUMBNAIL_ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/webp';

/**
 * Per-file ceilings.
 *
 * Generous, because the bytes are streamed to disk rather than buffered: the
 * densest capture that ships with this repo is a 122 MB splat, and a capture
 * someone brings from elsewhere has no reason to be smaller. The collider is
 * capped much lower because it IS read into memory — `scanCollider` parses it
 * with GLTFLoader, which is the only way to know it holds real triangles.
 */
export const MAX_SPLAT_BYTES = 640 * 1024 * 1024;
export const MAX_COLLIDER_BYTES = 96 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

export function maxBytesFor(slot: UploadSlot): number {
  if (slot === 'splat') return MAX_SPLAT_BYTES;
  if (slot === 'collider') return MAX_COLLIDER_BYTES;
  return MAX_THUMBNAIL_BYTES;
}

export function extensionsFor(slot: UploadSlot): readonly string[] {
  if (slot === 'splat') return SPLAT_EXTENSIONS;
  if (slot === 'collider') return COLLIDER_EXTENSIONS;
  return THUMBNAIL_EXTENSIONS;
}

/* -------------------------------------------------------------------------- */
/* orientation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which way up the file was authored.
 *
 * This app's world is right-handed Y-up with the floor near y = 0, and nothing
 * in the pipeline can infer that from the bytes: the walk grid shoots rays
 * straight down, the mini-map projects onto XZ, and a capture that disagrees
 * produces a room that is silently inside out rather than one that fails.
 *
 * Three answers cover everything that turns up in practice:
 *   as-authored  already Y-up. Blender/glTF exports, anything authored for a
 *                game engine, and this repo's own fixture.
 *   y-down       the 3DGS convention. COLMAP-trained captures, Marble exports,
 *                Nerfstudio, Postshot — a 180-degree turn about X.
 *   z-up         CAD and Blender-without-conversion. A quarter turn about X.
 */
export type CaptureOrientation = 'as-authored' | 'y-down' | 'z-up';

export const CAPTURE_ORIENTATIONS: readonly CaptureOrientation[] = [
  'as-authored',
  'y-down',
  'z-up',
] as const;

export const ORIENTATION_LABEL: Record<CaptureOrientation, string> = {
  'as-authored': 'Y-up, as authored',
  'y-down': 'Y-down capture',
  'z-up': 'Z-up',
};

export const ORIENTATION_HINT: Record<CaptureOrientation, string> = {
  'as-authored': 'Already in a Y-up world with the floor at the bottom.',
  'y-down': 'The 3DGS default — COLMAP, Marble, Nerfstudio, Postshot.',
  'z-up': 'CAD, or Blender exported without axis conversion.',
};

export function isCaptureOrientation(value: unknown): value is CaptureOrientation {
  return typeof value === 'string' && (CAPTURE_ORIENTATIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* validation                                                                 */
/* -------------------------------------------------------------------------- */

export type UploadField = UploadSlot | 'name' | 'description';

export type UploadFieldError = {
  field: UploadField;
  message: string;
};

/** Just the parts of a File both sides can see. Keeps this module DOM-free. */
export type CandidateFile = { name: string; size: number };

export function isAcceptedFor(slot: UploadSlot, name: string): boolean {
  return extensionsFor(slot).includes(extensionOf(name));
}

/** The splat container this filename declares, or null when it declares none. */
export function splatKindOf(name: string): 'spz' | 'ply' | null {
  const ext = extensionOf(name);
  return ext === 'spz' || ext === 'ply' ? ext : null;
}

/** One file's problems, in the order a reader would notice them. */
export function validateSlotFile(slot: UploadSlot, file: CandidateFile): UploadFieldError | null {
  if (!isAcceptedFor(slot, file.name)) {
    const accepted = extensionsFor(slot).join('/');
    return {
      field: slot,
      message:
        slot === 'collider'
          ? `${file.name} is not a .glb. A .gltf needs its .bin siblings, which cannot be uploaded with it — export as GLB.`
          : `${file.name} is not a ${accepted} file.`,
    };
  }
  if (file.size === 0) return { field: slot, message: `${file.name} is empty.` };
  const cap = maxBytesFor(slot);
  if (file.size > cap) {
    return {
      field: slot,
      message: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(cap)}.`,
    };
  }
  return null;
}

/**
 * Every problem with a submission, not just the first — same reasoning as
 * `validateUpload` in app/api/renders/limits.ts.
 */
export function validateCaptureUpload(input: {
  splat: CandidateFile | null;
  collider: CandidateFile | null;
  thumbnail: CandidateFile | null;
  name: string;
  description: string;
}): UploadFieldError[] {
  const errors: UploadFieldError[] = [];

  if (!input.splat) {
    errors.push({ field: 'splat', message: 'Add the splat file — .spz or .ply.' });
  } else {
    const problem = validateSlotFile('splat', input.splat);
    if (problem) errors.push(problem);
  }

  if (!input.collider) {
    errors.push({
      field: 'collider',
      message:
        'Add the collision mesh. Without one the path generator has no walls to route around.',
    });
  } else {
    const problem = validateSlotFile('collider', input.collider);
    if (problem) errors.push(problem);
  }

  if (input.thumbnail) {
    const problem = validateSlotFile('thumbnail', input.thumbnail);
    if (problem) errors.push(problem);
  }

  /* Required here, unlike on the generate form, where a name can be derived
     from the layout sentence the prompt needed anyway. An upload has no prose
     to fall back on, and "render-20260829" is not a library. */
  const name = input.name.trim();
  if (name.length === 0) {
    errors.push({ field: 'name', message: 'Give the capture a name — it is how you find it again.' });
  } else if (name.length > MAX_NAME_CHARS) {
    errors.push({ field: 'name', message: `Keep the name under ${MAX_NAME_CHARS} characters.` });
  }

  if (input.description.trim().length > MAX_DESCRIPTION_CHARS) {
    errors.push({
      field: 'description',
      message: `${input.description.trim().length} characters; keep it under ${MAX_DESCRIPTION_CHARS}.`,
    });
  }

  return errors;
}
