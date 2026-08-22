/**
 * Step 1 of path generation: flatten the collider mesh into a 2D walkable grid.
 *
 * The grid is the substrate every later step reads, so it carries more than a
 * blocked/clear bit per cell:
 *   - `floor`     does anything walkable exist under this cell
 *   - `floorY`    the floor height there, so waypoints and camera samples can
 *                 sit a fixed distance above an uneven surface
 *   - `blocked`   an obstacle intersects the camera's vertical corridor here
 *   - `clearance` world-space distance to the nearest blocked/void cell
 *
 * `clearance` is what keeps the later A* honest: it is used both as a hard gate
 * (a camera with a body radius cannot occupy a cell closer to a wall than that)
 * and as a soft cost (all else equal, prefer the middle of a room to scraping
 * along a wall). Computing it once here means A* never has to re-derive it.
 *
 * Nothing here is fixture-specific: cell size and the height band are derived
 * from the collider's own bounds, so a 10 m apartment and a 60 m landscape both
 * come out at a workable resolution.
 */

import * as THREE from 'three';
import type { ColliderData } from '@/lib/scene/collider';

export type WalkGrid = {
  cellSize: number;
  cols: number;
  rows: number;
  /** World X of the centre of column 0. */
  originX: number;
  /** World Z of the centre of row 0. */
  originZ: number;
  /** 1 where an obstacle intersects the camera corridor. */
  blocked: Uint8Array;
  /** 1 where walkable floor exists. */
  floor: Uint8Array;
  /** Floor height per cell; NaN where there is no floor. */
  floorY: Float32Array;
  /** World-space distance to the nearest blocked-or-void cell. */
  clearance: Float32Array;
  bounds: THREE.Box3;
  /** Camera corridor, as offsets above each cell's OWN floor height. */
  band: { low: number; high: number };
};

export type GridOptions = {
  /** Explicit cell size in world units. Derived from bounds when omitted. */
  cellSize?: number;
  /** Target cells along the longest horizontal axis when deriving cell size. */
  targetResolution?: number;
  /** Bottom of the obstacle test band, above the floor. */
  bandLow?: number;
  /** Top of the obstacle test band, above the floor. */
  bandHigh?: number;
};

const DEFAULTS = {
  targetResolution: 160,
  minCellSize: 0.05,
  maxCellSize: 1.0,
  bandLow: 0.25,
  bandHigh: 2.1,
};

/** Pick a cell size that resolves the scene without exploding the cell count. */
export function deriveCellSize(bounds: THREE.Box3, targetResolution = DEFAULTS.targetResolution): number {
  const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
  if (!Number.isFinite(extent) || extent <= 0) return 0.25;
  return clamp(extent / targetResolution, DEFAULTS.minCellSize, DEFAULTS.maxCellSize);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------- */
/* triangle rasterisation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Conservative 2D triangle-vs-cell-AABB overlap (separating axis test).
 * Conservative matters: a wall one third of a cell thick still has to block,
 * and a centre-point sample would let the camera walk straight through it.
 */
function triangleOverlapsCell(
  ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
  minX: number, minZ: number, maxX: number, maxZ: number,
): boolean {
  // Axis 1/2: the cell's own axes.
  if (Math.min(ax, bx, cx) > maxX || Math.max(ax, bx, cx) < minX) return false;
  if (Math.min(az, bz, cz) > maxZ || Math.max(az, bz, cz) < minZ) return false;

  // Axis 3: each triangle edge normal.
  const ex = [bx - ax, cx - bx, ax - cx];
  const ez = [bz - az, cz - bz, az - cz];
  const px = [ax, bx, cx];
  const pz = [az, bz, cz];

  for (let i = 0; i < 3; i++) {
    // Edge normal (in 2D, perpendicular of the edge).
    const nx = -ez[i];
    const nz = ex[i];

    let triMin = Infinity;
    let triMax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const d = nx * px[k] + nz * pz[k];
      if (d < triMin) triMin = d;
      if (d > triMax) triMax = d;
    }

    let boxMin = Infinity;
    let boxMax = -Infinity;
    for (const [qx, qz] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]] as const) {
      const d = nx * qx + nz * qz;
      if (d < boxMin) boxMin = d;
      if (d > boxMax) boxMax = d;
    }

    if (triMin > boxMax || triMax < boxMin) return false;
  }
  return true;
}

type TriVisitor = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
) => void;

function forEachTriangle(geometry: THREE.BufferGeometry, visit: TriVisitor): void {
  const pos = geometry.getAttribute('position');
  if (!pos) return;
  // buildColliderData hands us non-indexed world-space soup.
  for (let i = 0; i + 2 < pos.count; i += 3) {
    visit(
      pos.getX(i), pos.getY(i), pos.getZ(i),
      pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1),
      pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* distance transform                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Two-pass chamfer distance transform (3-4 kernel), in cell units.
 * Seeds at every non-walkable cell, so the result is "how far to the nearest
 * wall or void". Approximate, but within a few percent of true Euclidean and
 * O(cells) instead of O(cells x obstacles).
 */
function chamferDistance(walkable: Uint8Array, cols: number, rows: number): Float32Array {
  const D_ORTH = 3;
  const D_DIAG = 4;
  const BIG = 1e9;
  const d = new Float32Array(cols * rows);

  for (let i = 0; i < d.length; i++) d[i] = walkable[i] ? BIG : 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      let best = d[i];
      if (c > 0) best = Math.min(best, d[i - 1] + D_ORTH);
      if (r > 0) best = Math.min(best, d[i - cols] + D_ORTH);
      if (r > 0 && c > 0) best = Math.min(best, d[i - cols - 1] + D_DIAG);
      if (r > 0 && c < cols - 1) best = Math.min(best, d[i - cols + 1] + D_DIAG);
      d[i] = best;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (d[i] === 0) continue;
      let best = d[i];
      if (c < cols - 1) best = Math.min(best, d[i + 1] + D_ORTH);
      if (r < rows - 1) best = Math.min(best, d[i + cols] + D_ORTH);
      if (r < rows - 1 && c < cols - 1) best = Math.min(best, d[i + cols + 1] + D_DIAG);
      if (r < rows - 1 && c > 0) best = Math.min(best, d[i + cols - 1] + D_DIAG);
      d[i] = best;
    }
  }

  // Chamfer works in thirds of a cell; convert back to cells.
  for (let i = 0; i < d.length; i++) d[i] = d[i] === BIG ? BIG : d[i] / D_ORTH;
  return d;
}

/* -------------------------------------------------------------------------- */
/* build                                                                       */
/* -------------------------------------------------------------------------- */

export function buildWalkGrid(collider: ColliderData, options: GridOptions = {}): WalkGrid {
  const bounds = collider.bounds.clone();
  const cellSize = options.cellSize ?? deriveCellSize(bounds, options.targetResolution);

  const cols = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / cellSize));
  const rows = Math.max(1, Math.ceil((bounds.max.z - bounds.min.z) / cellSize));
  const originX = bounds.min.x + cellSize / 2;
  const originZ = bounds.min.z + cellSize / 2;

  const count = cols * rows;
  const blocked = new Uint8Array(count);
  const floor = new Uint8Array(count);
  const floorY = new Float32Array(count).fill(NaN);

  // The corridor is expressed as offsets above each cell's own floor, not as
  // absolute world heights - see the obstacle pass below for why.
  const band = {
    low: options.bandLow ?? DEFAULTS.bandLow,
    high: options.bandHigh ?? DEFAULTS.bandHigh,
  };

  const rasterise = (
    geometry: THREE.BufferGeometry,
    onCell: (index: number, triMinY: number, triMaxY: number) => void,
  ) => {
    forEachTriangle(geometry, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const triMinY = Math.min(ay, by, cy);
      const triMaxY = Math.max(ay, by, cy);

      const loX = Math.min(ax, bx, cx);
      const hiX = Math.max(ax, bx, cx);
      const loZ = Math.min(az, bz, cz);
      const hiZ = Math.max(az, bz, cz);

      const c0 = clampInt(Math.floor((loX - bounds.min.x) / cellSize), 0, cols - 1);
      const c1 = clampInt(Math.ceil((hiX - bounds.min.x) / cellSize), 0, cols - 1);
      const r0 = clampInt(Math.floor((loZ - bounds.min.z) / cellSize), 0, rows - 1);
      const r1 = clampInt(Math.ceil((hiZ - bounds.min.z) / cellSize), 0, rows - 1);

      for (let r = r0; r <= r1; r++) {
        const cellMinZ = bounds.min.z + r * cellSize;
        const cellMaxZ = cellMinZ + cellSize;
        for (let c = c0; c <= c1; c++) {
          const cellMinX = bounds.min.x + c * cellSize;
          const cellMaxX = cellMinX + cellSize;
          if (!triangleOverlapsCell(ax, az, bx, bz, cx, cz, cellMinX, cellMinZ, cellMaxX, cellMaxZ)) {
            continue;
          }
          onCell(r * cols + c, triMinY, triMaxY);
        }
      }
    });
  };

  // Floor first: presence, and the highest surface seen per cell.
  rasterise(collider.floorGeometry, (i, _triMinY, triMaxY) => {
    floor[i] = 1;
    if (Number.isNaN(floorY[i]) || triMaxY > floorY[i]) floorY[i] = triMaxY;
  });

  const fallbackFloorY = Number.isFinite(collider.floorBounds.max.y)
    ? collider.floorBounds.max.y
    : bounds.min.y;

  // Obstacles: accumulate the vertical span of obstacle geometry over each
  // cell, then test that span against the band above THAT CELL'S OWN floor.
  //
  // Per cell, and against local floor height, for two distinct reasons:
  //
  //  - A solid wall's side faces project to thin lines in XZ, while its top and
  //    bottom caps sit outside the corridor. Filtering triangles individually
  //    rasterises only those slivers and leaves the wall's interior walkable -
  //    a phantom corridor straight through it once cells are coarse enough.
  //    Accumulating a span per cell lets the caps contribute their heights
  //    across the whole footprint, so the interior blocks like the solid it is.
  //  - A single global band assumes a flat floor. On terrain derived from a
  //    real capture the ground can climb many metres across the scene, and a
  //    band pinned to the highest floor point floats above everything: nothing
  //    intersects it and not one cell comes out blocked.
  const obstacleMinY = new Float32Array(count).fill(Infinity);
  const obstacleMaxY = new Float32Array(count).fill(-Infinity);
  rasterise(collider.obstacleGeometry, (i, triMinY, triMaxY) => {
    if (triMinY < obstacleMinY[i]) obstacleMinY[i] = triMinY;
    if (triMaxY > obstacleMaxY[i]) obstacleMaxY[i] = triMaxY;
  });

  for (let i = 0; i < count; i++) {
    if (obstacleMaxY[i] === -Infinity) continue;
    const base = Number.isNaN(floorY[i]) ? fallbackFloorY : floorY[i];
    if (obstacleMaxY[i] >= base + band.low && obstacleMinY[i] <= base + band.high) {
      blocked[i] = 1;
    }
  }

  const walkable = new Uint8Array(count);
  for (let i = 0; i < count; i++) walkable[i] = floor[i] && !blocked[i] ? 1 : 0;

  const clearanceCells = chamferDistance(walkable, cols, rows);
  const clearance = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    clearance[i] = clearanceCells[i] >= 1e9 ? Infinity : clearanceCells[i] * cellSize;
  }

  return {
    cellSize, cols, rows, originX, originZ,
    blocked, floor, floorY, clearance, bounds, band,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

export function cellIndex(grid: WalkGrid, col: number, row: number): number {
  return row * grid.cols + col;
}

export function inGrid(grid: WalkGrid, col: number, row: number): boolean {
  return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows;
}

export function worldToCell(grid: WalkGrid, x: number, z: number): { col: number; row: number } {
  return {
    col: clampInt(Math.floor((x - grid.bounds.min.x) / grid.cellSize), 0, grid.cols - 1),
    row: clampInt(Math.floor((z - grid.bounds.min.z) / grid.cellSize), 0, grid.rows - 1),
  };
}

export function cellToWorld(grid: WalkGrid, col: number, row: number): { x: number; z: number } {
  return { x: grid.originX + col * grid.cellSize, z: grid.originZ + row * grid.cellSize };
}

/** Walkable at all (has floor, no obstacle) — ignores clearance. */
export function isWalkable(grid: WalkGrid, col: number, row: number): boolean {
  if (!inGrid(grid, col, row)) return false;
  const i = cellIndex(grid, col, row);
  return grid.floor[i] === 1 && grid.blocked[i] === 0;
}

/** Walkable *and* far enough from any wall for a camera of the given radius. */
export function isPassable(grid: WalkGrid, col: number, row: number, radius: number): boolean {
  if (!isWalkable(grid, col, row)) return false;
  return grid.clearance[cellIndex(grid, col, row)] >= radius;
}

/**
 * Nearest cell satisfying `ok`, searched in rings outward.
 * Used to rescue a waypoint the user dropped inside a wall or off the floor.
 */
export function findNearestCell(
  grid: WalkGrid,
  col: number,
  row: number,
  ok: (c: number, r: number) => boolean,
  maxRadiusCells = 64,
): { col: number; row: number } | null {
  if (ok(col, row)) return { col, row };
  for (let ring = 1; ring <= maxRadiusCells; ring++) {
    for (let d = -ring; d <= ring; d++) {
      const candidates: [number, number][] = [
        [col + d, row - ring], [col + d, row + ring],
        [col - ring, row + d], [col + ring, row + d],
      ];
      for (const [c, r] of candidates) {
        if (inGrid(grid, c, r) && ok(c, r)) return { col: c, row: r };
      }
    }
  }
  return null;
}

/** Floor height at a world point, falling back to the grid's dominant floor. */
export function floorYAtCell(grid: WalkGrid, col: number, row: number, fallback: number): number {
  if (!inGrid(grid, col, row)) return fallback;
  const y = grid.floorY[cellIndex(grid, col, row)];
  return Number.isNaN(y) ? fallback : y;
}

/**
 * Conservative ("supercover") line-of-sight between two cell centres.
 *
 * Deliberately NOT Bresenham. Bresenham selects a single cell per step, so a
 * segment that clips the corner of a cell is reported as clear - and string
 * pulling then collapses a path onto a straight run that grazes a wall. Every
 * cell the segment actually touches has to be tested, which is what the
 * Amanatides-Woo grid traversal below does.
 *
 * Exact diagonal crossings additionally require both orthogonal neighbours to
 * be passable, matching the no-corner-cutting rule A* uses, so the two stages
 * cannot disagree about whether a corner is traversable.
 */
export function hasLineOfSight(
  grid: WalkGrid,
  c0: number, r0: number, c1: number, r1: number,
  radius: number,
): boolean {
  if (!isPassable(grid, c0, r0, radius)) return false;
  if (c0 === c1 && r0 === r1) return true;

  // Work in cell units, starting from the centre of the origin cell.
  const dx = c1 - c0;
  const dy = r1 - r0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  const tDeltaX = adx === 0 ? Infinity : 1 / adx;
  const tDeltaY = ady === 0 ? Infinity : 1 / ady;
  // From a cell centre the first boundary is always half a cell away.
  let tMaxX = adx === 0 ? Infinity : 0.5 / adx;
  let tMaxY = ady === 0 ? Infinity : 0.5 / ady;

  let x = c0;
  let y = r0;
  const EPS = 1e-9;
  // Each step advances one cell; the +4 is slack for the diagonal case.
  const maxSteps = adx + ady + 4;

  for (let n = 0; n < maxSteps; n++) {
    if (x === c1 && y === r1) return true;

    if (Math.abs(tMaxX - tMaxY) < EPS) {
      // Passing exactly through a lattice corner: both neighbours must be open
      // or the camera would shave the corner where two walls meet.
      if (!isPassable(grid, x + stepX, y, radius)) return false;
      if (!isPassable(grid, x, y + stepY, radius)) return false;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
      x += stepX;
      y += stepY;
    } else if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      x += stepX;
    } else {
      tMaxY += tDeltaY;
      y += stepY;
    }

    if (!isPassable(grid, x, y, radius)) return false;
  }

  return x === c1 && y === r1;
}

/** Debug/HUD counts. */
export function gridStats(grid: WalkGrid): {
  cells: number; floorCells: number; blockedCells: number; walkableCells: number;
} {
  let floorCells = 0;
  let blockedCells = 0;
  let walkableCells = 0;
  for (let i = 0; i < grid.floor.length; i++) {
    if (grid.floor[i]) floorCells++;
    if (grid.blocked[i]) blockedCells++;
    if (grid.floor[i] && !grid.blocked[i]) walkableCells++;
  }
  return { cells: grid.floor.length, floorCells, blockedCells, walkableCells };
}

/**
 * Bounds of the region that actually has walkable data, trimmed to a central
 * percentile of the walkable cells.
 *
 * The collider's own bounding box is a poor thing to frame a camera on. A
 * capture derived from real splats has scattered fringe coverage - a few cells
 * of ground picked up far from anywhere - and the full extent is mostly empty
 * space around a much smaller pocket of real content. Centring on that extent
 * points the camera at nothing. Trimming to the middle 90% of walkable cells
 * lands on the part of the scene a person would call "the scene".
 */
export function denseBounds(grid: WalkGrid, trim = 0.05): THREE.Box3 {
  const xs: number[] = [];
  const zs: number[] = [];
  let minFloorY = Infinity;
  let maxFloorY = -Infinity;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = cellIndex(grid, c, r);
      if (!grid.floor[i] || grid.blocked[i]) continue;
      const { x, z } = cellToWorld(grid, c, r);
      xs.push(x);
      zs.push(z);
      const y = grid.floorY[i];
      if (!Number.isNaN(y)) {
        if (y < minFloorY) minFloorY = y;
        if (y > maxFloorY) maxFloorY = y;
      }
    }
  }

  if (xs.length === 0) return grid.bounds.clone();

  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const lo = (arr: number[]) => arr[Math.floor(trim * (arr.length - 1))];
  const hi = (arr: number[]) => arr[Math.ceil((1 - trim) * (arr.length - 1))];

  const box = new THREE.Box3(
    new THREE.Vector3(lo(xs), Number.isFinite(minFloorY) ? minFloorY : grid.bounds.min.y, lo(zs)),
    new THREE.Vector3(hi(xs), Number.isFinite(maxFloorY) ? maxFloorY : grid.bounds.max.y, hi(zs)),
  );
  // Never return something degenerate; a zero-extent box breaks framing maths.
  if (box.max.x - box.min.x < grid.cellSize || box.max.z - box.min.z < grid.cellSize) {
    return grid.bounds.clone();
  }
  return box;
}
