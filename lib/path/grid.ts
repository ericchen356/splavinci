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
  /**
   * Median height across cells that have floor.
   *
   * The representative ground level, for cells that have none of their own.
   * floorBounds.max.y - the previous fallback, described as "the walk surface"
   * - is the HIGHEST floor point anywhere, which is fine for a flat fixture and
   * badly wrong for terrain with metres of relief: on hobbiton it is 3.50m
   * against a median of 0.25m, so a shot over a void cell performed itself
   * nearly 5m above the local ground.
   */
  medianFloorY: number;
  bounds: THREE.Box3;
  /** Camera corridor, as offsets above each cell's OWN floor height. */
  band: { low: number; high: number };
  /**
   * Obstacle occupancy as a bitmask of height slabs, one word per cell.
   *
   * The rest of this grid is 2D because a walking camera only ever asks about
   * one height band. A FLYING camera does not: the whole point of a captured
   * pose is that it can be four metres up, where the wall the 2D grid marks
   * `blocked` is something to fly over rather than around. A single min/max
   * span per cell cannot answer that - a reconstructed capture is a closed
   * shell, so every cell's span runs floor to ceiling and everything reads as
   * solid at every height, which is the same trap the band test documents
   * below. Bits are set per TRIANGLE, so a wall occupies the slabs the wall is
   * actually in and the air above it stays free.
   *
   * `SLAB_COUNT` slabs over the collider's own vertical extent, so the
   * resolution follows the capture: about 9 cm on a flat, about a metre on a
   * 30 m landscape. Spans are rounded OUTWARD, so the answer errs toward
   * "occupied" and a path is never cleared through geometry the slab boundary
   * happened to straddle.
   */
  obstacleSlabs: Uint32Array;
  /** World Y of the bottom of slab 0, and the height of each slab. */
  slabs: { minY: number; height: number };
};

/** Height slabs per cell. One Uint32 word, so 32 and not a tunable. */
const SLAB_COUNT = 32;

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
  // The corridor the CAMERA occupies, not "everything above the floor".
  //
  // The band used to start at 0.25 m, which made a coffee table a wall: on a
  // real furnished interior that marked 5439 cells blocked against 3963
  // walkable and shattered the apartment into 68 disconnected regions. The
  // camera flies at about 1.55 m and simply passes over furniture; what stops
  // it is geometry at its own height. Starting the band just below eye level
  // keeps walls, worktops-to-ceiling and doorframes blocking while letting
  // sofas, tables and beds be flown over, which is what they are.
  bandLow: 1.05,
  bandHigh: 2.05,
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

  // Seed the outside as solid.
  //
  // Relaxing only against in-grid neighbours makes everything beyond the grid
  // implicitly free space, so a walkable cell on the outermost ring reports
  // enormous clearance while sitting at the edge of all known geometry -
  // measured at 10.95m of "clearance" 0.113m from the void on hobbiton, where
  // 240 walkable cells sit on that ring. A* then treats the rim of the capture
  // as its cheapest corridor (high clearance means no tightness penalty) and
  // the wall-distance rule ranks it as the most open spot in the scene.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!walkable[i]) continue;
      const toEdge = Math.min(c, r, cols - 1 - c, rows - 1 - r) + 0.5;
      const seeded = toEdge * D_ORTH;
      if (seeded < d[i]) d[i] = seeded;
    }
  }

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
  const obstacleSlabs = new Uint32Array(count);

  // The slab stack spans the collider's own vertical extent. A degenerate
  // (perfectly flat) collider would give a zero height and divide by it, so the
  // span has a floor of one millimetre.
  const slabs = {
    minY: bounds.min.y,
    height: Math.max(1e-3, (bounds.max.y - bounds.min.y) / SLAB_COUNT),
  };

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

  // Obstacles: does any single triangle actually sit at camera height here.
  //
  // Tested per TRIANGLE, not accumulated per cell. Accumulating a [min, max]
  // span over every obstacle triangle covering a cell works only for a
  // collider built from separate wall boxes with no ceiling. A real capture
  // arrives as a closed shell - Marble's is one 209k-triangle mesh including
  // the ceiling - so every cell's span ran floor to ceiling, intersected the
  // band by definition, and the entire apartment came out blocked.
  //
  // A reconstructed shell has no wall interiors to fill, so per-triangle is
  // exact for it. The synthetic fixture's solid wall boxes are the case it
  // under-marks, since a box's side faces project to thin lines in XZ; the
  // close() below fills those slivers.
  rasterise(collider.obstacleGeometry, (i, triMinY, triMaxY) => {
    const base = Number.isNaN(floorY[i]) ? fallbackFloorY : floorY[i];
    if (triMaxY >= base + band.low && triMinY <= base + band.high) blocked[i] = 1;
    // And, for the flying camera, which slabs this one triangle occupies.
    obstacleSlabs[i] |= slabMask(slabs, triMinY, triMaxY);
  });

  // Close one cell: fills the interior of a solid wall whose side faces
  // rasterised to thin lines, without inventing obstacles anywhere open.
  {
    const dilated = new Uint8Array(count);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let on = 0;
        for (let dz = -1; dz <= 1 && !on; dz++) {
          for (let dx = -1; dx <= 1 && !on; dx++) {
            const nx = c + dx, nz = r + dz;
            if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
            if (blocked[nz * cols + nx]) on = 1;
          }
        }
        dilated[r * cols + c] = on;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let all = 1;
        for (let dz = -1; dz <= 1 && all; dz++) {
          for (let dx = -1; dx <= 1 && all; dx++) {
            const nx = c + dx, nz = r + dz;
            if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
            if (!dilated[nz * cols + nx]) all = 0;
          }
        }
        if (all) blocked[r * cols + c] = 1;
      }
    }
  }

  const walkable = new Uint8Array(count);
  for (let i = 0; i < count; i++) walkable[i] = floor[i] && !blocked[i] ? 1 : 0;

  const clearanceCells = chamferDistance(walkable, cols, rows);
  const clearance = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    clearance[i] = clearanceCells[i] >= 1e9 ? Infinity : clearanceCells[i] * cellSize;
  }

  const knownHeights: number[] = [];
  for (let i = 0; i < count; i++) if (!Number.isNaN(floorY[i])) knownHeights.push(floorY[i]);
  knownHeights.sort((a, b) => a - b);
  const medianFloorY = knownHeights.length
    ? knownHeights[knownHeights.length >> 1]
    : (Number.isFinite(collider.floorBounds.max.y) ? collider.floorBounds.max.y : 0);

  return {
    cellSize, cols, rows, originX, originZ,
    blocked, floor, floorY, clearance, bounds, band, medianFloorY,
    obstacleSlabs, slabs,
  };
}

/**
 * Bits for every slab a world-space vertical span touches, rounded outward.
 *
 * A span entirely above or below the stack contributes nothing rather than
 * clamping onto the end slab: geometry outside the collider's own bounds is
 * geometry that cannot be there, and clamping would smear a stray triangle
 * across the top of the whole capture.
 */
function slabMask(slabs: { minY: number; height: number }, minY: number, maxY: number): number {
  const lo = Math.floor((minY - slabs.minY) / slabs.height);
  const hi = Math.floor((maxY - slabs.minY) / slabs.height);
  if (hi < 0 || lo > SLAB_COUNT - 1) return 0;
  const from = lo < 0 ? 0 : lo;
  const to = hi > SLAB_COUNT - 1 ? SLAB_COUNT - 1 : hi;
  let mask = 0;
  for (let s = from; s <= to; s++) mask |= 1 << s;
  return mask;
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

/* -------------------------------------------------------------------------- */
/* the flying camera                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where the camera body is sampled around its own centre, in radii.
 *
 * A camera is a sphere, and the grid answers in columns, so the honest test is
 * "is any column the sphere overlaps occupied at the sphere's height". Centre
 * plus eight compass points is that test to within a corner of a cell, and it
 * is nine array reads - cheap enough to run at every sample of every curve,
 * which is what the wall validator does.
 */
const BODY_RING = [
  0, 0,
  1, 0, -1, 0, 0, 1, 0, -1,
  0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071,
];

/** Slab bits covering a world-space vertical span. */
function spanMask(grid: WalkGrid, minY: number, maxY: number): number {
  return slabMask(grid.slabs, minY, maxY);
}

/**
 * Can a camera of `radius` occupy this point in space?
 *
 * The 3D counterpart of `isPassable`, and the test every flight decision now
 * goes through. Three ways to fail:
 *   - outside the capture, which is not "clear", it is nothing;
 *   - below the floor beneath it, which is inside the ground;
 *   - overlapping obstacle geometry AT ITS OWN HEIGHT, which is the whole
 *     point - a wall stops the camera at 1.6 m and not at 6 m.
 *
 * KNOWN LIMIT: `floorY` is the highest floor surface in a cell, so in a
 * multi-storey capture the floor test measures against the upper storey. That
 * assumption is already load-bearing elsewhere (medianFloorY, cameraYAt), and
 * narrowing it here alone would only move the disagreement.
 */
export function isFreeAt(
  grid: WalkGrid,
  x: number, y: number, z: number,
  radius: number,
): boolean {
  const r = radius > 0 ? radius : 0;
  const mask = spanMask(grid, y - r, y + r);
  for (let k = 0; k < BODY_RING.length; k += 2) {
    const px = x + BODY_RING[k] * r;
    const pz = z + BODY_RING[k + 1] * r;
    const col = Math.floor((px - grid.bounds.min.x) / grid.cellSize);
    const row = Math.floor((pz - grid.bounds.min.z) / grid.cellSize);
    if (!inGrid(grid, col, row)) return false;
    const i = cellIndex(grid, col, row);
    const fy = grid.floorY[i];
    if (!Number.isNaN(fy) && y - r < fy) return false;
    if ((grid.obstacleSlabs[i] & mask) !== 0) return false;
    // A radius of zero has nothing to sample around; one read is the answer.
    if (r === 0) return true;
  }
  return true;
}

/** Probe sizes for `freeRadiusAt`, ascending. Metres. */
const CLEARANCE_LADDER = [0.15, 0.3, 0.6, 1.2, 2.4, 4.8];

/**
 * Room to move at a point in space, in metres.
 *
 * The 2D `clearance` field is a distance to the nearest wall AT WALKING
 * HEIGHT, which for a camera hovering over that same wall reports centimetres
 * of room in the middle of open sky. Shots are scaled by this number, so
 * reading it flat is the difference between an orbit and a twitch. A ladder of
 * sphere tests is coarse, but it is coarse in the right dimension.
 */
export function freeRadiusAt(grid: WalkGrid, x: number, y: number, z: number): number {
  let best = 0;
  for (const r of CLEARANCE_LADDER) {
    if (!isFreeAt(grid, x, y, z, r)) break;
    best = r;
  }
  return best;
}

/**
 * Is the straight line between two points flyable?
 *
 * Sampled at half a cell, which is the finest the grid can distinguish; a
 * coarser step can pass a segment straight through a wall thinner than the
 * step. Both endpoints are tested too - a leg that STARTS inside geometry is
 * not a leg that can be flown, however clear the middle of it is.
 */
export function hasFlightPath(
  grid: WalkGrid,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  radius: number,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const steps = Math.max(1, Math.ceil(length / Math.max(0.02, grid.cellSize * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isFreeAt(grid, from.x + dx * t, from.y + dy * t, from.z + dz * t, radius)) return false;
  }
  return true;
}

/**
 * March along a view ray until it meets something, and report how far.
 *
 * This is what a captured frame is ABOUT: the user pointed the camera at
 * something, and the distance to it is the difference between "move in on that"
 * and "sweep across all of that". Marched on the grid rather than raycast
 * against the collider's triangles, because the grid is already in memory, is
 * already what every other decision is made against, and answers in the tens of
 * microseconds this can be called at - `resolveShot` runs on every tick of a
 * slider drag.
 *
 * `hit` says whether the ray met something or simply ran out of capture, and
 * the two have to be told apart: "there is a wall eight metres away" is a
 * subject, "there is nothing out there at all" is sky. Leaving the grid is
 * checked HERE rather than left to `isFreeAt`, which reports out-of-bounds as
 * not-free - correct for asking whether a camera may be somewhere, and exactly
 * backwards for asking whether a view is blocked.
 */
export function marchView(
  grid: WalkGrid,
  from: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  maxDistance: number,
): { distance: number; hit: boolean } {
  const step = Math.max(0.02, grid.cellSize * 0.5);
  const steps = Math.max(1, Math.ceil(maxDistance / step));
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(maxDistance, i * step);
    const x = from.x + direction.x * d;
    const y = from.y + direction.y * d;
    const z = from.z + direction.z * d;

    const col = Math.floor((x - grid.bounds.min.x) / grid.cellSize);
    const row = Math.floor((z - grid.bounds.min.z) / grid.cellSize);
    if (!inGrid(grid, col, row) || y > grid.bounds.max.y) {
      return { distance: Math.max(0, d - step), hit: false };
    }

    if (!isFreeAt(grid, x, y, z, 0)) {
      // Back off to the last clear sample: the hit sample is INSIDE whatever
      // was struck, and framing a point inside a wall puts the look target
      // behind the surface the user was actually looking at.
      return { distance: Math.max(0, d - step), hit: true };
    }
  }
  return { distance: maxDistance, hit: false };
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
function isFiniteBox(box: THREE.Box3): boolean {
  return (
    Number.isFinite(box.min.x) && Number.isFinite(box.min.z) &&
    Number.isFinite(box.max.x) && Number.isFinite(box.max.z)
  );
}

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

  // An empty or degenerate collider leaves grid.bounds as THREE's empty box
  // (+Infinity min, -Infinity max). Returning it produces a centre of
  // (Inf + -Inf)/2 = NaN, which every auto shot then aims at, and the NaN
  // reaches every frame's lookAt with no warning anywhere.
  if (xs.length === 0 || !isFiniteBox(grid.bounds)) {
    return new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, 1));
  }

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

/**
 * How many disconnected regions the camera can occupy at a given body radius,
 * and what share of passable cells the largest one holds.
 *
 * Clearance is a hard gate in A*, so the radius does not merely make routes
 * wider - past a threshold it severs the space. On a collider derived from a
 * real capture the corridors are whatever the density threshold left behind,
 * and the difference between a connected scene and a shattered one can be a
 * few centimetres of radius. Callers use this to notice that before a user
 * places two waypoints that can never be joined.
 */
export function passableConnectivity(
  grid: WalkGrid,
  radius: number,
): { regions: number; largestShare: number; passableCells: number } {
  const total = grid.cols * grid.rows;
  const seen = new Uint8Array(total);
  const stack: number[] = [];
  let passableCells = 0;
  let regions = 0;
  let largest = 0;

  const ok = (c: number, r: number) => isPassable(grid, c, r, radius);

  for (let i = 0; i < total; i++) {
    const c0 = i % grid.cols;
    const r0 = (i / grid.cols) | 0;
    if (!ok(c0, r0)) continue;
    passableCells++;
    if (seen[i]) continue;

    regions++;
    let size = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      size++;
      const cx = cur % grid.cols;
      const cz = (cur / grid.cols) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!ok(nx, nz)) continue;
        const ni = nz * grid.cols + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (size > largest) largest = size;
  }

  // passableCells is only fully counted once the sweep finishes, so recount.
  let confirmed = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) if (ok(c, r)) confirmed++;
  }
  return {
    regions,
    largestShare: confirmed > 0 ? largest / confirmed : 0,
    passableCells: confirmed,
  };
}

const connectivityCache = new WeakMap<WalkGrid, Map<number, ReturnType<typeof passableConnectivity>>>();

/** Memoised `passableConnectivity`, keyed on the grid and the radius. */
export function cachedConnectivity(grid: WalkGrid, radius: number) {
  let byRadius = connectivityCache.get(grid);
  if (!byRadius) {
    byRadius = new Map();
    connectivityCache.set(grid, byRadius);
  }
  const key = Math.round(radius * 1000);
  const hit = byRadius.get(key);
  if (hit) return hit;
  const value = passableConnectivity(grid, radius);
  byRadius.set(key, value);
  return value;
}

/**
 * Largest camera radius at or below `requested` that leaves the walkable space
 * in one piece, or `minimum` if none does.
 *
 * A fixed radius cannot suit every capture: 0.30 m shattered one real scene
 * into ten regions where 0.22 m left it whole, and a user placing waypoints in
 * two different fragments just gets "no walkable route" with nothing on screen
 * to explain why. Relaxing is reported, never silent.
 */
export function resolveCameraRadius(
  grid: WalkGrid,
  requested: number,
  minimum = 0.1,
): { radius: number; relaxed: boolean; regions: number } {
  const at = cachedConnectivity(grid, requested);
  if (at.regions <= 1) return { radius: requested, relaxed: false, regions: at.regions };

  let radius = requested;
  for (let step = 0; step < 12 && radius > minimum; step++) {
    radius = Math.max(minimum, radius * 0.88);
    const probe = cachedConnectivity(grid, radius);
    if (probe.regions <= 1) return { radius, relaxed: true, regions: probe.regions };
  }
  return { radius: minimum, relaxed: true, regions: cachedConnectivity(grid, minimum).regions };
}

/**
 * Which cells the camera can actually reach, as a mask over the whole grid.
 *
 * Deliberately separate from what the map draws. A capture's survey and its
 * navigable space are different questions, and answering both from one mask
 * forced a bad trade: prune to the reachable region and the map loses the rest
 * of the building; keep everything and the router hands back straight-line
 * hops through walls for pairs it cannot join. The map shows the survey, this
 * says where a waypoint can usefully go, and the UI can show the difference.
 *
 * `origin` seeds the region when given - otherwise the largest one wins, which
 * is the sane default before any waypoint exists.
 */
export function reachableMask(
  grid: WalkGrid,
  radius: number,
  origin?: { col: number; row: number },
): { mask: Uint8Array; cells: number; regions: number } {
  const total = grid.cols * grid.rows;
  const seen = new Uint8Array(total);
  const ok = (c: number, r: number) => isPassable(grid, c, r, radius);

  const flood = (seedIndex: number, out: Uint8Array): number => {
    const stack = [seedIndex];
    out[seedIndex] = 1;
    let size = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      size++;
      const cx = cur % grid.cols;
      const cz = (cur / grid.cols) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!ok(nx, nz)) continue;
        const ni = nz * grid.cols + nx;
        if (out[ni]) continue;
        out[ni] = 1;
        stack.push(ni);
      }
    }
    return size;
  };

  if (origin && ok(origin.col, origin.row)) {
    const mask = new Uint8Array(total);
    const cells = flood(origin.row * grid.cols + origin.col, mask);
    return { mask, cells, regions: 1 };
  }

  let best: Uint8Array | null = null;
  let bestSize = 0;
  let regions = 0;
  for (let i = 0; i < total; i++) {
    if (seen[i]) continue;
    const c = i % grid.cols;
    const r = (i / grid.cols) | 0;
    if (!ok(c, r)) continue;
    const mask = new Uint8Array(total);
    const size = flood(i, mask);
    regions++;
    for (let k = 0; k < total; k++) if (mask[k]) seen[k] = 1;
    if (size > bestSize) { bestSize = size; best = mask; }
  }
  return { mask: best ?? new Uint8Array(total), cells: bestSize, regions };
}
