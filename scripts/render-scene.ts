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

import { buildWorldPrompt, type MarbleModel } from '@/lib/marble/api';
import { buildEnvironment } from '@/lib/marble/build';
import { isMarbleError, MarbleError } from '@/lib/marble/errors';
import { composeIntake } from '@/lib/marble/intake';

type SceneSpec = {
  id: string;
  name?: string;
  description?: string;
  blueprint: { path: string; layoutDescription?: string };
  photos: string[];
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
      '                       [--resume op] [--photos inspiration|views] [--recaption]\n',
  );
  process.exit(2);
}

const sceneDir = resolve(ROOT, 'samples', sceneId);
const spec = JSON.parse(await readFile(resolve(sceneDir, 'intake.json'), 'utf8')) as SceneSpec;

const log = (line: string) => process.stdout.write(`${line}\n`);

try {
  /* ------------------------------- stage 1 -------------------------------- */

  const photoRole = values.photos === 'views' ? 'views' : 'inspiration';
  const intake = await composeIntake(
    {
      blueprint: spec.blueprint,
      photos: spec.photos,
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
