/**
 * Step 4 of path generation: resolve what each waypoint's shot actually is.
 *
 * Each waypoint carries a controlSpectrum from 0 (let the system decide) to 1
 * (do exactly what I picked). The two ends are easy. The middle is the point of
 * the feature, and it needs care, because the three things being resolved do
 * not interpolate the same way:
 *
 *   duration   genuinely continuous - lerp it.
 *   intensity  genuinely continuous - lerp it. This is what stops the midpoint
 *              from being a hard switch: a half-manual orbit is a real orbit
 *              with a gentler sweep, not a different shot.
 *   shotType   categorical. There is no halfway between "orbit" and "pan", so
 *              it changes over at 0.5. That is a judgement call rather than a
 *              derivation, so both candidates and the blend factor are reported
 *              and the UI can show which side of the line a waypoint sits on.
 *
 * THE AUTO END READS THE WALLS, NOT OBJECTS.
 * There is no per-object manifest any more - a waypoint is a raw point the user
 * clicked on the splat - so the only thing the system knows about a stop is
 * where it sits relative to the room's own geometry. That turns out to be
 * enough, and it comes for free: the walk grid already carries a `clearance`
 * field, the world-space distance from every cell to the nearest wall or void.
 *
 *   close to a wall  the wall is what fills the frame  -> push in on it
 *   out in the open  the room is what fills the frame  -> pan across it
 *
 * "Close" cannot be a fixed number of metres: the app loads both a 10 x 8 m flat
 * and a ~30 x 37 m outdoor capture. A waypoint's clearance is ranked against
 * every other walkable cell in the same scene instead (see `roomShape`), so the
 * crossover lands on that room's own median and both branches stay live at any
 * scale, without a metre threshold anywhere in the rule.
 */

import type * as THREE from 'three';
import type { PathStyle, ShotType, Vec3, Waypoint } from '@/lib/types';
import {
  cellIndex,
  cellToWorld,
  denseBounds,
  findNearestCell,
  floorYAtCell,
  isWalkable,
  worldToCell,
  type WalkGrid,
} from './grid';

export type StylePreset = {
  /** Travel speed in metres per second. */
  metresPerSecond: number;
  /** Multiplier on inferred shot durations. */
  dwell: number;
  /** Default move amplitude at the fully-auto end. */
  intensity: number;
  /** Extra seconds of settle added between moves. */
  settle: number;
};

export const STYLE_PRESETS: Record<PathStyle, StylePreset> = {
  // Slow and lingering; the camera is in no hurry.
  cozy: { metresPerSecond: 0.75, dwell: 1.25, intensity: 0.8, settle: 0.35 },
  // Brisk and even. Covers ground, never dawdles, never rushes.
  realEstate: { metresPerSecond: 1.15, dwell: 0.9, intensity: 0.7, settle: 0.15 },
  // Slowest and widest. Big moves, long holds.
  cinematic: { metresPerSecond: 0.62, dwell: 1.55, intensity: 1.0, settle: 0.5 },
  // Fast tour. Short shots, small moves.
  quick: { metresPerSecond: 1.9, dwell: 0.55, intensity: 0.5, settle: 0.05 },
};

/**
 * Where the auto rule crosses from "against a wall" to "out in the open".
 *
 * Deliberately the midpoint of a rank rather than a tuned constant: `openness`
 * is a waypoint's percentile within its own scene, so 0.5 means "the more
 * enclosed half of this room" in a flat and in a landscape alike.
 */
export const WALL_OPENNESS_CROSSOVER = 0.5;

/** Where shotType flips from the inferred choice to the user's. */
export const SHOT_TYPE_CROSSOVER = 0.5;

export type ShotIntent = {
  waypointId: string;
  /** The shot that will actually be rendered. */
  shotType: ShotType;
  /** Seconds this shot occupies. */
  duration: number;
  /** 0..1 amplitude applied to the move. */
  intensity: number;
  /** World point the camera looks at during the shot. */
  targetPoint: Vec3;
  /** Horizontal distance from the waypoint to its target. Zero means the
   *  waypoint frames itself, and the shot falls back to its tangent. */
  targetDistance: number;
  /** Metres from the waypoint to the nearest wall, per the walk grid. */
  wallDistance: number;
  /** Which end of the spectrum won the shotType. */
  source: 'auto' | 'manual' | 'blended';
  blend: number;
  autoShotType: ShotType;
  autoDuration: number;
  manualShotType: ShotType;
  manualDuration: number;
  /** Short human-readable justification, shown in the waypoint panel. */
  reason: string;
};

/* -------------------------------------------------------------------------- */
/* the room's own scale                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The handful of scene-scale numbers the auto rule needs, derived once per grid.
 *
 * Cached on the grid itself: `resolveShot` runs on every frame of a slider drag
 * in the waypoint panel, and both of these are O(cells).
 */
export type RoomShape = {
  /** Trimmed extents of the walkable region - see `denseBounds`. */
  bounds: THREE.Box3;
  /** Centre of that region, lifted to mid-corridor so it works as a look target. */
  centre: Vec3;
  /**
   * Every walkable cell's clearance, ascending. A waypoint's `openness` is its
   * rank in here, which is what makes the rule scale-free: it asks "how open is
   * this spot COMPARED TO THE REST OF THIS SCENE", so the crossover falls on
   * the room's own median rather than on some number of metres that suits one
   * capture and not the other.
   */
  clearances: Float64Array;
  /** The clearance at which `openness` crosses 0.5, in metres. Reporting only. */
  medianClearance: number;
};

const shapeCache = new WeakMap<WalkGrid, RoomShape>();

/** Mid-height of the camera corridor above the floor, from the grid's own band. */
function eyeOffset(grid: WalkGrid): number {
  return (grid.band.low + grid.band.high) / 2;
}

export function roomShape(grid: WalkGrid): RoomShape {
  const hit = shapeCache.get(grid);
  if (hit) return hit;

  const bounds = denseBounds(grid);

  const walkable: number[] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = cellIndex(grid, c, r);
      if (!grid.floor[i] || grid.blocked[i]) continue;
      const d = grid.clearance[i];
      if (Number.isFinite(d)) walkable.push(d);
    }
  }
  walkable.sort((a, b) => a - b);
  const clearances = Float64Array.from(walkable);
  const medianClearance =
    clearances.length > 0
      ? clearances[Math.floor(0.5 * (clearances.length - 1))]
      : grid.cellSize;

  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const cell = worldToCell(grid, cx, cz);
  const centreFloorY = floorYAtCell(grid, cell.col, cell.row, bounds.min.y);
  const centre: Vec3 = [cx, centreFloorY + eyeOffset(grid), cz];

  const shape: RoomShape = { bounds, centre, clearances, medianClearance };
  shapeCache.set(grid, shape);
  return shape;
}

/**
 * Where `clearance` ranks among every walkable cell in the scene: 0 = as boxed
 * in as this room ever gets, 1 = as open as it ever gets, 0.5 = the median.
 * Lower bound, so all the cells hard against a wall share rank 0.
 */
function opennessOf(shape: RoomShape, clearance: number): number {
  const a = shape.clearances;
  if (a.length === 0) return 0.5;
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < clearance) lo = mid + 1;
    else hi = mid;
  }
  return lo / a.length;
}

/* -------------------------------------------------------------------------- */
/* the wall reading                                                            */
/* -------------------------------------------------------------------------- */

/** What the grid can tell us about a waypoint's surroundings. */
export type WallReading = {
  /** World-space metres to the nearest wall or void, from `grid.clearance`. */
  clearance: number;
  /** Where that ranks among every walkable cell in this scene: 0 = the most
   *  boxed-in the room gets, 1 = the most open, 0.5 = the median. Dimensionless,
   *  so one threshold travels between captures of wildly different size. */
  openness: number;
  /** Unit horizontal direction toward the nearest wall, or null if undecidable. */
  toWall: Vec3 | null;
  /** The point on that wall, at eye height, ready to use as a look target. */
  wallPoint: Vec3 | null;
  /** Centre of the walkable region, at eye height. What an open shot frames. */
  centre: Vec3;
};

function clearanceAt(grid: WalkGrid, col: number, row: number, fallback: number): number {
  const d = grid.clearance[cellIndex(grid, col, row)];
  return Number.isFinite(d) ? d : fallback;
}

/**
 * Downhill direction of the clearance field - which is, by construction, the
 * direction of the nearest wall.
 *
 * The gradient is the cheap answer and the accurate one: `clearance` is already
 * a distance-to-nearest-obstacle transform, so -grad points at whatever seeded
 * it. A short ring search for the nearest non-walkable cell covers the case
 * where the field is locally flat (a plateau exactly between two walls) and the
 * gradient says nothing.
 */
function directionToWall(
  grid: WalkGrid,
  col: number,
  row: number,
  x: number,
  z: number,
  fallback: number,
): Vec3 | null {
  const at = (c: number, r: number) =>
    clearanceAt(
      grid,
      c < 0 ? 0 : c >= grid.cols ? grid.cols - 1 : c,
      r < 0 ? 0 : r >= grid.rows ? grid.rows - 1 : r,
      fallback,
    );

  const gx = (at(col + 1, row) - at(col - 1, row)) / (2 * grid.cellSize);
  const gz = (at(col, row + 1) - at(col, row - 1)) / (2 * grid.cellSize);
  const gLen = Math.hypot(gx, gz);
  if (gLen > 1e-6) return [-gx / gLen, 0, -gz / gLen];

  // Flat field: go and find the nearest cell that is not walkable.
  const wall = findNearestCell(grid, col, row, (c, r) => !isWalkable(grid, c, r));
  if (!wall) return null;
  const w = cellToWorld(grid, wall.col, wall.row);
  const dx = w.x - x;
  const dz = w.z - z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  return [dx / len, 0, dz / len];
}

/**
 * Measure a waypoint against the room's walls.
 *
 * A waypoint dropped inside a wall or off the floor is read from the nearest
 * cell the camera could actually occupy, which is where A* will snap it to
 * anyway - reading the blocked cell itself would report zero clearance and no
 * direction, and the shot would disagree with where the camera ends up.
 */
export function readWall(grid: WalkGrid, position: Vec3): WallReading {
  const shape = roomShape(grid);
  const dropped = worldToCell(grid, position[0], position[2]);
  const cell =
    findNearestCell(grid, dropped.col, dropped.row, (c, r) => isWalkable(grid, c, r)) ?? dropped;

  const clearance = clearanceAt(grid, cell.col, cell.row, shape.medianClearance);
  const openness = opennessOf(shape, clearance);

  const here = cellToWorld(grid, cell.col, cell.row);
  const toWall = directionToWall(grid, cell.col, cell.row, here.x, here.z, shape.medianClearance);
  const eyeY = floorYAtCell(grid, cell.col, cell.row, shape.bounds.min.y) + eyeOffset(grid);
  const wallPoint: Vec3 | null = toWall
    ? [position[0] + toWall[0] * clearance, eyeY, position[2] + toWall[2] * clearance]
    : null;

  return { clearance, openness, toWall, wallPoint, centre: shape.centre };
}

/* -------------------------------------------------------------------------- */
/* inference                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Infer a shot from where the waypoint sits between the walls.
 *
 * Geometric rather than semantic, for the same reason the old object rule was:
 * nothing here needs to know what the room contains, only its shape, so it
 * behaves the same on a capture we have never seen.
 */
export function inferShotType(reading: WallReading | null): { shotType: ShotType; reason: string } {
  if (!reading) {
    // No grid yet - nothing measured, so do not invent a move.
    return { shotType: 'hold', reason: 'no collider yet - holding in place' };
  }
  const metres = reading.clearance.toFixed(1);
  if (reading.openness < WALL_OPENNESS_CROSSOVER && reading.wallPoint) {
    return {
      shotType: 'push-in',
      reason: `${metres} m from the nearest wall - move in on it`,
    };
  }
  if (reading.openness < WALL_OPENNESS_CROSSOVER) {
    // Close to something, but the grid cannot say which way. Holding is honest;
    // moving in a direction we could not work out is not.
    return { shotType: 'hold', reason: `tight spot (${metres} m clear) - hold` };
  }
  return {
    shotType: 'pan',
    reason: `open floor (${metres} m clear) - wide pan across the room`,
  };
}

/** Inferred shot length: the more open the stop, the longer the look. */
export function inferDuration(
  shotType: ShotType,
  reading: WallReading | null,
  preset: StylePreset,
): number {
  // Base seconds per shot type, before openness and style are applied.
  const base: Record<ShotType, number> = {
    orbit: 4.2,
    'push-in': 3.0,
    'pull-back': 3.2,
    pan: 3.4,
    'dolly-through': 2.6,
    rise: 3.4,
    hold: 2.0,
  };

  const openness = reading ? reading.openness : 0.4;
  const openBonus = Math.min(2.4, openness * 2.4);
  const seconds = (base[shotType] + openBonus) * preset.dwell;
  return clamp(seconds, 0.8, 14);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * What a waypoint frames, now that it is a raw point rather than an object
 * reference: the wall it faces for a move that travels along the view axis,
 * the middle of the room for everything else.
 */
function targetFor(shotType: ShotType, reading: WallReading | null, waypoint: Waypoint): Vec3 {
  if (!reading) return [waypoint.position[0], waypoint.position[1], waypoint.position[2]];
  const alongViewAxis = shotType === 'push-in' || shotType === 'pull-back';
  if (alongViewAxis && reading.wallPoint) return reading.wallPoint;
  return reading.centre;
}

/* -------------------------------------------------------------------------- */

/** Resolve one waypoint's shot against the spectrum. */
export function resolveShot(
  waypoint: Waypoint,
  grid: WalkGrid | null,
  style: PathStyle,
): ShotIntent {
  const preset = STYLE_PRESETS[style];
  const blend = clamp(waypoint.controlSpectrum, 0, 1);

  const reading = grid ? readWall(grid, waypoint.position) : null;
  const inferred = inferShotType(reading);
  const autoShotType = inferred.shotType;
  const autoDuration = inferDuration(autoShotType, reading, preset);

  const manualShotType = waypoint.shotType;
  const manualDuration = waypoint.duration;

  // Categorical: has to pick a side. Continuous: actually blends.
  const shotType = blend >= SHOT_TYPE_CROSSOVER ? manualShotType : autoShotType;
  const duration = clamp(lerp(autoDuration, manualDuration, blend), 0.4, 30);
  const intensity = clamp(lerp(preset.intensity, 1, blend), 0, 1);

  const source: ShotIntent['source'] =
    blend <= 0.001 ? 'auto' : blend >= 0.999 ? 'manual' : 'blended';

  const reason =
    source === 'manual'
      ? `you chose ${manualShotType} for ${manualDuration.toFixed(1)}s`
      : source === 'auto'
        ? inferred.reason
        : `${Math.round(blend * 100)}% manual - ${shotType} at ${duration.toFixed(1)}s ` +
          `(auto suggested ${autoShotType} at ${autoDuration.toFixed(1)}s)`;

  const targetPoint = targetFor(shotType, reading, waypoint);
  // Horizontal only: the target is lifted to eye height, and a shot that frames
  // the waypoint's own column must still read as "nothing to frame".
  const targetDistance = Math.hypot(
    targetPoint[0] - waypoint.position[0],
    targetPoint[2] - waypoint.position[2],
  );

  return {
    waypointId: waypoint.id,
    shotType,
    duration,
    intensity,
    targetPoint,
    targetDistance,
    wallDistance: reading?.clearance ?? 0,
    source,
    blend,
    autoShotType,
    autoDuration,
    manualShotType,
    manualDuration,
    reason,
  };
}
