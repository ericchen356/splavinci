/**
 * Derive a walkable collider (and an object manifest) from a Gaussian splat.
 *
 *   node scripts/spz-collider.mjs <in.spz> <outDir> [cellSize]
 *
 * A real capture arrives as splats and nothing else - no collision mesh, no
 * object list - but the waypoint, routing and auto-shot pipeline needs both. Rather than
 * hand-authoring them, this reads the geometry the splats already describe:
 *
 *   terrain    the low percentile of height per cell, which is the ground
 *   obstacles  cells carrying mass in the camera's vertical band, which is
 *              what the camera would actually collide with
 *   objects    connected clusters of obstacle cells, sized from their extent,
 *              so shot inference has real proportions to reason about
 *
 * ORIENTATION. 3DGS captures trained from COLMAP are Y-down. This writes the
 * collider in the same Y-up frame the app renders the splat in - a 180 degree
 * turn about X, then a lift so the ground sits at y = 0 - and reports that
 * transform in scene.json so SplatLayer can apply exactly the same one. If the
 * two ever disagree the splat and the collider silently separate.
 */
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { box, mergeParts } from './lib/geometry.mjs';
import { writeGlb } from './lib/glb.mjs';

const [, , inPath, outDir = 'public/derived', cellArg] = process.argv;
if (!inPath) {
  console.error('usage: spz-collider.mjs <in.spz> <outDir> [cellSize]');
  process.exit(1);
}
const CELL = Number(cellArg) || 0.5;

/* ------------------------------- decode ---------------------------------- */

const tmp = join(tmpdir(), `spzc-${process.pid}.bin`);
await pipeline(createReadStream(inPath), createGunzip(), createWriteStream(tmp));
const raw = readFileSync(tmp);
if (raw.readUInt32LE(0) !== 0x5053474e) throw new Error('not an SPZ file');
const N = raw.readUInt32LE(8);
const fracBits = raw.readUInt8(13);
const scale = 1 / (1 << fracBits);
console.log(`${N.toLocaleString()} splats, cell ${CELL} m`);

// Y-down -> Y-up is a 180 degree turn about X: (x, y, z) -> (x, -y, -z).
const X = new Float32Array(N);
const Y = new Float32Array(N);
const Z = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const o = 16 + i * 9;
  const rd = (b) => {
    let v = raw[b] | (raw[b + 1] << 8) | (raw[b + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v * scale;
  };
  X[i] = rd(o);
  Y[i] = -rd(o + 3);
  Z[i] = -rd(o + 6);
}
unlinkSync(tmp);

/* --------------------------- robust bounds -------------------------------- */

// Percentile bounds, not min/max: a handful of floater splats sit tens of
// metres off and would otherwise stretch the grid over mostly empty space.
function percentile(arr, p) {
  const copy = Float32Array.from(arr);
  copy.sort();
  return copy[Math.min(copy.length - 1, Math.max(0, Math.floor(p * copy.length)))];
}
const sample = (a) => {
  const step = Math.max(1, Math.floor(a.length / 200000));
  const out = new Float32Array(Math.ceil(a.length / step));
  for (let i = 0, k = 0; i < a.length; i += step) out[k++] = a[i];
  return out;
};
const sx = sample(X), sy = sample(Y), sz = sample(Z);
const minX = percentile(sx, 0.001), maxX = percentile(sx, 0.999);
const minZ = percentile(sz, 0.001), maxZ = percentile(sz, 0.999);
console.log(`extent x ${(maxX - minX).toFixed(1)} m, z ${(maxZ - minZ).toFixed(1)} m`);

const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
const cellCount = cols * rows;
console.log(`grid ${cols} x ${rows} = ${cellCount.toLocaleString()} cells`);

/* ----------------------- bucket heights per cell -------------------------- */

const cellOf = (i) => {
  const c = Math.floor((X[i] - minX) / CELL);
  const r = Math.floor((Z[i] - minZ) / CELL);
  if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
  return r * cols + c;
};

const counts = new Int32Array(cellCount);
for (let i = 0; i < N; i++) { const c = cellOf(i); if (c >= 0) counts[c]++; }

const offsets = new Int32Array(cellCount + 1);
for (let c = 0; c < cellCount; c++) offsets[c + 1] = offsets[c] + counts[c];
const heights = new Float32Array(offsets[cellCount]);
const cursor = Int32Array.from(offsets.subarray(0, cellCount));
for (let i = 0; i < N; i++) { const c = cellOf(i); if (c >= 0) heights[cursor[c]++] = Y[i]; }

/* --------------------------- terrain + occupancy -------------------------- */

// Tunable from the environment: an outdoor capture and an indoor room want
// very different thresholds, and the right values are found by looking at the
// ASCII map (npx tsx scripts/path-lab.ts <collider.glb>) rather than derived.
const MIN_FLOOR_SPLATS = Number(process.env.MIN_FLOOR_SPLATS ?? 3);
const BAND_LOW = Number(process.env.BAND_LOW ?? 0.5);    // below this is ground clutter
const BAND_HIGH = Number(process.env.BAND_HIGH ?? 2.2);  // camera corridor top
const OBSTACLE_FRACTION = Number(process.env.OBSTACLE_FRACTION ?? 0.28);

const terrain = new Float32Array(cellCount).fill(NaN);
const bandCount = new Int32Array(cellCount);

for (let c = 0; c < cellCount; c++) {
  const start = offsets[c], end = offsets[c + 1];
  const n = end - start;
  if (n < MIN_FLOOR_SPLATS) continue;
  const slice = heights.subarray(start, end);
  const sorted = Float32Array.from(slice).sort();
  // 8th percentile, not the minimum: the lowest splat in a cell is as likely
  // to be a reconstruction artefact below ground as it is to be ground.
  terrain[c] = sorted[Math.floor(0.08 * n)];
  const lo = terrain[c] + BAND_LOW;
  const hi = terrain[c] + BAND_HIGH;
  let inBand = 0;
  for (let k = 0; k < n; k++) if (sorted[k] >= lo && sorted[k] <= hi) inBand++;
  bandCount[c] = inBand;
}

// Reject terrain outliers before anything downstream trusts them.
//
// A cell with only a handful of splats can have its height percentile land on
// a floater metres above the ground, and one bad cell becomes a spike of
// "floor" that distorts camera framing and gives A* a staircase to nowhere.
// Comparing each cell against the median of its neighbours catches those
// without flattening genuine terrain, which varies smoothly between adjacent
// cells by construction.
{
  const MAX_NEIGHBOUR_DEVIATION = Number(process.env.MAX_TERRAIN_DEVIATION ?? 2.5);
  for (let pass = 0; pass < 2; pass++) {
    const rejected = [];
    for (let c = 0; c < cellCount; c++) {
      if (Number.isNaN(terrain[c])) continue;
      const cx = c % cols, cz = Math.floor(c / cols);
      const around = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          const t = terrain[nz * cols + nx];
          if (!Number.isNaN(t)) around.push(t);
        }
      }
      if (around.length < 3) { rejected.push(c); continue; }
      around.sort((a, b) => a - b);
      const median = around[Math.floor(around.length / 2)];
      if (Math.abs(terrain[c] - median) > MAX_NEIGHBOUR_DEVIATION) rejected.push(c);
    }
    for (const c of rejected) terrain[c] = NaN;
    console.log(`terrain outlier pass ${pass + 1}: rejected ${rejected.length} cells`);
    if (rejected.length === 0) break;
  }
}

// Lift so the median ground sits at y = 0.
const validTerrain = [];
for (let c = 0; c < cellCount; c++) if (!Number.isNaN(terrain[c])) validTerrain.push(terrain[c]);
validTerrain.sort((a, b) => a - b);
const groundOffset = -validTerrain[Math.floor(validTerrain.length / 2)];
console.log(`ground offset ${groundOffset.toFixed(3)} m (median terrain -> 0)`);

const blocked = new Uint8Array(cellCount);
let floorCells = 0, blockedCells = 0;
for (let c = 0; c < cellCount; c++) {
  if (Number.isNaN(terrain[c])) continue;
  floorCells++;
  const n = offsets[c + 1] - offsets[c];
  if (bandCount[c] >= Math.max(4, n * OBSTACLE_FRACTION)) { blocked[c] = 1; blockedCells++; }
}
console.log(`floor cells ${floorCells.toLocaleString()}, blocked ${blockedCells.toLocaleString()} ` +
            `(${(100 * blockedCells / Math.max(1, floorCells)).toFixed(1)}%)`);

/* ------------------------------- emit glb --------------------------------- */

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'meshes'), { recursive: true });

const worldX = (c) => minX + (c % cols) * CELL;
const worldZ = (c) => minZ + Math.floor(c / cols) * CELL;
const worldY = (c) => terrain[c] + groundOffset;

// Floor: one thin slab per cell. Independent quads rather than a stitched
// heightfield, so holes in the capture stay holes instead of being bridged.
const floorParts = [];
for (let c = 0; c < cellCount; c++) {
  if (Number.isNaN(terrain[c]) || blocked[c]) continue;
  const y = worldY(c);
  floorParts.push(box([worldX(c), y - 0.05, worldZ(c)], [worldX(c) + CELL, y, worldZ(c) + CELL]));
}
const obstacleParts = [];
for (let c = 0; c < cellCount; c++) {
  if (!blocked[c]) continue;
  const y = worldY(c);
  obstacleParts.push(box(
    [worldX(c), y + BAND_LOW, worldZ(c)],
    [worldX(c) + CELL, y + BAND_HIGH, worldZ(c) + CELL],
  ));
}

const parts = [];
if (floorParts.length) parts.push({ name: 'floor', ...mergeParts(floorParts) });
if (obstacleParts.length) parts.push({ name: 'obstacles', ...mergeParts(obstacleParts) });
const bytes = writeGlb(join(outDir, 'collider.glb'), parts, [0.6, 0.65, 0.75, 1]);
console.log(`collider.glb: floor ${floorParts.length} cells, obstacles ${obstacleParts.length} cells, ` +
            `${(bytes / 1e6).toFixed(1)} MB`);

/* --------------------- cluster obstacles into objects --------------------- */

// Connected components over blocked cells. Gives the auto shot inference real
// proportions to work with instead of an empty manifest, which would make
// every waypoint a dolly-through.
const label = new Int32Array(cellCount).fill(-1);
const clusters = [];
const stack = [];
for (let seed = 0; seed < cellCount; seed++) {
  if (!blocked[seed] || label[seed] !== -1) continue;
  const id = clusters.length;
  const cells = [];
  stack.push(seed);
  label[seed] = id;
  while (stack.length) {
    const c = stack.pop();
    cells.push(c);
    const cx = c % cols, cz = Math.floor(c / cols);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
      const nc = nz * cols + nx;
      if (blocked[nc] && label[nc] === -1) { label[nc] = id; stack.push(nc); }
    }
  }
  clusters.push(cells);
}

const MAX_OBJECTS = 14;
const ranked = clusters
  .map((cells) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity, base = Infinity;
    for (const c of cells) {
      x0 = Math.min(x0, worldX(c)); x1 = Math.max(x1, worldX(c) + CELL);
      z0 = Math.min(z0, worldZ(c)); z1 = Math.max(z1, worldZ(c) + CELL);
      const y = worldY(c);
      base = Math.min(base, y);
      const slice = heights.subarray(offsets[c], offsets[c + 1]);
      let hi = -Infinity;
      for (let k = 0; k < slice.length; k++) if (slice[k] > hi) hi = slice[k];
      top = Math.max(top, hi + groundOffset);
    }
    return { cells: cells.length, x0, x1, z0, z1, base, top };
  })
  // Ignore slivers: one or two cells is noise, not a feature. The right floor
  // depends on cell size, so it is tunable alongside the other thresholds.
  .filter((c) => c.cells >= Number(process.env.MIN_CLUSTER_CELLS ?? 3))
  // Drop clusters that span a large share of the scene. Obstacle cells in an
  // outdoor capture connect into one sprawling mass - terrain and structure
  // fused together - and that blob is not an object anyone frames a shot on.
  .filter((c) => {
    const sceneSpan = Math.max(maxX - minX, maxZ - minZ);
    return Math.max(c.x1 - c.x0, c.z1 - c.z0) <= sceneSpan * 0.35;
  })
  .sort((a, b) => b.cells - a.cells)
  .slice(0, MAX_OBJECTS);

const manifest = ranked.map((c, i) => {
  const id = `feature-${i + 1}`;
  const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
  const height = Math.max(0.6, Math.min(c.top - c.base, 12));
  const cy = c.base + height / 2;
  const half = [(c.x1 - c.x0) / 2, height / 2, (c.z1 - c.z0) / 2];
  writeGlb(
    join(outDir, 'meshes', `${id}.glb`),
    [{ name: id, ...box([-half[0], -half[1], -half[2]], half) }],
    [0.42, 0.46, 0.4, 1],
  );
  return {
    id,
    meshUrl: `/${outDir.replace(/^public\//, '')}/meshes/${id}.glb`,
    position: [+cx.toFixed(3), +cy.toFixed(3), +cz.toFixed(3)],
    label: `Feature ${i + 1} (${(c.x1 - c.x0).toFixed(1)}x${height.toFixed(1)}x${(c.z1 - c.z0).toFixed(1)} m)`,
  };
});
writeFileSync(join(outDir, 'objects.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`objects.json: ${manifest.length} features from ${clusters.length} clusters`);

/* ------------------------------ scene.json -------------------------------- */

writeFileSync(join(outDir, 'scene.json'), JSON.stringify({
  source: inPath,
  splatTransform: {
    // Must match how the collider above was generated.
    rotation: [Math.PI, 0, 0],
    position: [0, +groundOffset.toFixed(4), 0],
    scale: 1,
  },
  cellSize: CELL,
  bounds: {
    min: [+minX.toFixed(3), 0, +minZ.toFixed(3)],
    max: [+maxX.toFixed(3), 0, +maxZ.toFixed(3)],
  },
}, null, 2) + '\n');
console.log('scene.json written');
