/**
 * Attach to a generation already in flight and land it as a capture.
 *
 * Separate from render-scene.ts because that one is driven by a samples/<id>
 * folder, and a world can also come from somewhere that has no scene folder —
 * a video, or a probe that turned out to be worth keeping.
 *
 *   npx tsx --env-file=.env scripts/resume-world.ts <operation-id> <set-id> [name]
 */

import { buildEnvironment } from '../lib/marble';

const [operationId, setId, ...rest] = process.argv.slice(2);
if (!operationId || !setId) {
  process.stderr.write('usage: resume-world.ts <operation-id> <set-id> [display name]\n');
  process.exit(2);
}
const displayName = rest.join(' ') || setId;

const result = await buildEnvironment(
  { composedPrompt: '', images: [] },
  {
    setId,
    displayName,
    resumeOperationId: operationId,
    spz: 'full_res',
    deepVerify: true,
    provenance: { name: displayName, resumedFrom: operationId },
    log: (line) => process.stdout.write(`${line}\n`),
  },
);

process.stdout.write(`\nworld    ${result.worldId}\n`);
if (result.worldMarbleUrl) process.stdout.write(`view     ${result.worldMarbleUrl}\n`);
process.stdout.write(`splat    ${result.splat.file} (${result.splat.spzKey}, ${result.splat.bytes} bytes)\n`);
process.stdout.write(`collider ${result.collider.file} (${result.collider.loader?.triangles ?? '?'} tris)\n`);
process.stdout.write(`scene    ${result.scenePath}\n`);
