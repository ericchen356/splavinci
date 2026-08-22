/**
 * Find out whether Marble accepts a video as a world prompt.
 *
 * The OpenAPI schemas the adapter was written against document exactly two
 * world-prompt shapes, `image` and `multi-image`, and no video one — yet
 * `media-assets:prepare_upload` documents `kind: 'image' | 'video'`. Those two
 * facts cannot both be the whole story, and guessing costs a paid generation.
 *
 * Uploading a media asset is free. So: upload the video, then offer it where a
 * still would go and read the answer. A rejection is a cheap, definitive no; an
 * acceptance starts the generation we wanted anyway.
 *
 *   npx tsx --env-file=.env scripts/video-probe.ts <file.mov> [--generate]
 *
 * Without --generate it stops after the upload and prints the asset id, so the
 * expensive half is opt-in.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { MarbleClient, buildEnvironment, resolveApiKey } from '../lib/marble';

const path = resolve(process.argv[2] ?? 'samples/IMG_1210.MOV');
const doGenerate = process.argv.includes('--generate');

/* A 70 MB PUT to object storage is nothing like the JSON calls the default
   timeout was sized for. */
const client = new MarbleClient({ apiKey: resolveApiKey(), requestTimeoutMs: 15 * 60_000 });
const bytes = await readFile(path);
const extension = extname(path).slice(1).toLowerCase();

process.stdout.write(`file      ${basename(path)}  ${(bytes.length / 1e6).toFixed(1)} MB\n`);

const prepared = await client.prepareUpload({
  file_name: basename(path),
  kind: 'video',
  extension,
});
process.stdout.write(`asset     ${prepared.media_asset.media_asset_id}\n`);
process.stdout.write(`kind      ${prepared.media_asset.kind}\n`);

process.stdout.write('uploading…\n');
await client.uploadBytes(prepared.upload_info, new Uint8Array(bytes));
process.stdout.write('uploaded  OK\n');

if (!doGenerate) {
  process.stdout.write('\nstopped before generating (pass --generate to continue)\n');
  process.exit(0);
}

/* Offered as `image_prompt`, because that is the only single-media shape the
   schema has. If the backend dispatches on the asset's kind this works; if it
   validates strictly on media kind it fails here, which is the answer. */
try {
  const op = await client.generateWorld({
    world_prompt: {
      type: 'image',
      image_prompt: { source: 'media_asset', media_asset_id: prepared.media_asset.media_asset_id },
      text_prompt:
        'Interior of a home, photographed at standing eye level. This is one ' +
        'continuous enclosed interior: every wall runs from the floor to the ' +
        'ceiling, the ceiling covers the whole space, and there are no open ' +
        'sides or freestanding wall fragments.',
      is_pano: 'auto',
      disable_recaption: true,
    },
    model: 'marble-1.1',
    display_name: 'Video probe',
    tags: ['splavinci', 'video-probe'],
  });
  const operationId = (op as { operation_id?: string }).operation_id;
  process.stdout.write(`\nACCEPTED — operation ${operationId ?? JSON.stringify(op).slice(0, 200)}\n`);
  if (!operationId) process.exit(0);

  /* Attach to the generation already in flight rather than starting another.
     buildEnvironment owns every step after this - polling, picking a density,
     downloading to .part, verifying the collider loads, writing scene.json -
     and none of that is worth reimplementing for a probe that has just turned
     into a real capture. */
  process.stdout.write('waiting for the world…\n');
  const result = await buildEnvironment(
    { composedPrompt: '', images: [] },
    {
      setId: 'video-demo',
      displayName: 'Video demo',
      resumeOperationId: operationId,
      spz: 'full_res',
      deepVerify: true,
      provenance: {
        name: 'Video demo',
        description: 'Generated from a 50 s walkthrough video, not from stills.',
        sourceVideo: basename(path),
        note:
          'Video is not in the documented WorldPrompt schemas. It was accepted ' +
          'as image_prompt carrying a media asset of kind video.',
      },
      log: (line) => process.stdout.write(`${line}\n`),
    },
  );
  process.stdout.write(`\nworld    ${result.worldId}\n`);
  process.stdout.write(`splat    ${result.splat.file} (${result.splat.spzKey}, ${result.splat.bytes} bytes)\n`);
  process.stdout.write(`collider ${result.collider.file} (${result.collider.loader?.triangles ?? '?'} tris)\n`);
} catch (error) {
  process.stdout.write(`\nREJECTED — ${error instanceof Error ? error.message : String(error)}\n`);
}
