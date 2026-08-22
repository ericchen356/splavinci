/**
 * STAGE 1 — intake-composer.
 *
 * Blueprint + photos + keywords in, one Marble prompt and an untouched photo
 * list out. See .claude/agents/intake-composer.md.
 *
 * Two rules from that spec drive the whole design:
 *
 * 1. The blueprint is not architecture. Nothing here opens the image, measures
 *    it, or extracts walls. It contributes exactly one thing — a sentence of
 *    plain English about room count and adjacency — and that sentence is an
 *    input, not an output (see `BlueprintInput`).
 * 2. The photos are not ours to edit. Marble consumes them directly, so they
 *    are validated and passed through byte-for-byte. No decode, no resize, no
 *    re-encode happens anywhere in this pipeline.
 */

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

import { MarbleError } from './errors';
import { MAX_IMAGES_RECONSTRUCT, SUPPORTED_IMAGE_EXTENSIONS } from './api';

/**
 * Where the layout sentence comes from.
 *
 * Reading a floor plan is a judgement about an image, and this stage has no
 * vision model wired to it. Rather than fake a reading, the description is
 * supplied by whoever does have eyes on the blueprint:
 *
 *   - a person, via `--layout` / `--layout-file` on the CLI, or
 *   - a vision model later, via the `describe` hook on `composeIntake`.
 *
 * Either way the text lands in `layoutDescription` and is used verbatim. The
 * blueprint `path` is carried for provenance only — it is checked for
 * existence so a typo fails here instead of silently generating the wrong
 * house, and is otherwise never opened.
 */
export type BlueprintInput = {
  path: string;
  /**
   * Room count and rough adjacency in one or two plain sentences, e.g.
   * "an open-plan kitchen leading into a living room, two bedrooms off a
   * hallway". Not a schedule of areas, not dimensions.
   */
  layoutDescription?: string;
};

/** Supplies the layout sentence for a blueprint this stage cannot read. */
export type BlueprintReader = (blueprintPath: string) => Promise<string> | string;

export type IntakeInput = {
  blueprint: BlueprintInput;
  /** Inspiration photos or as-built interiors. Order is preserved. */
  photos: string[];
  /** Free text. An array is joined with commas before composing. */
  keywords: string | string[];
};

export type IntakeOptions = {
  /**
   * Called only when `blueprint.layoutDescription` is absent. This is the seam
   * for a vision model; nothing in the repo implements one yet.
   */
  describe?: BlueprintReader;
  /**
   * Leading clause that anchors the generation as an interior at eye level.
   * Marble recaptions prompts by default and will happily drift a bare list of
   * adjectives into an exterior or a stylised render, which is useless for a
   * walkthrough. Pass null to omit it.
   */
  anchor?: string | null;
  /** Base for relative paths. Defaults to the process working directory. */
  cwd?: string;
};

/** The stage's output, exactly as environment-builder consumes it. */
export type IntakeResult = {
  composedPrompt: string;
  /** Absolute paths, in caller order, unmodified on disk. */
  images: string[];
};

/** Provenance for scene.json and for `--dry-run`. Not part of the contract. */
export type IntakeDetail = IntakeResult & {
  blueprintPath: string;
  layoutDescription: string;
  keywords: string;
};

export const DEFAULT_ANCHOR =
  'Interior of a home, photographed at standing eye level';

/** Trim, collapse runs of whitespace, drop a trailing sentence terminator. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
}

function joinSentences(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ? clean(p) : ''))
    .filter((p) => p.length > 0)
    .map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}.`)
    .join(' ');
}

async function assertReadableFile(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch (cause) {
    throw new MarbleError({
      kind: 'input',
      message: `${label} not found or not readable: ${path}`,
      hint: 'Pass a path that exists and is readable by this process.',
      cause,
    });
  }
  const info = await stat(path);
  if (!info.isFile()) {
    throw new MarbleError({
      kind: 'input',
      message: `${label} is not a file: ${path}`,
      cause: undefined,
    });
  }
  if (info.size === 0) {
    throw new MarbleError({
      kind: 'input',
      message: `${label} is empty (0 bytes): ${path}`,
      hint: 'A zero-byte image would be rejected by Marble after a long wait.',
    });
  }
}

/**
 * Validate the photo list without touching the pixels.
 *
 * The extension and count checks exist to fail in a second rather than five
 * minutes into a paid generation: Marble documents jpg/jpeg/png/webp as the
 * accepted formats, and caps multi-image input at 8 (4 without reconstruction
 * mode).
 */
async function resolvePhotos(photos: string[], cwd: string): Promise<string[]> {
  if (photos.length === 0) {
    throw new MarbleError({
      kind: 'input',
      message: 'At least one photo is required.',
      hint: 'Pass --photo <path> once per inspiration or interior photo.',
    });
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const photo of photos) {
    const abs = isAbsolute(photo) ? photo : resolve(cwd, photo);
    if (seen.has(abs)) continue;
    seen.add(abs);

    const ext = extname(abs).slice(1).toLowerCase();
    if (!(SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new MarbleError({
        kind: 'input',
        message: `Unsupported photo format ".${ext}": ${abs}`,
        hint: `Marble accepts ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}. Convert the file first — this stage will not re-encode it, because Marble consumes the original bytes.`,
      });
    }
    await assertReadableFile(abs, 'Photo');
    out.push(abs);
  }

  if (out.length > MAX_IMAGES_RECONSTRUCT) {
    throw new MarbleError({
      kind: 'input',
      message: `${out.length} photos supplied; Marble accepts at most ${MAX_IMAGES_RECONSTRUCT}.`,
      hint: 'Pick the views that cover the most distinct directions and drop the rest.',
    });
  }

  return out;
}

/**
 * Stage 1. Resolves the layout sentence, validates every path, and folds the
 * layout and the keywords into one prompt.
 */
export async function composeIntake(
  input: IntakeInput,
  options: IntakeOptions = {},
): Promise<IntakeDetail> {
  const cwd = options.cwd ?? process.cwd();
  const blueprintPath = isAbsolute(input.blueprint.path)
    ? input.blueprint.path
    : resolve(cwd, input.blueprint.path);

  await assertReadableFile(blueprintPath, 'Blueprint');

  const supplied = input.blueprint.layoutDescription?.trim();
  const described = supplied || (await options.describe?.(blueprintPath))?.trim();

  if (!described) {
    throw new MarbleError({
      kind: 'input',
      message: 'No layout description for the blueprint.',
      hint:
        'This stage deliberately does not read the blueprint image — it does not ' +
        'extract walls, rooms or measurements, and it will not invent a reading of ' +
        'a file it cannot see. Describe the plan in one sentence with --layout, or ' +
        'point --layout-file at a text file, e.g. "an open-plan kitchen leading into ' +
        'a living room, two bedrooms off a hallway".',
    });
  }

  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map(clean).filter(Boolean).join(', ')
    : clean(input.keywords);

  const images = await resolvePhotos(input.photos, cwd);

  const anchor = options.anchor === undefined ? DEFAULT_ANCHOR : options.anchor;
  const composedPrompt = joinSentences([
    anchor,
    `The layout is ${clean(described).replace(/^the layout is\s+/i, '')}`,
    keywords,
  ]);

  return {
    composedPrompt,
    images,
    blueprintPath,
    layoutDescription: clean(described),
    keywords,
  };
}
