/**
 * Render one sample scene folder through the Marble pipeline.
 *
 *   npx tsx --env-file=.env scripts/render-scene.ts birch-row --dry-run
 *   npx tsx --env-file=.env scripts/render-scene.ts birch-row
 *
 * scripts/marble-generate.ts takes the same intake on the command line, one
 * flag at a time. That is right for a one-off, and wrong for a scene that has
 * to be re-rendered months later by someone who was not here: the layout
 * sentence and the keyword list are the whole experiment, and a shell history
 * is not where an experiment should live. So each scene folder carries an
 * intake.json, this reads it, and the run is reproducible from the repo alone.
 *
 * Paths inside intake.json resolve against the scene folder, not the repo root,
 * so a scene folder can be copied somewhere else and still work.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { relative, resolve } from 'node:path';

import { buildWorldPrompt, MAX_IMAGES_RECONSTRUCT, type MarbleModel } from '@/lib/marble/api';
import { buildEnvironment } from '@/lib/marble/build';
import { isMarbleError, MarbleError } from '@/lib/marble/errors';
import { composeIntake } from '@/lib/marble/intake';

import { extractVideoFrames } from './lib/video-frames';

type SceneSpec = {
  id: string;
  name?: string;
  description?: string;
  /**
   * Optional only for a video scene, where the frames carry the geometry and
   * there is no plan to point at. See the `video` field.
   */
  blueprint?: { path: string; layoutDescription?: string };
  /**
   * A walkthrough to render from, instead of (not alongside) `photos`.
   *
   * Marble cannot take a video — a video media asset validates as an
   * `image_prompt` and then 500s the generation — but frames of one real space
   * are exactly the input `multi-image` + `reconstruct_images` exists for. So a
   * video scene extracts stills and sends those, as views rather than as
   * inspiration. See scripts/lib/video-frames.ts.
   */
  video?: {
    path: string;
    /** Evenly spaced stills to pull. Defaults to Marble's cap of 8. */
    frames?: number;
    /**
     * Stands in for `blueprint.layoutDescription`. For a video scene this
     * should describe what the footage SHOWS, not a floor plan: the frames are
     * the geometry, and prose that invents rooms only contradicts them.
     */
    layoutDescription?: string;
  };
  photos?: string[];
  keywords: string | string[];
  /** Metres, straight from the plan generator so drawing and prompt agree. */
  envelope?: { widthM: number; depthM: number; ceilingM: number };
  anchor?: string | null;
  generation?: {
    model?: MarbleModel;
    spz?: string;
    tags?: string[];
    seed?: number | null;
    displayName?: string;
  };
  provenance?: Record<string, unknown>;
};

const ROOT = resolve(import.meta.dirname, '..');
const rel = (path: string) => relative(ROOT, path) || path;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean' },
    out: { type: 'string' },
    world: { type: 'string' },
    resume: { type: 'string' },
    'skip-deep-verify': { type: 'boolean' },
    /* What the photographs are to Marble. See IntakeOptions.photoRole - the
       default sends one and describes the rest, because sending a set of them
       asks Marble to build a room where four different flats are all true at
       once. 'views' is only correct for photos of one real space. */
    photos: { type: 'string' },
    /* Overrides video.frames, for trying a coarser or finer sampling of the
       same walkthrough without editing the scene. */
    frames: { type: 'string' },
    /* Off by default so Marble rewrites our prompt as it normally would; on
       when the prompt has been written deliberately enough to be worth
       protecting, which is now the case for every scene folder. */
    recaption: { type: 'boolean' },
  },
});

const sceneId = positionals[0];
if (!sceneId) {
  process.stderr.write(
    'usage: render-scene.ts <scene-id> [--dry-run] [--out dir] [--world id]\n' +
      '                       [--resume op] [--photos inspiration|views] [--recaption]\n' +
      '                       [--frames n]   (video scenes only)\n',
  );
  process.exit(2);
}

const sceneDir = resolve(ROOT, 'samples', sceneId);
const spec = JSON.parse(await readFile(resolve(sceneDir, 'intake.json'), 'utf8')) as SceneSpec;

const log = (line: string) => process.stdout.write(`${line}\n`);

try {
  /* ------------------------------- stage 1 -------------------------------- */

  let photoRole: 'inspiration' | 'views' = values.photos === 'views' ? 'views' : 'inspiration';
  let photos = spec.photos ?? [];
  let blueprint = spec.blueprint;
  /* Left undefined for photo scenes so buildWorldPrompt keeps deciding by count
     exactly as it did before; set only by the video path. */
  let reconstructImages: boolean | undefined;
  let videoProvenance: Record<string, unknown> = {};

  if (spec.video) {
    const videoPath = resolve(sceneDir, spec.video.path);
    const requested = Number(values.frames ?? spec.video.frames ?? MAX_IMAGES_RECONSTRUCT);
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_IMAGES_RECONSTRUCT) {
      throw new MarbleError({
        kind: 'input',
        message: `Frame count must be 1..${MAX_IMAGES_RECONSTRUCT}, got ${values.frames ?? spec.video.frames}.`,
        hint: `Marble accepts at most ${MAX_IMAGES_RECONSTRUCT} images with reconstruct_images on, so that is the ceiling on frames.`,
      });
    }

    /* Derived, not authored: re-extracted on every run so the frames on disk
       can never disagree with the video and the count in the spec. */
    photos = await extractVideoFrames({
      videoPath,
      outDir: resolve(sceneDir, 'frames'),
      count: requested,
      log,
    });

    /* Not a choice the caller gets to make. Frames of one walk ARE views of one
       space, which is the only case 'views' is correct for, and the only case
       reconstruction has anything to reconstruct from. */
    photoRole = 'views';
    reconstructImages = true;

    /* composeIntake existence-checks the blueprint and then never opens it, so
       for a scene whose geometry comes from footage the video is the honest
       thing to record there. */
    blueprint ??= {
      path: videoPath,
      ...(spec.video.layoutDescription
        ? { layoutDescription: spec.video.layoutDescription }
        : {}),
    };
    videoProvenance = { video: rel(videoPath), videoFrames: photos.length };
  }

  if (!blueprint) {
    throw new MarbleError({
      kind: 'input',
      message: `Scene ${spec.id} has neither a "blueprint" nor a "video".`,
      hint: 'A scene needs a plan to describe or footage to reconstruct from.',
    });
  }

  const intake = await composeIntake(
    {
      blueprint,
      photos,
      keywords: spec.keywords,
      ...(spec.envelope ? { envelope: spec.envelope } : {}),
    },
    {
      cwd: sceneDir,
      photoRole,
      ...(spec.anchor === undefined ? {} : { anchor: spec.anchor }),
    },
  );

  log(`scene    ${spec.id}${spec.name ? ` — ${spec.name}` : ''}`);
  log('prompt:');
  log(`  ${intake.composedPrompt}`);
  log(`images (${intake.images.length}, passed through unmodified):`);
  for (const image of intake.images) log(`  ${rel(image)}`);
  if (intake.omittedPhotos.length > 0) {
    log(`withheld (${intake.omittedPhotos.length}, style carried by the prompt instead):`);
    for (const image of intake.omittedPhotos) log(`  ${rel(image)}`);
  }

  if (values['dry-run']) {
    const references = intake.images.map((path) => ({
      source: 'media_asset' as const,
      media_asset_id: `<upload of ${rel(path)}>`,
    }));
    log('');
    log('POST https://api.worldlabs.ai/marble/v1/worlds:generate');
    log(
      JSON.stringify(
        {
              world_prompt: buildWorldPrompt({
            composedPrompt: intake.composedPrompt,
            references,
            disableRecaption: !values.recaption,
            ...(reconstructImages === undefined ? {} : { reconstructImages }),
          }),
          model: spec.generation?.model ?? 'marble-1.1',
          display_name: spec.generation?.displayName ?? spec.name ?? spec.id,
          ...(spec.generation?.tags?.length ? { tags: spec.generation.tags } : {}),
        },
        null,
        2,
      ),
    );
    log('\nnothing was sent (--dry-run)');
    process.exit(0);
  }

  /* ------------------------------- stage 2 -------------------------------- */

  const result = await buildEnvironment(
    { composedPrompt: intake.composedPrompt, images: intake.images },
    {
      setId: spec.id,
      ...(values.out ? { outDir: values.out } : {}),
      ...(spec.generation?.model ? { model: spec.generation.model } : {}),
      ...(spec.generation?.spz ? { spz: spec.generation.spz } : {}),
      ...(spec.generation?.tags?.length ? { tags: spec.generation.tags } : {}),
      ...(spec.generation?.seed === undefined || spec.generation.seed === null
        ? {}
        : { seed: spec.generation.seed }),
      displayName: spec.generation?.displayName ?? spec.name ?? spec.id,
      ...(values.world ? { worldId: values.world } : {}),
      ...(values.resume ? { resumeOperationId: values.resume } : {}),
      deepVerify: !values['skip-deep-verify'],
      disableRecaption: !values.recaption,
      ...(reconstructImages === undefined ? {} : { reconstructImages }),
      // name/description are read back by lib/renders.ts to label the capture
      // in the render list; the rest is what the scene was made from.
      provenance: {
        ...(spec.name ? { name: spec.name } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        scene: `samples/${spec.id}`,
        blueprint: rel(intake.blueprintPath),
        layoutDescription: intake.layoutDescription,
        keywords: intake.keywords,
        photos: intake.images.map(rel),
        // Recorded so a reader can tell a photo that was withheld from one
        // that was never offered.
        ...(intake.omittedPhotos.length > 0
          ? { photosWithheld: intake.omittedPhotos.map(rel) }
          : {}),
        photoRole,
        ...videoProvenance,
        ...(spec.envelope ? { envelope: spec.envelope } : {}),
        ...spec.provenance,
      },
      log,
    },
  );

  log('');
  log(`world    ${result.worldId}`);
  if (result.worldMarbleUrl) log(`view     ${result.worldMarbleUrl}`);
  log(`splat    ${result.splat.file}  (${result.splat.spzKey}, ${result.splat.bytes} bytes)`);
  log(
    `collider ${result.collider.file}  (${result.collider.bytes} bytes, ` +
      `${result.collider.loader?.triangles ?? '?'} triangles) VERIFIED`,
  );
  log(`scene    ${rel(result.scenePath)}`);
} catch (error) {
  if (isMarbleError(error) || error instanceof MarbleError) {
    process.stderr.write(`\n${(error as MarbleError).format()}\n`);
    process.exit(1);
  }
  throw error;
}
