/**
 * What the upload flow would make of a splat and a collider, without uploading
 * them.
 *
 *   npx tsx scripts/upload-scan.ts <splat.spz|.ply> <collider.glb>
 *
 * The same two scanners and the same alignment maths the route runs, printed
 * for all three orientations rather than just the one it would guess. Use it
 * when a capture comes out misaligned and you want to see the numbers the
 * decision was made on — or before uploading half a gigabyte, to find out
 * whether the two files are describing the same room at all.
 *
 * The counterpart to `render-scene.ts --dry-run` on the generate side: this one
 * writes nothing and costs nothing either.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  CAPTURE_ORIENTATIONS,
  ORIENTATION_LABEL,
  splatKindOf,
} from '@/app/api/uploads/limits';
import {
  colliderFrameWarning,
  guessOrientation,
  proposeAlignment,
  sizeOf,
  uprightEvidence,
  walkSurfaceY,
} from '@/lib/upload/align';
import { scanCollider } from '@/lib/upload/colliderScan';
import { scanSplat } from '@/lib/upload/splatScan';

const [splatPath, colliderPath] = process.argv.slice(2);

if (!splatPath || !colliderPath) {
  console.error('usage: npx tsx scripts/upload-scan.ts <splat.spz|.ply> <collider.glb>');
  process.exit(2);
}

const kind = splatKindOf(splatPath);
if (!kind) {
  console.error(`${basename(splatPath)} is neither .spz nor .ply`);
  process.exit(2);
}

const size = (v: readonly number[]) => v.map((n) => n.toFixed(2)).join(' x ');
const mb = (path: string) => `${(statSync(path).size / 1e6).toFixed(1)} MB`;

const splatStart = Date.now();
const splat = await scanSplat(splatPath, kind);
const splatMs = Date.now() - splatStart;

const colliderStart = Date.now();
const collider = await scanCollider(colliderPath);
const colliderMs = Date.now() - colliderStart;

console.log(`splat     ${basename(splatPath)}  ${mb(splatPath)}  ${splatMs}ms`);
console.log(`          ${splat.splatCount.toLocaleString()} splats, ${splat.sampled.toLocaleString()} sampled`);
console.log(`          measured ${size(sizeOf(splat.bounds))}   untrimmed ${size(sizeOf(splat.rawBounds))}`);
console.log(`collider  ${basename(colliderPath)}  ${mb(colliderPath)}  ${colliderMs}ms`);
console.log(`          ${collider.triangles.toLocaleString()} triangles in ${collider.meshes} mesh(es), floor ${collider.floorSource}`);
console.log(`          measured ${size(sizeOf(collider.bounds))}, walk surface y=${walkSurfaceY(collider).toFixed(3)}`);

const warning = colliderFrameWarning(collider);
if (warning) console.log(`\nWARNING   ${warning}`);

const guess = guessOrientation(splat);
console.log(`\nguess     ${guess.orientation} (${guess.confidence})`);
console.log(`          ${guess.reason}`);

console.log('\norientation        scale     lift    fitted splat size        footprint err   lower/upper');
for (const orientation of CAPTURE_ORIENTATIONS) {
  const alignment = proposeAlignment({ splat, collider, orientation, fit: true });
  const evidence = uprightEvidence(splat.profile, orientation);
  const mark = orientation === guess.orientation ? '>' : ' ';
  console.log(
    `${mark} ${ORIENTATION_LABEL[orientation].padEnd(18)}` +
      `${alignment.placement.scale.toFixed(4).padStart(7)}` +
      `${alignment.placement.position[1].toFixed(3).padStart(9)}   ` +
      `${size(alignment.splatExtent).padEnd(24)}` +
      `${(alignment.footprintError * 100).toFixed(1).padStart(6)}%` +
      `${evidence.ratio.toFixed(2).padStart(14)}`,
  );
}
