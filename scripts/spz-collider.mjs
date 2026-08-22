/**
 * Derive a walkable collider from a Gaussian splat.
 *
 *   node scripts/spz-collider.mjs <in.spz> <outDir> [cellSize]
 *
 * A splat file contains no mesh and no collision data - only Gaussians. But
 * the Gaussians describe a density field, and a wall is exactly a dense,
 * opaque, continuous mass within it. So occupancy is reconstructed from
 * density rather than guessed from splat counts.
 *
 * WHY DENSITY AND NOT COUNTS. Counting splat centres per cell treats a haze of
 * tiny transparent floaters the same as a solid wall, because it throws away
 * the two fields that distinguish them: opacity and scale. The result is a map
 * that looks like noise - speckle everywhere, no readable rooms. Here each
 * splat contributes its opacity across the floor area its Gaussian actually
 * covers, which is what makes walls come out solid and haze come out empty.
 *
 * The free-space/solid split is then found with Otsu's method rather than a
 * tuned constant, because that split is genuinely bimodal and a constant only
 * ever fits the capture it was tuned on.
 *
 * ORIENTATION. 3DGS captures trained from COLMAP are Y-down. This writes the
 * collider in the same Y-up frame the app renders the splat in and reports the
 * transform in scene.json, so SplatLayer can apply exactly the same one. If the
 * two disagree the splat and the collider silently separate.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { box, mergeParts } from './lib/geometry.mjs';
import { writeGlb } from './lib/glb.mjs';
import { readSpz, otsuThreshold } from './lib/spz-read.mjs';

const [, , inPath, outDir = 'public/derived', cellArg] = process.argv;
if (!inPath) {
  console.error('usage: spz-collider.mjs <in.spz> <outDir> [cellSize]');
  process.exit(1);
}

const CELL = Number(cellArg) || 0.4;
const HEIGHT_BIN = Number(process.env.HEIGHT_BIN ?? 0.25);
// Below this a Gaussian is haze, not surface. Floaters in a capture are almost
// always faint; real geometry is not.
const MIN_OPACITY = Number(process.env.MIN_OPACITY ?? 0.12);
const BAND_LOW = Number(process.env.BAND_LOW ?? 0.5);
const BAND_HIGH = Number(process.env.BAND_HIGH ?? 2.2);
// Fraction of a column's peak density that counts as "a surface starts here".
const FLOOR_PEAK_FRACTION = Number(process.env.FLOOR_PEAK_FRACTION ?? 0.18);

const spz = await readSpz(inPath, { flipYDown: true });
const { n, X, Y, Z, A, S } = spz;
console.log(`${n.toLocaleString()} splats, cell ${CELL} m, height bin ${HEIGHT_BIN} m`);

/* ---------------------------- robust bounds ------------------------------- */

function percentile(arr, p, stride = 1) {
  const out = [];
  for (let i = 0; i < arr.length; i += stride) if (A[i] >= MIN_OPACITY) out.push(arr[i]);
  if (out.length === 0) return 0;
  out.sort((a, b) => a - b);
  return out[Math.min(out.length - 1, Math.max(0, Math.floor(p * out.length)))];
}
const stride = Math.max(1, Math.floor(n / 400000));
const minX = percentile(X, 0.002, stride), maxX = percentile(X, 0.998, stride);
const minZ = percentile(Z, 0.002, stride), maxZ = percentile(Z, 0.998, stride);
const minY = percentile(Y, 0.002, stride), maxY = percentile(Y, 0.998, stride);
console.log(`extent ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} x ${(maxZ - minZ).toFixed(1)} m`);

const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
const bins = Math.max(1, Math.ceil((maxY - minY) / HEIGHT_BIN));
const cellCount = cols * rows;
console.log(`grid ${cols} x ${rows} x ${bins} bins = ${(cellCount * bins).toLocaleString()} voxels`);

/* --------------------- opacity-weighted density field --------------------- */

// density[cell * bins + bin] - accumulated opacity of every Gaussian whose
// horizontal footprint covers that cell at that height.
const density = new Float32Array(cellCount * bins);
let skippedFaint = 0;
let skippedOutside = 0;

for (let i = 0; i < n; i++) {
  const a = A[i];
  if (a < MIN_OPACITY) { skippedFaint++; continue; }

  const y = Y[i];
  let bin = Math.floor((y - minY) / HEIGHT_BIN);
  if (bin < 0 || bin >= bins) { skippedOutside++; continue; }

  // Footprint: one sigma of horizontal extent, floored at half a cell so a
  // sub-cell Gaussian still marks the cell it sits in.
  const radius = Math.max(S[i], CELL * 0.5);
  const c0 = Math.max(0, Math.floor((X[i] - radius - minX) / CELL));
  const c1 = Math.min(cols - 1, Math.floor((X[i] + radius - minX) / CELL));
  const r0 = Math.max(0, Math.floor((Z[i] - radius - minZ) / CELL));
  const r1 = Math.min(rows - 1, Math.floor((Z[i] + radius - minZ) / CELL));

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      density[(r * cols + c) * bins + bin] += a;
    }
  }
}
console.log(`skipped ${skippedFaint.toLocaleString()} faint (< ${MIN_OPACITY} opacity), ` +
            `${skippedOutside.toLocaleString()} outside height range`);

/* ------------------- floor height and band density per cell ---------------- */

const terrain = new Float32Array(cellCount).fill(NaN);
const bandDensity = new Float32Array(cellCount);

for (let c = 0; c < cellCount; c++) {
  const base = c * bins;
  let peak = 0;
  let column = 0;
  for (let b = 0; b < bins; b++) {
    const d = density[base + b];
    column += d;
    if (d > peak) peak = d;
  }
  if (column <= 0 || peak <= 0) continue;

  // Ground is the first substantial return scanning upward - not the minimum,
  // which is as likely to be a reconstruction artefact below the floor.
  const trigger = peak * FLOOR_PEAK_FRACTION;
  let floorBin = -1;
  for (let b = 0; b < bins; b++) {
    if (density[base + b] >= trigger) { floorBin = b; break; }
  }
  if (floorBin < 0) continue;

  terrain[c] = minY + (floorBin + 0.5) * HEIGHT_BIN;

  const loBin = Math.min(bins - 1, floorBin + Math.round(BAND_LOW / HEIGHT_BIN));
  const hiBin = Math.min(bins - 1, floorBin + Math.round(BAND_HIGH / HEIGHT_BIN));
  let inBand = 0;
  for (let b = loBin; b <= hiBin; b++) inBand += density[base + b];
  bandDensity[c] = inBand;
}

/* ------------------------- terrain outlier rejection ---------------------- */

{
  const MAX_DEVIATION = Number(process.env.MAX_TERRAIN_DEVIATION ?? 2.5);
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
      if (Math.abs(terrain[c] - around[Math.floor(around.length / 2)]) > MAX_DEVIATION) {
        rejected.push(c);
      }
    }
    for (const c of rejected) terrain[c] = NaN;
    if (rejected.length === 0) break;
    console.log(`terrain outlier pass ${pass + 1}: rejected ${rejected.length} cells`);
  }
}

/* ----------------------- automatic occupancy threshold -------------------- */

const occupiedSamples = [];
for (let c = 0; c < cellCount; c++) {
  if (!Number.isNaN(terrain[c])) occupiedSamples.push(bandDensity[c]);
}
const wallThreshold = otsuThreshold(occupiedSamples);
console.log(`Otsu wall threshold ${wallThreshold.toFixed(2)} ` +
            `(band density over ${occupiedSamples.length.toLocaleString()} floor cells)`);

const blocked = new Uint8Array(cellCount);
for (let c = 0; c < cellCount; c++) {
  if (Number.isNaN(terrain[c])) continue;
  if (bandDensity[c] >= wallThreshold) blocked[c] = 1;
}

// Lift so the median ground sits at y = 0.
const groundSamples = [];
for (let c = 0; c < cellCount; c++) if (!Number.isNaN(terrain[c])) groundSamples.push(terrain[c]);
groundSamples.sort((a, b) => a - b);
const groundOffset = groundSamples.length
  ? -groundSamples[Math.floor(groundSamples.length / 2)]
  : 0;
console.log(`ground offset ${groundOffset.toFixed(3)} m (median terrain -> 0)`);
/* --------------------------- grid morphology ------------------------------ */
/**
 * Per-cell thresholding decides each cell in isolation, so it produces speckle:
 * lone cells that crossed a threshold, pinholes where a cell just missed, and
 * fringe islands far from anything. Read as a floor plan that looks like random
 * blobs rather than a room. Real floors are spatially coherent, so the mask
 * gets the standard treatment - close small holes, open away specks, then drop
 * components too small to be part of the building.
 */
function dilate(mask, cols, rows, radius = 1) {
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let on = 0;
      for (let dz = -radius; dz <= radius && !on; dz++) {
        for (let dx = -radius; dx <= radius && !on; dx++) {
          const nx = c + dx, nz = r + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          if (mask[nz * cols + nx]) on = 1;
        }
      }
      out[r * cols + c] = on;
    }
  }
  return out;
}

function erode(mask, cols, rows, radius = 1) {
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let all = 1;
      for (let dz = -radius; dz <= radius && all; dz++) {
        for (let dx = -radius; dx <= radius && all; dx++) {
          const nx = c + dx, nz = r + dz;
          // Outside the grid counts as set, so the map edge is not eaten away.
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          if (!mask[nz * cols + nx]) all = 0;
        }
      }
      out[r * cols + c] = all;
    }
  }
  return out;
}

const close = (m, cols, rows, r = 1) => erode(dilate(m, cols, rows, r), cols, rows, r);
const open = (m, cols, rows, r = 1) => dilate(erode(m, cols, rows, r), cols, rows, r);

/** Drop connected components smaller than `minFraction` of the set cells. */
function keepLargeComponents(mask, cols, rows, minFraction = 0.04) {
  const label = new Int32Array(mask.length).fill(-1);
  const sizes = [];
  const stack = [];
  let total = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) total++;

  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || label[seed] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(seed);
    label[seed] = id;
    while (stack.length) {
      const c = stack.pop();
      size++;
      const cx = c % cols, cz = Math.floor(c / cols);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
        const nc = nz * cols + nx;
        if (mask[nc] && label[nc] === -1) { label[nc] = id; stack.push(nc); }
      }
    }
    sizes.push(size);
  }

  const floor = Math.max(4, total * minFraction);
  const out = new Uint8Array(mask.length);
  let kept = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && sizes[label[i]] >= floor) { out[i] = 1; kept++; }
  }
  return { mask: out, kept, components: sizes.length };
}

/* ------------------------ clean up the raw masks -------------------------- */
{
  let beforeFloor = 0, beforeBlocked = 0;
  for (let c = 0; c < cellCount; c++) {
    if (!Number.isNaN(terrain[c])) beforeFloor++;
    if (blocked[c]) beforeBlocked++;
  }

  let dataMask = new Uint8Array(cellCount);
  for (let c = 0; c < cellCount; c++) dataMask[c] = Number.isNaN(terrain[c]) ? 0 : 1;
  dataMask = close(dataMask, cols, rows, 1);
  const { mask: kept, components } = keepLargeComponents(dataMask, cols, rows, 0.04);
  dataMask = kept;

  for (let pass = 0; pass < 4; pass++) {
    let filled = 0;
    for (let c = 0; c < cellCount; c++) {
      if (!dataMask[c] || !Number.isNaN(terrain[c])) continue;
      const cx = c % cols, cz = Math.floor(c / cols);
      let sum = 0, cnt = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          const t = terrain[nz * cols + nx];
          if (!Number.isNaN(t)) { sum += t; cnt++; }
        }
      }
      if (cnt > 0) { terrain[c] = sum / cnt; filled++; }
    }
    if (filled === 0) break;
  }
  for (let c = 0; c < cellCount; c++) if (!dataMask[c]) terrain[c] = NaN;

  let obstacleMask = Uint8Array.from(blocked);
  obstacleMask = open(obstacleMask, cols, rows, 1);
  obstacleMask = close(obstacleMask, cols, rows, 1);
  for (let c = 0; c < cellCount; c++) {
    blocked[c] = obstacleMask[c] && !Number.isNaN(terrain[c]) ? 1 : 0;
  }

  let afterFloor = 0, afterBlocked = 0;
  for (let c = 0; c < cellCount; c++) {
    if (!Number.isNaN(terrain[c])) afterFloor++;
    if (blocked[c]) afterBlocked++;
  }
  console.log(`cleanup: floor ${beforeFloor} -> ${afterFloor}, ` +
              `blocked ${beforeBlocked} -> ${afterBlocked}, ${components} components before pruning`);
}

/* ------------------------------- emit glb --------------------------------- */

mkdirSync(outDir, { recursive: true });

const worldX = (c) => minX + (c % cols) * CELL;
const worldZ = (c) => minZ + Math.floor(c / cols) * CELL;
const worldY = (c) => terrain[c] + groundOffset;

const floorParts = [];
const obstacleParts = [];
for (let c = 0; c < cellCount; c++) {
  if (Number.isNaN(terrain[c])) continue;
  const y = worldY(c);
  if (blocked[c]) {
    obstacleParts.push(box(
      [worldX(c), y + BAND_LOW, worldZ(c)],
      [worldX(c) + CELL, y + BAND_HIGH, worldZ(c) + CELL],
    ));
  } else {
    floorParts.push(box([worldX(c), y - 0.05, worldZ(c)], [worldX(c) + CELL, y, worldZ(c) + CELL]));
  }
}

const parts = [];
if (floorParts.length) parts.push({ name: 'floor', ...mergeParts(floorParts) });
if (obstacleParts.length) parts.push({ name: 'obstacles', ...mergeParts(obstacleParts) });
const bytes = writeGlb(join(outDir, 'collider.glb'), parts, [0.6, 0.65, 0.75, 1]);
console.log(`collider.glb: floor ${floorParts.length} cells, obstacles ${obstacleParts.length} cells, ` +
            `${(bytes / 1e6).toFixed(1)} MB`);

// No individually meshed objects exist in this version of the pipeline; the
// file is still written so anything still fetching it gets an empty list
// rather than a 404.
writeFileSync(join(outDir, 'objects.json'), '[]\n');

writeFileSync(join(outDir, 'scene.json'), JSON.stringify({
  source: inPath,
  splatTransform: {
    rotation: [Math.PI, 0, 0],
    position: [0, +groundOffset.toFixed(4), 0],
    scale: 1,
  },
  cellSize: CELL,
  wallThreshold: +wallThreshold.toFixed(4),
  bounds: {
    min: [+minX.toFixed(3), 0, +minZ.toFixed(3)],
    max: [+maxX.toFixed(3), 0, +maxZ.toFixed(3)],
  },
}, null, 2) + '\n');
console.log('scene.json written');

// The app reads its placement from a hand-maintained constant in lib/assets.ts,
// not from scene.json, so a regeneration silently floats the splat off its own
// collider unless that constant is updated too. Print the exact line.
console.log(
  '\nIf this capture is wired into lib/assets.ts, its placement must now read:\n' +
  `    placement: { position: [0, ${groundOffset.toFixed(4)}, 0], ` +
  'rotation: [Math.PI, 0, 0], scale: 1 },',
);
