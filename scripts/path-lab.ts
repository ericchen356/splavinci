/**
 * Headless harness for the path generator.
 *
 *   npx tsx scripts/path-lab.ts
 *
 * Loads the real collider.glb off disk, builds the walk grid, and renders it as
 * ASCII so grid/A* bugs are visible without a browser.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildColliderData } from '@/lib/scene/collider';
import {
  buildWalkGrid, gridStats, cellIndex, worldToCell, cellToWorld, floorYAtCell,
  type WalkGrid,
} from '@/lib/path/grid';
import { findPath, simplifyPath, DEFAULT_ASTAR } from '@/lib/path/astar';
import { DEFAULT_FOV } from '@/lib/pose';
import type { Vec3, Waypoint } from '@/lib/types';

/**
 * Floor spots -> captured camera poses.
 *
 * The screens no longer produce waypoints from floor points, so a script that
 * builds them from floor points is testing a shape the app cannot make. This
 * stands in for the capture key: flown to eye height above each spot and
 * pointed at the next stop, which is what someone walking a route and pressing
 * F at each stop would actually record.
 *
 * Pass `pitch` to stand in for a capture taken looking down - the case the
 * elevated branch of the shot rule exists for.
 */
export function poseWaypoints(
  grid: WalkGrid,
  spots: readonly Vec3[],
  options: { height?: number; pitch?: number } = {},
): Waypoint[] {
  const height = options.height ?? 1.55;
  const pitch = options.pitch ?? 0;
  const lift = (p: Vec3): Vec3 => {
    const { col, row } = worldToCell(grid, p[0], p[2]);
    return [p[0], floorYAtCell(grid, col, row, grid.medianFloorY) + height, p[2]];
  };

  return spots.map((spot, i) => {
    const position = lift(spot);
    /* Facing: at the next stop, and for the last one straight on past it.
     *
     * Deliberately not "back at the previous stop", which is what a naive
     * fallback gives and which plants a 180 degree reversal at the end of every
     * fixture route - a case worth testing on purpose, never by accident. A
     * lone waypoint has no neighbour at all and faces +x, stated here rather
     * than left to fall out of an atan2 of two zeroes. */
    const next = spots[i + 1];
    const previous = spots[i - 1];
    const yaw = next
      ? Math.atan2(next[2] - position[2], next[0] - position[0])
      : previous
        ? Math.atan2(position[2] - previous[2], position[0] - previous[0])
        : 0;
    return {
      id: `w${i + 1}`,
      position,
      yaw,
      pitch,
      fov: DEFAULT_FOV,
      mode: 'auto',
      shotType: 'orbit',
      duration: 4,
      emphasis: 1,
      aim: null,
      ignoreWalls: false,
      pinned: false,
    };
  });
}

export function loadColliderFromDisk(path: string) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Promise<ReturnType<typeof buildColliderData>>((resolve, reject) => {
    new GLTFLoader().parse(ab, '', (gltf) => resolve(buildColliderData(gltf.scene)), reject);
  });
}

/** Render the grid as ASCII, downsampled to fit a terminal. */
export function renderGrid(
  grid: WalkGrid,
  marks: { x: number; z: number; ch: string }[] = [],
  maxCols = 108,
): string {
  const step = Math.max(1, Math.ceil(grid.cols / maxCols));
  const marked = new Map<string, string>();
  for (const m of marks) {
    const { col, row } = worldToCell(grid, m.x, m.z);
    marked.set(`${Math.floor(col / step)},${Math.floor(row / step)}`, m.ch);
  }

  const lines: string[] = [];
  for (let r = 0; r < grid.rows; r += step) {
    let line = '';
    for (let c = 0; c < grid.cols; c += step) {
      const key = `${Math.floor(c / step)},${Math.floor(r / step)}`;
      const mark = marked.get(key);
      if (mark) { line += mark; continue; }

      // Sample the step x step block: blocked wins, then floor, then void.
      let anyBlocked = false;
      let anyFloor = false;
      let clearSum = 0;
      let n = 0;
      for (let rr = r; rr < Math.min(r + step, grid.rows); rr++) {
        for (let cc = c; cc < Math.min(c + step, grid.cols); cc++) {
          const i = cellIndex(grid, cc, rr);
          if (grid.blocked[i]) anyBlocked = true;
          if (grid.floor[i]) anyFloor = true;
          if (Number.isFinite(grid.clearance[i])) { clearSum += grid.clearance[i]; n++; }
        }
      }
      if (anyBlocked) line += '#';
      else if (!anyFloor) line += ' ';
      else {
        const avg = n > 0 ? clearSum / n : 0;
        line += avg < 0.3 ? '.' : avg < 0.8 ? '-' : '+';
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('path-lab.ts')) {
  const colliderPath = process.argv[2] ?? 'public/sample-room/collider.glb';
  const collider = await loadColliderFromDisk(colliderPath);
  console.log('collider file   :', colliderPath);
  console.log('collider meshes :', collider.meshNames.join(', '));
  console.log('floor meshes    :', collider.floorMeshes.map((m) => m.name).join(', '));
  console.log('obstacles       :', collider.obstacleMeshes.map((m) => m.name).join(', '));
  console.log('triangles       :', collider.triangleCount);

  const grid = buildWalkGrid(collider);
  console.log('\ngrid            :', grid.cols, 'x', grid.rows, '@', grid.cellSize.toFixed(4), 'm');
  console.log('band            : floor +', grid.band.low, '..', grid.band.high);
  console.log('stats           :', JSON.stringify(gridStats(grid)));
  console.log('\nlegend: # wall/obstacle   . tight   - mid   + open   (blank = no floor)\n');

  // Hardest route in the fixture: living room -> kitchen nook (around the
  // divider) -> bedroom (through the single doorway).
  const route: [number, number][] = [[1.6, 2.2], [1.5, 7.1], [9.0, 6.2]];
  const marks: { x: number; z: number; ch: string }[] = [];
  let totalCells = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const a = worldToCell(grid, route[i][0], route[i][1]);
    const b = worldToCell(grid, route[i + 1][0], route[i + 1][1]);
    const res = findPath(grid, a, b, { radius: 0.3 });
    console.log(
      `leg ${i}: (${route[i]}) -> (${route[i + 1]})  found=${res.found}` +
      `  cells=${res.cells.length}  expanded=${res.expanded}` +
      `  snapped=${res.snappedStart}/${res.snappedGoal}  failure=${res.failure}`,
    );
    if (!res.found) continue;
    totalCells += res.cells.length;
    const simple = simplifyPath(grid, res.cells, 0.3);
    console.log(`        simplified ${res.cells.length} -> ${simple.length} nodes`);
    for (const c of res.cells) {
      const w = cellToWorld(grid, c.col, c.row);
      marks.push({ x: w.x, z: w.z, ch: 'o' });
    }
    for (const c of simple) {
      const w = cellToWorld(grid, c.col, c.row);
      marks.push({ x: w.x, z: w.z, ch: 'O' });
    }
  }
  for (const [x, z] of route) marks.push({ x, z, ch: '@' });

  console.log(`\ntotal path cells: ${totalCells}`);
  console.log('legend: @ waypoint   O simplified node   o raw path\n');
  console.log(renderGrid(grid, marks));
}
