/**
 * Command-line wiring for stage 1 -> stage 2.
 *
 * The body lives here rather than in scripts/ because tsconfig excludes
 * scripts/ from the typecheck; scripts/marble-generate.ts is a two-line shim so
 * that everything real stays under `tsc --noEmit`.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { relative } from 'node:path';

import { MARBLE_MODELS, type MarbleModel, buildWorldPrompt } from './api';
import { buildEnvironment } from './build';
import { API_KEY_ENV } from './client';
import { MarbleError, isMarbleError } from './errors';
import { composeIntake, type IntakeDetail } from './intake';

const USAGE = `
marble-generate — blueprint + photos + keywords -> room.spz + collider.glb

  npx tsx scripts/marble-generate.ts \\
    --blueprint plans/ground-floor.png \\
    --layout "an open-plan kitchen leading into a living room, two bedrooms off a hallway" \\
    --photo photos/living.jpg --photo photos/kitchen.jpg \\
    --keywords "warm oak floors, mid-century furniture, morning light" \\
    --id maple-street

Intake (stage 1)
  --blueprint <path>     Floor plan image. Never parsed — see --layout.
  --layout <text>        Room count and rough adjacency, in plain English.
  --layout-file <path>   Same, read from a file.
  --photo <path>         Inspiration or interior photo. Repeatable, max 8.
  --keywords <text>      Free text: materials, era, light, mood.
  --keywords-file <path> Same, read from a file.
  --no-anchor            Drop the "interior of a home, at eye level" preamble.

Generation (stage 2)
  --model <name>         ${MARBLE_MODELS.join(' | ')}   (default marble-1.1)
  --name <text>          display_name on the world, max 64 chars.
  --tag <text>           Repeatable, max 10.
  --seed <int>           Reproducible generation.
  --azimuths <list>      Per-photo bearing in degrees, e.g. 0,90,180.
                         Omitted entirely when you do not know them.
  --inline               Send photos as base64 instead of uploading them.
  --timeout <seconds>    Give up polling (default 1800).
  --poll <seconds>       First poll delay (default 5, grows to 20).

Output
  --out <dir>            Parent directory (default public/generated).
  --id <slug>            Capture folder + AssetSet id.
  --spz <key|all>        SPZ density: 500k | 100k | full_res | all.
  --skip-deep-verify     Skip the GLTFLoader pass on collider.glb.

Other
  --dry-run              Compose the prompt and print the exact request body.
                         Sends nothing, needs no API key.
  --resume <op_id>       Attach to a generation already running.
  --world <world_id>     Re-download an existing world's assets.
  -h, --help

${API_KEY_ENV} must be set for anything but --dry-run. See .env.example.
`.trimStart();

type Parsed = ReturnType<typeof parse>['values'];

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      blueprint: { type: 'string' },
      layout: { type: 'string' },
      'layout-file': { type: 'string' },
      photo: { type: 'string', multiple: true },
      keywords: { type: 'string' },
      'keywords-file': { type: 'string' },
      'no-anchor': { type: 'boolean' },

      model: { type: 'string' },
      name: { type: 'string' },
      tag: { type: 'string', multiple: true },
      seed: { type: 'string' },
      azimuths: { type: 'string' },
      inline: { type: 'boolean' },
      timeout: { type: 'string' },
      poll: { type: 'string' },

      out: { type: 'string' },
      id: { type: 'string' },
      spz: { type: 'string' },
      'skip-deep-verify': { type: 'boolean' },

      'dry-run': { type: 'boolean' },
      resume: { type: 'string' },
      world: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function requireString(value: string | undefined, flag: string): string {
  if (!value) {
    throw new MarbleError({ kind: 'input', message: `${flag} is required.`, hint: 'Run with --help.' });
  }
  return value;
}

function parseNumber(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new MarbleError({ kind: 'input', message: `${flag} must be a number, got "${value}".` });
  }
  return parsed;
}

function parseModel(value: string | undefined): MarbleModel | undefined {
  if (!value) return undefined;
  if (!(MARBLE_MODELS as readonly string[]).includes(value)) {
    throw new MarbleError({
      kind: 'input',
      message: `Unknown model "${value}".`,
      hint: `Supported: ${MARBLE_MODELS.join(', ')}.`,
    });
  }
  return value as MarbleModel;
}

function parseAzimuths(value: string | undefined, count: number): (number | null)[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((p) => p.trim());
  const parsed = parts.map((p) => {
    if (p === '' || p === '?') return null;
    const n = Number(p);
    if (!Number.isFinite(n)) {
      throw new MarbleError({ kind: 'input', message: `--azimuths: "${p}" is not a number.` });
    }
    return n;
  });
  if (parsed.length !== count) {
    throw new MarbleError({
      kind: 'input',
      message: `--azimuths has ${parsed.length} values but ${count} photos were given.`,
      hint: 'Use "?" for a photo whose bearing you do not know, or drop the flag entirely.',
    });
  }
  return parsed;
}

async function textFrom(inline: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (inline !== undefined) return inline;
  if (file !== undefined) return (await readFile(file, 'utf8')).trim();
  return undefined;
}

/** What the request body would look like, with photo payloads elided. */
function previewRequest(values: Parsed, intake: IntakeDetail): unknown {
  const references = intake.images.map((path) =>
    values.inline
      ? ({ source: 'data_base64' as const, data_base64: `<base64 of ${relative(process.cwd(), path)}>` })
      : ({ source: 'media_asset' as const, media_asset_id: `<upload of ${relative(process.cwd(), path)}>` }),
  );
  return {
    world_prompt: buildWorldPrompt({
      composedPrompt: intake.composedPrompt,
      references,
      azimuths: parseAzimuths(values.azimuths, intake.images.length),
    }),
    model: parseModel(values.model) ?? 'marble-1.1',
    ...(values.name ? { display_name: values.name.slice(0, 64) } : {}),
    ...(values.tag?.length ? { tags: values.tag.slice(0, 10) } : {}),
    ...(values.seed ? { seed: parseNumber(values.seed, '--seed') } : {}),
  };
}

/** Ready to paste into ASSET_SETS in lib/assets.ts. */
function assetSetSnippet(
  setId: string,
  placement: { position: number[]; rotation: number[]; scale: number },
  caption: string | null,
): string {
  const fixed = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
  const rotation = placement.rotation
    .map((r) => (Math.abs(r - Math.PI) < 1e-9 ? 'Math.PI' : fixed(r)))
    .join(', ');
  const description = (caption ?? 'Generated by World Labs Marble.').replace(/\s+/g, ' ').slice(0, 160);
  return `  '${setId}': {
    id: '${setId}',
    label: '${setId}',
    description:
      '${description.replace(/'/g, "\\'")}',
    splat: '/generated/${setId}/room.spz',
    splatFallback: null,
    collider: '/generated/${setId}/collider.glb',
    objects: '/generated/${setId}/objects.json',
    placement: {
      position: [${placement.position.map(fixed).join(', ')}],
      rotation: [${rotation}],
      scale: ${fixed(placement.scale)},
    },
  },`;
}

export async function runCli(argv: string[]): Promise<number> {
  let values: Parsed;
  try {
    values = parse(argv).values;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help || argv.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  const log: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

  try {
    const attaching = Boolean(values.resume || values.world);

    /* ------------------------------ stage 1 ------------------------------ */

    let intake: IntakeDetail | null = null;
    if (!attaching || values.blueprint) {
      const layout = await textFrom(values.layout, values['layout-file']);
      const keywords = (await textFrom(values.keywords, values['keywords-file'])) ?? '';

      intake = await composeIntake(
        {
          blueprint: {
            path: requireString(values.blueprint, '--blueprint'),
            ...(layout === undefined ? {} : { layoutDescription: layout }),
          },
          photos: values.photo ?? [],
          keywords,
        },
        values['no-anchor'] ? { anchor: null } : {},
      );

      log('composed prompt:');
      log(`  ${intake.composedPrompt}`);
      log(`images (${intake.images.length}, passed through unmodified):`);
      for (const image of intake.images) log(`  ${relative(process.cwd(), image)}`);
      log('');
    }

    if (values['dry-run']) {
      if (!intake) {
        throw new MarbleError({
          kind: 'input',
          message: '--dry-run needs the stage 1 inputs (--blueprint, --layout, --photo).',
        });
      }
      log('POST https://api.worldlabs.ai/marble/v1/worlds:generate');
      log(JSON.stringify(previewRequest(values, intake), null, 2));
      log('\nnothing was sent (--dry-run)');
      return 0;
    }

    /* ------------------------------ stage 2 ------------------------------ */

    const timeoutSeconds = parseNumber(values.timeout, '--timeout');
    const pollSeconds = parseNumber(values.poll, '--poll');
    const seed = parseNumber(values.seed, '--seed');

    const result = await buildEnvironment(
      {
        composedPrompt: intake?.composedPrompt ?? '',
        images: intake?.images ?? [],
      },
      {
        ...(values.out ? { outDir: values.out } : {}),
        ...(values.id ? { setId: values.id } : {}),
        ...(parseModel(values.model) ? { model: parseModel(values.model) } : {}),
        ...(values.name ? { displayName: values.name } : {}),
        ...(values.tag?.length ? { tags: values.tag } : {}),
        ...(seed === null ? {} : { seed }),
        ...(values.spz ? { spz: values.spz } : {}),
        ...(values.inline ? { imageDelivery: 'inline' as const } : {}),
        ...(values.resume ? { resumeOperationId: values.resume } : {}),
        ...(values.world ? { worldId: values.world } : {}),
        ...(intake
          ? { azimuths: parseAzimuths(values.azimuths, intake.images.length) }
          : {}),
        deepVerify: !values['skip-deep-verify'],
        ...(intake
          ? {
              provenance: {
                blueprint: relative(process.cwd(), intake.blueprintPath),
                layoutDescription: intake.layoutDescription,
                keywords: intake.keywords,
                photos: intake.images.map((p) => relative(process.cwd(), p)),
              },
            }
          : {}),
        wait: {
          ...(timeoutSeconds === null ? {} : { timeoutMs: timeoutSeconds * 1000 }),
          ...(pollSeconds === null ? {} : { initialPollMs: pollSeconds * 1000 }),
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
        `${result.collider.inspection.meshCount} mesh(es)` +
        `${result.collider.loader ? `, ${result.collider.loader.triangles} triangles` : ''}) VERIFIED`,
    );
    log(`scene    ${relative(process.cwd(), result.scenePath)}`);
    log('');
    log('add to ASSET_SETS in lib/assets.ts:');
    log(assetSetSnippet(result.setId, result.placement, result.caption));
    log('');
    log('objects.json is not produced by Marble. Derive one with:');
    log(`  node scripts/spz-collider.mjs ${relative(process.cwd(), result.dir)}/room.spz ${relative(process.cwd(), result.dir)}`);

    return 0;
  } catch (error) {
    if (isMarbleError(error)) {
      process.stderr.write(`\n${error.format()}\n`);
      return 1;
    }
    throw error;
  }
}
