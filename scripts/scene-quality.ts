/**
 * Measure a generated capture instead of looking at it.
 *
 *   npx tsx scripts/scene-quality.ts <scene-id|dir> [--cell 0.25] [--json]
 *
 * WHY THIS EXISTS. An earlier capture was rejected for "being full of holes and
 * looking unfilled", which is a true observation and an unusable bug report: it
 * cannot be regressed, compared between captures, or argued with. Everything
 * here turns one of those complaints into a number.
 *
 * Four questions, in the order they can disqualify a capture:
 *
 *   1. Is the splat a well-formed SPZ, and how much of it is there?
 *   2. Does the collider load, and does it yield a walk grid with floor in it?
 *   3. Is the space FILLED - does the floor have splats on it, are the walls
 *      opaque from the inside, and how big is the largest hole?
 *   4. Can the camera actually route it, and does the route stay in open air?
 *
 * Frames of reference. scene.json's splatTransform is applied to BOTH assets,
 * exactly as lib/scene/loaders.ts does for the collider and SplatLayer does for
 * the splat, so every number below is in metres of the space the user flies
 * through. Measuring in the raw Marble frame would be off by the capture's
 * metric_scale_factor - 1.94x on maple-street - which is the difference between
 * a doorway and a cupboard.
 */

import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { basename, join, relative, resolve } from 'node:path';

import * as THREE from 'three';

import { buildColliderData, type ColliderData } from '@/lib/scene/collider';
import {
  buildWalkGrid,
  cachedConnectivity,
  cellIndex,
  cellToWorld,
  createPathCache,
  generatePath,
  gridStats,
  reachableMask,
  resolveCameraRadius,
  worldToCell,
  type WalkGrid,
} from '@/lib/path';
import { inspectGlb } from '@/lib/marble/glb';
import { verifyColliderWithLoader } from '@/lib/marble/verify';
import type { Vec3, Waypoint } from '@/lib/types';

import { readSpz } from './lib/spz-read.mjs';

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Below this a Gaussian is haze, not surface. Same value as spz-collider.mjs. */
const MIN_OPACITY = 0.12;
/** Accumulated opacity below which a voxel column counts as unobserved. */
const MIN_COLUMN_MASS = 0.8;
/** Slab around a cell's floor height that a floor surface must show up in. */
const FLOOR_BAND = { low: -0.25, high: 0.35 };
/** Eye height for the enclosure rays, above the local floor. */
const EYE_HEIGHT = 1.6;
/** Directions cast from each sampled cell to ask "can I see out from here". */
const RAY_DIRECTIONS = 16;

type Placement = { position: Vec3; rotation: Vec3; scale: number };
const IDENTITY: Placement = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };

/* -------------------------------------------------------------------------- */
/* splat                                                                      */
/* -------------------------------------------------------------------------- */

type SplatField = {
  n: number;
  version: number;
  shDegree: number;
  fractionalBits: number;
  /** World-space, placement applied, opaque splats only. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  a: Float32Array;
  kept: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Bounds with the outer 0.5% per axis trimmed off; see readSplatField. */
  coreMin: THREE.Vector3;
  coreMax: THREE.Vector3;
};

/**
 * Read the splat and put it in world space.
 *
 * readSpz's `flipYDown` already performs the 180 degree turn about X that the
 * placement's rotation asks for, so only the scale and the ground offset are
 * left to apply. Anything fainter than MIN_OPACITY is dropped here rather than
 * at every use site: a floater haze answers "is there something here" yes and
 * "can you see it" no, and every question below means the second one.
 */
async function readSplatField(path: string, placement: Placement): Promise<SplatField> {
  const spz = await readSpz(path, { flipYDown: true });
  const s = placement.scale;
  const [ox, oy, oz] = placement.position;

  const x = new Float32Array(spz.n);
  const y = new Float32Array(spz.n);
  const z = new Float32Array(spz.n);
  const a = new Float32Array(spz.n);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let kept = 0;

  for (let i = 0; i < spz.n; i++) {
    if (spz.A[i] < MIN_OPACITY) continue;
    const wx = ox + s * spz.X[i];
    const wy = oy + s * spz.Y[i];
    const wz = oz + s * spz.Z[i];
    x[kept] = wx;
    y[kept] = wy;
    z[kept] = wz;
    a[kept] = spz.A[i];
    kept++;
    if (wx < min.x) min.x = wx;
    if (wy < min.y) min.y = wy;
    if (wz < min.z) min.z = wz;
    if (wx > max.x) max.x = wx;
    if (wy > max.y) max.y = wy;
    if (wz > max.z) max.z = wz;
  }

  // Raw bounds are decided by the single furthest splat, so one floater 20 m up
  // makes a 2.6 m flat report a 22 m ceiling. Trimming half a percent off each
  // end gives the extent of the thing a viewer would call the capture, and the
  // gap between the two numbers is itself the reading: a large one means a
  // halo of stray Gaussians around the room.
  const percentile = (values: Float32Array, count: number, p: number): number => {
    const copy = values.subarray(0, count).slice();
    copy.sort();
    return copy[Math.min(count - 1, Math.max(0, Math.floor(p * count)))];
  };
  const coreMin = new THREE.Vector3(
    percentile(x, kept, 0.005), percentile(y, kept, 0.005), percentile(z, kept, 0.005),
  );
  const coreMax = new THREE.Vector3(
    percentile(x, kept, 0.995), percentile(y, kept, 0.995), percentile(z, kept, 0.995),
  );

  return {
    n: spz.n,
    version: spz.version,
    shDegree: spz.shDegree,
    fractionalBits: spz.fractionalBits,
    x, y, z, a, kept, min, max, coreMin, coreMax,
  };
}

/* -------------------------------------------------------------------------- */
/* density voxels                                                             */
/* -------------------------------------------------------------------------- */

type DensityVolume = {
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  min: THREE.Vector3;
  data: Float32Array;
  /** Density at or above which a voxel is dense enough to be inside geometry. */
  solid: number;
  /** Density at or above which a voxel holds a visible surface. */
  matter: number;
  occupied: number;
};

/**
 * Accumulated opacity per voxel.
 *
 * Splat centres are counted, not footprints. Footprint smearing is right for
 * deriving a collider (scripts/spz-collider.mjs) because a wall must come out
 * continuous; it is wrong here, because smearing a sparse capture across the
 * cells it did not actually observe is precisely the hole this script is
 * looking for.
 */
function buildDensity(field: SplatField, cell: number): DensityVolume {
  const min = field.min.clone().subScalar(cell);
  const max = field.max.clone().addScalar(cell);
  const nx = Math.max(1, Math.ceil((max.x - min.x) / cell));
  const ny = Math.max(1, Math.ceil((max.y - min.y) / cell));
  const nz = Math.max(1, Math.ceil((max.z - min.z) / cell));
  const data = new Float32Array(nx * ny * nz);

  for (let i = 0; i < field.kept; i++) {
    const ix = Math.floor((field.x[i] - min.x) / cell);
    const iy = Math.floor((field.y[i] - min.y) / cell);
    const iz = Math.floor((field.z[i] - min.z) / cell);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    data[(iy * nz + iz) * nx + ix] += field.a[i];
  }

  // Two thresholds, because two different questions are asked of this volume.
  //
  // `solid` - the 80th percentile of the voxels that hold anything, the same
  // rule scripts/path-vs-splat.ts uses - answers "is the camera buried in
  // geometry", which has to be strict or every frame near a wall trips it.
  //
  // `matter` answers "would a viewer see a surface here", which has to be
  // lenient, because a wall observed from across the room returns a fraction of
  // the density it returns from arm's length. MIN_COLUMN_MASS is the bar the
  // rest of the pipeline already uses for "something was observed here"
  // (scripts/spz-collider.mjs); reusing it keeps the two agreeing about what
  // counts as a surface.
  const occupiedValues: number[] = [];
  for (let i = 0; i < data.length; i++) if (data[i] > 0) occupiedValues.push(data[i]);
  occupiedValues.sort((p, q) => p - q);
  const solid = occupiedValues.length
    ? occupiedValues[Math.floor(occupiedValues.length * 0.8)]
    : Infinity;

  return { cell, nx, ny, nz, min, data, solid, matter: MIN_COLUMN_MASS, occupied: occupiedValues.length };
}

function densityAt(v: DensityVolume, x: number, y: number, z: number): number {
  const ix = Math.floor((x - v.min.x) / v.cell);
  const iy = Math.floor((y - v.min.y) / v.cell);
  const iz = Math.floor((z - v.min.z) / v.cell);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= v.nx || iy >= v.ny || iz >= v.nz) return -1;
  return v.data[(iy * v.nz + iz) * v.nx + ix];
}

/** Total density in a vertical slab over one point. -1 outside the volume. */
function columnMass(v: DensityVolume, x: number, z: number, y0: number, y1: number): number {
  let sum = 0;
  let any = false;
  for (let y = y0; y <= y1; y += v.cell) {
    const d = densityAt(v, x, y, z);
    if (d < 0) continue;
    any = true;
    sum += d;
  }
  return any ? sum : -1;
}

/* -------------------------------------------------------------------------- */
/* coverage                                                                   */
/* -------------------------------------------------------------------------- */

type Coverage = {
  walkableCells: number;
  cellArea: number;
  supported: number;
  unsupported: number;
  supportedFraction: number;
  largestGapCells: number;
  largestGapArea: number;
  /** Where that hole is, in world x/z, so it can be found on the plan. */
  largestGapAt: [number, number] | null;
  enclosureSamples: number;
  enclosureMean: number;
  openDirections: number;
  /** Median distance an eye-height ray travels before it meets a surface. */
  medianFreePath: number;
};

/**
 * Two independent readings of "is this space filled in".
 *
 * FLOOR SUPPORT answers it downwards: for every cell the router is willing to
 * stand on, is there splat mass in a slab around that cell's own floor height.
 * A walkable cell with nothing under it is a hole you fall through on camera -
 * the collider believes in a floor the capture never rendered.
 *
 * ENCLOSURE answers it outwards: from a sample of those cells, at eye height,
 * cast rays in every horizontal direction and see how many run out of the
 * capture without ever crossing solid matter. A sealed interior stops every
 * ray. The hobbiton complaint - open sky where a wall should be - is a low
 * number here, and it is invisible to floor support, which is why both exist.
 */
function measureCoverage(grid: WalkGrid, volume: DensityVolume): Coverage {
  const total = grid.cols * grid.rows;
  const walkable: number[] = [];
  for (let i = 0; i < total; i++) if (grid.floor[i] && !grid.blocked[i]) walkable.push(i);

  const unsupportedMask = new Uint8Array(total);
  let supported = 0;

  for (const i of walkable) {
    const col = i % grid.cols;
    const row = (i / grid.cols) | 0;
    const w = cellToWorld(grid, col, row);
    const floorY = Number.isFinite(grid.floorY[i]) ? grid.floorY[i] : grid.medianFloorY;
    const mass = columnMass(volume, w.x, w.z, floorY + FLOOR_BAND.low, floorY + FLOOR_BAND.high);
    if (mass >= MIN_COLUMN_MASS) supported++;
    else unsupportedMask[i] = 1;
  }

  // Largest hole, not total hole area: a hundred scattered single cells is a
  // noisy capture, one contiguous 6 m^2 void is a room with no floor, and the
  // sum cannot tell them apart.
  let largestGapCells = 0;
  let largestGapAt: [number, number] | null = null;
  const seen = new Uint8Array(total);
  const stack: number[] = [];
  for (let seed = 0; seed < total; seed++) {
    if (!unsupportedMask[seed] || seen[seed]) continue;
    let size = 0;
    let sumX = 0;
    let sumZ = 0;
    stack.push(seed);
    seen[seed] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      const cx = cur % grid.cols;
      const cz = (cur / grid.cols) | 0;
      const w = cellToWorld(grid, cx, cz);
      sumX += w.x;
      sumZ += w.z;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= grid.cols || nz < 0 || nz >= grid.rows) continue;
        const ni = cellIndex(grid, nx, nz);
        if (unsupportedMask[ni] && !seen[ni]) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (size > largestGapCells) {
      largestGapCells = size;
      largestGapAt = [sumX / size, sumZ / size];
    }
  }

  /* enclosure */
  const step = Math.max(1, Math.floor(walkable.length / 400));
  const reach = Math.hypot(
    volume.nx * volume.cell,
    volume.nz * volume.cell,
  );
  let rays = 0;
  let open = 0;
  // How far a ray gets before it meets something. A flat cut into rooms stops
  // its rays in two or three metres; one undivided volume does not. It is the
  // cheapest test of whether the layout sentence's partitions were actually
  // built, as opposed to being echoed back in the caption.
  const freePaths: number[] = [];

  for (let k = 0; k < walkable.length; k += step) {
    const i = walkable[k];
    const col = i % grid.cols;
    const row = (i / grid.cols) | 0;
    const w = cellToWorld(grid, col, row);
    const floorY = Number.isFinite(grid.floorY[i]) ? grid.floorY[i] : grid.medianFloorY;
    const eye = floorY + EYE_HEIGHT;

    for (let d = 0; d < RAY_DIRECTIONS; d++) {
      const angle = (d / RAY_DIRECTIONS) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      rays++;
      let hit = false;
      for (let t = volume.cell; t < reach; t += volume.cell) {
        const density = densityAt(volume, w.x + dx * t, eye, w.z + dz * t);
        if (density < 0) break;
        if (density >= volume.matter) { hit = true; freePaths.push(t); break; }
      }
      if (!hit) open++;
    }
  }

  const cellArea = grid.cellSize * grid.cellSize;
  return {
    walkableCells: walkable.length,
    cellArea,
    supported,
    unsupported: walkable.length - supported,
    supportedFraction: walkable.length ? supported / walkable.length : 0,
    largestGapCells,
    largestGapArea: largestGapCells * cellArea,
    largestGapAt,
    enclosureSamples: Math.ceil(walkable.length / step),
    enclosureMean: rays ? 1 - open / rays : 0,
    openDirections: open,
    medianFreePath: freePaths.length
      ? freePaths.sort((p, q) => p - q)[freePaths.length >> 1]
      : Infinity,
  };
}

/* -------------------------------------------------------------------------- */
/* routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Waypoints placed the way the UI places them: snapped into the reachable
 * region, spread apart. Sampling raw passable cells would test legs a user can
 * never create and then blame the router for the straight-line fallback.
 */
function spreadWaypoints(grid: WalkGrid, count: number): {
  spots: Vec3[];
  radius: number;
  relaxed: boolean;
  regionsAtRequest: number;
  reachable: number;
  regions: number;
} {
  const atRequest = cachedConnectivity(grid, 0.3);
  const resolved = resolveCameraRadius(grid, 0.3);
  const reach = reachableMask(grid, resolved.radius);
  const spots: Vec3[] = [];
  const minSeparation = Math.max(1.5, Math.min(grid.cols, grid.rows) * grid.cellSize * 0.18);

  for (let pass = 0; pass < 2 && spots.length < count; pass++) {
    const wanted = pass === 0 ? minSeparation : minSeparation * 0.4;
    for (let i = 0; i < grid.cols * grid.rows && spots.length < count; i++) {
      const c = i % grid.cols;
      const r = (i / grid.cols) | 0;
      if (!reach.mask[cellIndex(grid, c, r)]) continue;
      const w = cellToWorld(grid, c, r);
      if (spots.every((s) => Math.hypot(s[0] - w.x, s[2] - w.z) > wanted)) {
        spots.push([w.x, 0, w.z]);
      }
    }
  }
  return {
    spots,
    radius: resolved.radius,
    relaxed: resolved.relaxed,
    regionsAtRequest: atRequest.regions,
    reachable: reach.cells,
    regions: reach.regions,
  };
}

/* -------------------------------------------------------------------------- */
/* report                                                                     */
/* -------------------------------------------------------------------------- */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { cell: { type: 'string' }, json: { type: 'boolean' } },
});

const target = positionals[0];
if (!target) {
  process.stderr.write('usage: scene-quality.ts <scene-id|dir> [--cell 0.25] [--json]\n');
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, '..');
const dir = target.includes('/') ? resolve(target) : join(ROOT, 'public', 'generated', target);
const sceneId = basename(dir);
const CELL = Number(values.cell ?? 0.25);

const scene = JSON.parse(await readFile(join(dir, 'scene.json'), 'utf8')) as {
  splatTransform?: Placement;
  world?: { id?: string; model?: string };
  files?: { splat?: { file?: string; spzKey?: string }; collider?: { file?: string } };
};
const placement = scene.splatTransform ?? IDENTITY;
const splatPath = join(dir, scene.files?.splat?.file ?? 'room.spz');
const colliderPath = join(dir, scene.files?.collider?.file ?? 'collider.glb');

const out = (line = '') => process.stdout.write(`${line}\n`);
const m2 = (n: number) => `${n.toFixed(1)} m2`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

out(`=== ${sceneId} ===`);
out(`dir              ${relative(ROOT, dir)}`);
out(`world            ${scene.world?.id ?? '(unknown)'}  ${scene.world?.model ?? ''}`);
out(
  `placement        scale ${placement.scale}  y+${placement.position[1]}  ` +
    `rotX ${placement.rotation[0].toFixed(3)}`,
);

/* ------------------------------- 1. splat -------------------------------- */

const splatBytes = (await stat(splatPath)).size;
const field = await readSplatField(splatPath, placement);
const extent = field.max.clone().sub(field.min);
const core = field.coreMax.clone().sub(field.coreMin);

out();
out('-- splat --');
out(`file             ${basename(splatPath)}  ${(splatBytes / 1e6).toFixed(1)} MB` +
    `${scene.files?.splat?.spzKey ? `  (${scene.files.splat.spzKey})` : ''}`);
out(`parse            SPZ v${field.version}, layout OK (readSpz throws on mismatch)`);
out(`points           ${field.n.toLocaleString()}  (${field.kept.toLocaleString()} at opacity >= ${MIN_OPACITY}, ${pct(field.kept / field.n)})`);
out(`sh degree        ${field.shDegree}   fractional bits ${field.fractionalBits}`);
out(`bytes per point  ${(splatBytes / field.n).toFixed(1)}`);
out(`extent (metric)  ${extent.x.toFixed(1)} x ${extent.y.toFixed(1)} x ${extent.z.toFixed(1)} m  (every splat, outliers included)`);
out(`core extent      ${core.x.toFixed(1)} x ${core.y.toFixed(1)} x ${core.z.toFixed(1)} m  (middle 99% per axis)`);
out(`floor area       ${m2(core.x * core.z)} over the core  ->  ${(field.kept / (core.x * core.z)).toFixed(0)} opaque splats per m2`);

/* ------------------------------ 2. collider ------------------------------ */

const colliderBytes = await readFile(colliderPath);
const inspection = inspectGlb(colliderBytes);
const loader = await verifyColliderWithLoader(colliderBytes);

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const arrayBuffer = colliderBytes.buffer.slice(
  colliderBytes.byteOffset,
  colliderBytes.byteOffset + colliderBytes.byteLength,
) as ArrayBuffer;
const collider: ColliderData = await new Promise((ok, fail) => {
  new GLTFLoader().parse(arrayBuffer, '', (gltf) => {
    // Mirrors lib/scene/loaders.ts: the placement is baked in BEFORE the mesh
    // is flattened, so the grid below is metric.
    const root = gltf.scene;
    root.scale.setScalar(placement.scale);
    root.rotation.set(placement.rotation[0], placement.rotation[1], placement.rotation[2]);
    root.position.set(placement.position[0], placement.position[1], placement.position[2]);
    root.updateMatrixWorld(true);
    ok(buildColliderData(root));
  }, fail);
});

const grid = buildWalkGrid(collider);
const stats = gridStats(grid);
const cellArea = grid.cellSize * grid.cellSize;

out();
out('-- collider --');
out(`file             ${basename(colliderPath)}  ${(colliderBytes.byteLength / 1e6).toFixed(1)} MB`);
out(`glb              ${inspection.meshCount} mesh(es), ${inspection.primitiveCount} primitive(s): ${inspection.meshNames.join(', ')}`);
out(`GLTFLoader       LOADS, ${loader.triangles.toLocaleString()} triangles`);
out(`classified as    floor ${collider.floorMeshes.map((m) => m.name).join(', ') || '(none)'} / obstacles ${collider.obstacleMeshes.map((m) => m.name).join(', ') || '(none)'}`);
out(`walk grid        ${grid.cols} x ${grid.rows} @ ${grid.cellSize.toFixed(3)} m`);
out(`  floor          ${stats.floorCells} cells  ${m2(stats.floorCells * cellArea)}`);
out(`  blocked        ${stats.blockedCells} cells  ${m2(stats.blockedCells * cellArea)}`);
out(`  walkable       ${stats.walkableCells} cells  ${m2(stats.walkableCells * cellArea)}  (${pct(stats.floorCells ? stats.walkableCells / stats.floorCells : 0)} of floor)`);
out(`  occupancy      ${pct(stats.cells ? stats.floorCells / stats.cells : 0)} of the grid rectangle has floor`);

/* ------------------------------ 3. coverage ------------------------------ */

const volume = buildDensity(field, CELL);
const coverage = measureCoverage(grid, volume);

out();
out('-- coverage / holes --');
out(`density voxels   ${volume.nx} x ${volume.ny} x ${volume.nz} @ ${CELL} m, ${volume.occupied.toLocaleString()} occupied; surface >= ${volume.matter.toFixed(2)}, solid >= ${volume.solid.toFixed(2)}`);
out(`floor support    ${coverage.supported}/${coverage.walkableCells} walkable cells have splats on the floor  ${pct(coverage.supportedFraction)}`);
out(`unsupported      ${coverage.unsupported} cells  ${m2(coverage.unsupported * coverage.cellArea)}`);
out(`largest hole     ${coverage.largestGapCells} cells  ${m2(coverage.largestGapArea)}` +
    (coverage.largestGapAt
      ? `  centred on x ${coverage.largestGapAt[0].toFixed(1)}, z ${coverage.largestGapAt[1].toFixed(1)}`
      : ''));
out(`enclosure        ${pct(coverage.enclosureMean)} of ${RAY_DIRECTIONS} eye-height rays from ${coverage.enclosureSamples} points hit solid matter`);
out(`                 (${coverage.openDirections} rays left the capture without hitting anything)`);
out(`median sightline ${coverage.medianFreePath.toFixed(1)} m before a ray meets a surface`);

/* ------------------------------- 4. routing ------------------------------ */

const { spots, radius, relaxed, regionsAtRequest, reachable, regions } = spreadWaypoints(grid, 5);
out();
out('-- routing --');
out(`camera radius    ${radius.toFixed(2)} m${relaxed ? `  (RELAXED from 0.30 m, which left ${regionsAtRequest} regions)` : ''}`);
out(`reachable        largest region ${reachable} cells  ${m2(reachable * cellArea)}  = ${pct(stats.walkableCells ? reachable / stats.walkableCells : 0)} of walkable floor, ${regions} region(s) in total`);

if (spots.length < 2) {
  out('waypoints        FEWER THAN 2 REACHABLE SPOTS - no path can be generated');
} else {
  const waypoints: Waypoint[] = spots.map((p, i) => ({
    id: `w${i + 1}`,
    position: p,
    shotType: 'orbit',
    mode: 'auto',
    duration: 4,
    emphasis: 1,
    aim: null,
    pinned: false,
  }));
  const path = generatePath(
    { collider, waypoints, settings: { style: 'realEstate' } },
    createPathCache(),
  );

  let insideSolid = 0;
  let inOccupied = 0;
  let offFloor = 0;
  for (const frame of path.frames) {
    const d = densityAt(volume, frame.position[0], frame.position[1], frame.position[2]);
    if (d >= volume.solid) insideSolid++;
    else if (d > 0) inOccupied++;
    const { col, row } = worldToCell(grid, frame.position[0], frame.position[2]);
    if (!grid.floor[cellIndex(grid, col, row)]) offFloor++;
  }

  out(`waypoints        ${waypoints.length} spread over the reachable region`);
  out(`path             ${path.frames.length} frames, ${path.duration}s @ ${path.fps} fps, ${path.segments.length} segments`);
  out(`shots            ${path.shots.map((s) => s.shotType).join(', ')}`);
  out(`frames in solid  ${insideSolid} (${pct(insideSolid / path.frames.length)})  merely occupied ${inOccupied} (${pct(inOccupied / path.frames.length)})`);
  out(`frames off floor ${offFloor} (${pct(offFloor / path.frames.length)})`);
  out(`warnings         ${path.warnings.length}`);
  for (const w of path.warnings) out(`  [${w.severity}] ${w.code}: ${w.message}`);

  if (values.json) {
    out();
    out(JSON.stringify({
      sceneId,
      splat: { bytes: splatBytes, points: field.n, opaque: field.kept, shDegree: field.shDegree, extent: extent.toArray() },
      collider: { bytes: colliderBytes.byteLength, triangles: loader.triangles, meshes: inspection.meshCount },
      grid: { ...stats, cellSize: grid.cellSize, cols: grid.cols, rows: grid.rows },
      coverage,
      routing: { frames: path.frames.length, duration: path.duration, insideSolid, offFloor, warnings: path.warnings.map((w) => w.code) },
    }));
  }
}
