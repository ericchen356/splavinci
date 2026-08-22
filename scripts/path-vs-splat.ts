/**
 * Does the generated camera path actually fly through the capture?
 *
 *   npx tsx scripts/path-vs-splat.ts <collider.glb> <room.spz> [groundOffset]
 *
 * The mini-map and the router both read the same derived collider, so they
 * always agree with each other - which says nothing about whether either
 * agrees with the splat. This checks the frames against the ORIGINAL density
 * field, the only thing that actually describes where the geometry is.
 */
import { loadColliderFromDisk } from './path-lab';
import {
  generatePath, createPathCache, buildWalkGrid, cellIndex, cellToWorld,
  reachableMask, resolveCameraRadius,
} from '@/lib/path';
import { readSpz } from './lib/spz-read.mjs';
import type { Vec3, Waypoint } from '@/lib/types';

const [, , colliderPath, spzPath, offsetArg] = process.argv;
const groundOffset = Number(offsetArg ?? 0.8933);

const collider = await loadColliderFromDisk(colliderPath);
const grid = buildWalkGrid(collider);

// Same frame the app renders the splat in: Y flipped by readSpz, then lifted.
const spz = await readSpz(spzPath, { flipYDown: true });
console.log(`${spz.n.toLocaleString()} splats, ground offset ${groundOffset}`);

const CELL = 0.25;
const MIN_OPACITY = 0.12;
let mnx = Infinity, mnz = Infinity, mny = Infinity;
let mxx = -Infinity, mxz = -Infinity, mxy = -Infinity;
for (let i = 0; i < spz.n; i++) {
  if (spz.A[i] < MIN_OPACITY) continue;
  const y = spz.Y[i] + groundOffset;
  if (spz.X[i] < mnx) mnx = spz.X[i]; if (spz.X[i] > mxx) mxx = spz.X[i];
  if (spz.Z[i] < mnz) mnz = spz.Z[i]; if (spz.Z[i] > mxz) mxz = spz.Z[i];
  if (y < mny) mny = y; if (y > mxy) mxy = y;
}
const nx = Math.ceil((mxx - mnx) / CELL) + 1;
const ny = Math.ceil((mxy - mny) / CELL) + 1;
const nz = Math.ceil((mxz - mnz) / CELL) + 1;
const dens = new Float32Array(nx * ny * nz);
const at = (x: number, y: number, z: number) => {
  const i = Math.floor((x - mnx) / CELL), j = Math.floor((y - mny) / CELL), k = Math.floor((z - mnz) / CELL);
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
  return (j * nz + k) * nx + i;
};
for (let i = 0; i < spz.n; i++) {
  if (spz.A[i] < MIN_OPACITY) continue;
  const idx = at(spz.X[i], spz.Y[i] + groundOffset, spz.Z[i]);
  if (idx >= 0) dens[idx] += spz.A[i];
}
const occupied = [...dens].filter(v => v > 0).sort((a, b) => a - b);
// A voxel is "solid" if it is denser than most occupied voxels.
const SOLID = occupied[Math.floor(occupied.length * 0.80)];
console.log(`density voxels ${nx}x${ny}x${nz} @ ${CELL}m, solid threshold ${SOLID.toFixed(1)}`);

// Place waypoints the way the app does: the UI snaps every click into the
// reachable region, so sampling raw passable cells would test legs a user can
// never actually create and blame the router for the straight-line fallback.
const resolved = resolveCameraRadius(grid, 0.3);
const reach = reachableMask(grid, resolved.radius);
const spots: Vec3[] = [];
for (let i = 0; spots.length < 4 && i < grid.cols * grid.rows; i += 53) {
  const c = i % grid.cols, r = (i / grid.cols) | 0;
  if (!reach.mask[cellIndex(grid, c, r)]) continue;
  const w = cellToWorld(grid, c, r);
  if (spots.every(s => Math.hypot(s[0] - w.x, s[2] - w.z) > 4)) spots.push([w.x, 0, w.z]);
}
console.log(`camera radius ${resolved.radius.toFixed(2)}m${resolved.relaxed ? ' (relaxed)' : ''}, ` +
            `reachable ${reach.cells} cells`);
const waypoints: Waypoint[] = spots.map((p, i) => ({
  id: `w${i + 1}`, position: p, mode: 'auto', shotType: 'orbit',
  duration: 4, emphasis: 1, pinned: false,
}));
const res = generatePath({ collider, waypoints, settings: { style: 'realEstate' } }, createPathCache());
console.log(`\n${waypoints.length} waypoints -> ${res.frames.length} frames, ${res.duration}s`);

let inside = 0, near = 0;
let worst = 0;
for (const f of res.frames) {
  const idx = at(f.position[0], f.position[1], f.position[2]);
  const d = idx >= 0 ? dens[idx] : 0;
  if (d >= SOLID) inside++;
  else if (d > 0) near++;
  if (d > worst) worst = d;
}
console.log(`frames INSIDE solid splat density : ${inside} (${(100*inside/res.frames.length).toFixed(1)}%)`);
console.log(`frames in merely occupied voxels  : ${near} (${(100*near/res.frames.length).toFixed(1)}%)`);
console.log(`peak density under the camera     : ${worst.toFixed(1)} (solid = ${SOLID.toFixed(1)})`);

// For the frames that are inside geometry, what did the collider believe?
import('@/lib/path').then(({ worldToCell, cellIndex }) => {
  let openFloor = 0, noFloor = 0, blockedCell = 0;
  const heights: number[] = [];
  const terrainAt: number[] = [];
  for (const f of res.frames) {
    const idx = at(f.position[0], f.position[1], f.position[2]);
    if (idx < 0 || dens[idx] < SOLID) continue;
    const { col, row } = worldToCell(grid, f.position[0], f.position[2]);
    const gi = cellIndex(grid, col, row);
    if (grid.blocked[gi]) blockedCell++;
    else if (grid.floor[gi]) openFloor++;
    else noFloor++;
    heights.push(f.position[1]);
    terrainAt.push(grid.floorY[gi]);
  }
  const stat = (a: number[]) => a.length
    ? `${Math.min(...a).toFixed(2)} .. ${Math.max(...a).toFixed(2)} (median ${a.slice().sort((x,y)=>x-y)[a.length>>1].toFixed(2)})`
    : 'n/a';
  console.log(`\nof the ${openFloor+noFloor+blockedCell} frames inside solid density, the collider said:`);
  console.log(`  open floor  ${openFloor}`);
  console.log(`  no floor    ${noFloor}`);
  console.log(`  blocked     ${blockedCell}`);
  console.log(`  camera y    ${stat(heights)}`);
  console.log(`  cell floorY ${stat(terrainAt.filter(Number.isFinite))}`);
  console.log(`  grid band   floor +${grid.band.low} .. +${grid.band.high}`);
});
