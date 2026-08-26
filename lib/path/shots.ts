/**
 * Step 4 of path generation: resolve what each waypoint's shot actually is.
 *
 * A waypoint is either 'auto' or 'manual'. Manual uses the shot type and
 * duration stored on the waypoint verbatim; auto infers both from the
 * waypoint's surroundings. There is no blending between them - a categorical
 * choice does not have a meaningful midpoint, and pretending otherwise made
 * the duration you typed not the duration you got.
 *
 * Emphasis is the one genuinely continuous control, and applies in both modes:
 * it scales how far the camera travels during the shot, so an inferred shot can
 * be played down without taking it over, and a manual shot can be gentle.
 *
 * The auto end reads geometry rather than labels. There are no meshed objects
 * to identify, so it measures the room around the waypoint - the walk grid's
 * clearance field - and expresses it as a rank within that scene's own
 * clearance distribution. Ranking rather than thresholding in metres is what
 * lets the same rule behave sensibly in a small flat and in a large outdoor
 * capture.
 *
 * WHAT CHANGED WHEN WAYPOINTS BECAME CAMERA POSES
 * A waypoint used to be a dot on the floor, so the only questions the rule
 * could ask were about where it stood: how boxed in is this spot, and which way
 * is the nearest wall. It then invented a facing from the answer, which is why
 * an auto shot so often pointed at nothing in particular.
 *
 * A captured pose already answers the harder question - the user aimed the
 * camera at something and pressed a key - so the rule now measures ALONG that
 * aim (`readView`) instead of guessing across the floor. Three signals decide
 * the shot: how high the camera is standing, how far its own view reaches
 * before it meets something, and how open the spot is. Where a shot points is
 * no longer inferred at all; it is the frame that was captured.
 */

import type * as THREE from 'three';
import {
  EMPHASIS_RANGE,
  type CameraPose,
  type ShotAim,
  type PathStyle,
  type ShotType,
  type Vec3,
  type Waypoint,
} from '@/lib/types';
/* One definition of "which way does yaw/pitch point", shared with the gizmo
   that draws it and the capture that records it. Everything else in this file
   is deliberately three-free maths; this is a trig identity, not a dependency
   on the renderer. */
import { poseAxis } from '@/lib/pose';
import {
  cellIndex,
  cellToWorld,
  denseBounds,
  findNearestCell,
  floorYAtCell,
  isWalkable,
  marchView,
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
  /**
   * Which shot the auto rule reaches for in each situation.
   *
   * Without this a style was only a tempo: all four produced the identical
   * sequence on the identical route and differed solely in how long it took.
   * A style is a way of covering a space, not a speed setting, so it chooses
   * the vocabulary and the geometry decides where each one applies.
   *
   * Three situations, not two, since a waypoint can now be captured in the air:
   * a camera four metres up looking down is not "near a wall" or "on open
   * floor", it is an establishing view, and every style has a different answer
   * for one of those.
   */
  /** The captured frame is close on its subject. */
  nearSubject: ShotType;
  /** The captured frame looks clear across the space. */
  openView: ShotType;
  /** The camera is well above the room, looking down on it. */
  elevated: ShotType;
};

export const STYLE_PRESETS: Record<PathStyle, StylePreset> = {
  // Intimate. Moves in on things and lingers; the camera behaves like someone
  // looking closely rather than surveying.
  cozy: {
    metresPerSecond: 0.75, dwell: 1.25, intensity: 0.8,
    // Not `hold` in the open: an all-hold style parks the camera at every
    // waypoint, which is the standstill problem this pipeline already had once.
    // Easing back off a subject reads warm and keeps the camera alive.
    nearSubject: 'push-in', openView: 'pull-back', elevated: 'pull-back',
  },
  // Comprehensive. The job is to show the whole space clearly, so it sweeps
  // the open rooms and steps in on detail.
  realEstate: {
    metresPerSecond: 1.15, dwell: 0.9, intensity: 0.7,
    // The reveal from height is this genre's signature shot, so the elevated
    // slot is the one place realEstate reaches past a pan.
    nearSubject: 'push-in', openView: 'pan', elevated: 'pull-back',
  },
  // Dramatic. Reaches for the moves that carry scale - around a subject in the
  // open, and up the face of whatever it is standing near.
  cinematic: {
    metresPerSecond: 0.62, dwell: 1.55, intensity: 1.0,
    nearSubject: 'rise', openView: 'orbit', elevated: 'orbit',
  },
  // Efficient. Keeps travelling and does not stop to perform.
  quick: {
    metresPerSecond: 1.9, dwell: 0.55, intensity: 0.5,
    nearSubject: 'dolly-through', openView: 'dolly-through', elevated: 'dolly-through',
  },
};

/**
 * Where the auto rule crosses from "close on its subject" to "looking across
 * the space".
 *
 * Deliberately the midpoint of a normalised quantity rather than a tuned
 * distance in metres: `viewOpenness` is how far the captured view reaches as a
 * share of the room's own footprint, so 0.5 means the same thing in a flat and
 * in a landscape. See `viewOpennessOf`.
 */
export const VIEW_OPENNESS_CROSSOVER = 0.5;

/**
 * How far a view has to reach, as a share of the room's footprint diagonal,
 * before it counts as fully open.
 *
 * A third of the diagonal is about the length of the longest sightline an
 * ordinary interior offers - across the living space and out of the far
 * window - so a frame that reaches it is looking at the room rather than at a
 * thing in it. Anything longer is still open; the measure saturates.
 */
export const VIEW_REACH_FRACTION = 0.35;

/**
 * When the camera counts as being ABOVE the room rather than in it.
 *
 * Expressed against the grid's own camera corridor, not in metres: `band.high`
 * is where the walk grid stops caring about obstacles, so half again as high is
 * "clear of everything a standing camera would have had to walk around" for
 * whatever capture this is. The pitch condition is what separates an
 * establishing view from a camera that merely happens to be up a staircase -
 * looking straight ahead from a landing is not an aerial.
 */
export const ELEVATED_HEIGHT_FACTOR = 1.5;
export const ELEVATED_PITCH = (-8 * Math.PI) / 180;

/** Arc a pan sweeps when nobody has named one. Matches motion.ts AMPLITUDE. */
export const DEFAULT_PAN_SWEEP = (75 * Math.PI) / 180;

/** Arc an orbit swings when nobody has named one. Matches motion.ts AMPLITUDE. */
export const DEFAULT_ORBIT_SWEEP = (110 * Math.PI) / 180;

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
  /** Metres along the captured view axis before it met something. */
  subjectDistance: number;
  /** Metres from the camera down to the floor beneath it. */
  heightAboveFloor: number;
  /** Which end of the spectrum won the shotType. */
  source: 'auto' | 'manual';
  /** Applied move amplitude multiplier. */
  emphasis: number;
  /** What auto would have chosen, so the panel can show it in manual mode. */
  autoShotType: ShotType;
  autoDuration: number;
  /**
   * The arc a pan will actually sweep, whether the user set it or not.
   *
   * Resolved even when the waypoint leaves it null, so the dial opens showing
   * what the shot is already doing rather than a blank control the user has to
   * guess at - and so nudging it is a small edit, not an invention.
   */
  aim: ShotAim;
  /** True when the sector came from the waypoint rather than being derived. */
  aimExplicit: boolean;
  /**
   * What the wall validator did to this shot.
   *
   * ONLY MEANINGFUL ON AN INTENT THAT CAME OUT OF `generatePath`. `resolveShot`
   * runs before anything has been measured against the collider, so the value
   * it returns is 'clear' in the sense of "not yet examined" - the panel is
   * careful to read this off the generated shot and never off its own live
   * preview, for the same reason it does with `shotType` (see WaypointPanel).
   *
   *   clear      the shot fits as authored
   *   tightened  its amplitude was pulled in to miss the geometry
   *   held       even motionless it clipped, so it became a hold
   *   forced     it clips, and the waypoint asked for it anyway
   */
  wallFit: 'clear' | 'tightened' | 'held' | 'forced';
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
  /**
   * Footprint diagonal of the walkable region, in metres.
   *
   * The room's own yardstick, and what makes a view-distance rule scale-free:
   * "reaches a third of the way across" means the same thing in a studio flat
   * and in a 37 m landscape, where "reaches 6 m" does not.
   */
  span: number;
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

  const span = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
  const shape: RoomShape = { bounds, centre, clearances, medianClearance, span };
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
/* the view reading                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the captured frame is actually looking at.
 *
 * The wall reading above describes where the camera STANDS. This describes what
 * it is POINTED AT, which is the thing the user was choosing when they pressed
 * the capture key, and it is what a shot should be built around: the same spot
 * on the floor is a push-in when the camera is looking at the fireplace two
 * metres away and a pan when it is looking out across the room.
 */
export type ViewReading = {
  /** Metres along the view axis before it meets geometry, floor included. */
  subjectDistance: number;
  /** The point at that distance - what the shot frames. */
  subjectPoint: Vec3;
  /** False when the ray left the capture without meeting anything. */
  hit: boolean;
  /** Metres from the camera down to the floor beneath it. */
  heightAboveFloor: number;
  /**
   * How far the view reaches as a share of the room's own footprint, saturated
   * at 1. Dimensionless, so `VIEW_OPENNESS_CROSSOVER` travels between captures.
   */
  openness: number;
  /** Camera well above the room AND pitched down: an establishing view. */
  elevated: boolean;
};

/**
 * Shortest subject distance the rule will report.
 *
 * A camera pressed against a wall marches zero metres, and a zero-length look
 * vector has no direction at all - every shot then frames its own optical
 * centre and the flythrough points at nothing. motion.ts holds the same floor
 * for the same reason (AMPLITUDE.minTargetRadius); this one keeps the
 * measurement honest before it ever gets there.
 */
const MIN_SUBJECT_DISTANCE = 0.5;

export function readView(grid: WalkGrid, pose: CameraPose): ViewReading {
  const shape = roomShape(grid);
  const [x, y, z] = pose.position;
  const axis = poseAxis(pose.yaw, pose.pitch);

  // Half again the room's diagonal: far enough that a sightline down the long
  // axis of any capture is measured rather than truncated, bounded so an
  // unobstructed ray over open terrain still terminates.
  const reach = Math.max(2, shape.span * 1.5);
  const march = marchView(grid, { x, y, z }, axis, reach);
  const subjectDistance = Math.max(MIN_SUBJECT_DISTANCE, march.distance);

  const cell = worldToCell(grid, x, z);
  const floorY = floorYAtCell(grid, cell.col, cell.row, grid.medianFloorY);

  return {
    subjectDistance,
    subjectPoint: [
      x + axis.x * subjectDistance,
      y + axis.y * subjectDistance,
      z + axis.z * subjectDistance,
    ],
    hit: march.hit,
    heightAboveFloor: y - floorY,
    openness: Math.min(1, subjectDistance / Math.max(1e-6, shape.span * VIEW_REACH_FRACTION)),
    elevated:
      y - floorY > grid.band.high * ELEVATED_HEIGHT_FACTOR && pose.pitch < ELEVATED_PITCH,
  };
}

/* -------------------------------------------------------------------------- */
/* inference                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Infer a shot from the frame that was captured.
 *
 * Geometric rather than semantic, for the same reason the old object rule was:
 * nothing here needs to know what the room contains, only its shape and where
 * the camera was pointed, so it behaves the same on a capture we have never
 * seen.
 *
 * Three branches, in order of how much they override:
 *   1. the camera is up above the room looking down - an establishing view,
 *      whatever is in front of it;
 *   2. its view meets something close - there is a subject, move on it;
 *   3. its view runs clear across the space - there is no one subject, so the
 *      shot is about the space.
 *
 * Only the LAST of these was expressible before waypoints carried a pose, which
 * is why every open-floor stop got the same shot regardless of what it faced.
 */
export function inferShotType(
  wall: WallReading | null,
  view: ViewReading | null,
  preset: StylePreset,
): { shotType: ShotType; reason: string } {
  if (!wall || !view) {
    // No grid yet - nothing measured, so do not invent a move.
    return { shotType: 'hold', reason: 'no collider yet - holding on the captured frame' };
  }

  if (view.elevated) {
    return {
      shotType: preset.elevated,
      reason:
        `${view.heightAboveFloor.toFixed(1)} m up, looking down - ${VERB[preset.elevated]}`,
    };
  }

  const metres = view.subjectDistance.toFixed(1);
  if (view.openness < VIEW_OPENNESS_CROSSOVER) {
    return {
      shotType: preset.nearSubject,
      reason: `${metres} m to what it frames - ${VERB[preset.nearSubject]}`,
    };
  }
  return {
    shotType: preset.openView,
    // A ray that left the capture without hitting anything is describing sky,
    // not a sightline, and saying "8.4 m ahead" of it would be a fabrication.
    reason: view.hit
      ? `clear view ${metres} m ahead - ${VERB[preset.openView]}`
      : `nothing within ${metres} m ahead - ${VERB[preset.openView]}`,
  };
}

/** How each shot reads in the panel's one-line justification. */
const VERB: Record<ShotType, string> = {
  orbit: 'move around it',
  'push-in': 'move in on it',
  'pull-back': 'pull back from it',
  pan: 'sweep across the room',
  'dolly-through': 'keep travelling through',
  rise: 'lift along it',
  hold: 'hold on it',
};

/** Inferred shot length: the further the frame sees, the longer the look. */
export function inferDuration(
  shotType: ShotType,
  view: ViewReading | null,
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

  const openness = view ? view.openness : 0.4;
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
 * What a waypoint frames: whatever its own captured view lands on.
 *
 * This used to branch on shot type - the nearest wall for a move along the view
 * axis, the middle of the room for everything else - because a floor dot gives
 * nothing better to go on. Both answers were guesses, and the room-centre one
 * was the reason a travelling camera would fix on a point behind it and
 * moonwalk (see the note in generate.ts). A captured pose removes the guess:
 * the user aimed at something, so that is the subject, for every shot type.
 *
 * Without a grid there is nothing to march against, so the target falls back to
 * a point a few metres along the captured axis - still the right DIRECTION,
 * only an invented distance.
 */
const BLIND_TARGET_DISTANCE = 3;

function targetFor(view: ViewReading | null, waypoint: Waypoint): Vec3 {
  if (view) return view.subjectPoint;
  const axis = poseAxis(waypoint.yaw, waypoint.pitch);
  return [
    waypoint.position[0] + axis.x * BLIND_TARGET_DISTANCE,
    waypoint.position[1] + axis.y * BLIND_TARGET_DISTANCE,
    waypoint.position[2] + axis.z * BLIND_TARGET_DISTANCE,
  ];
}

/**
 * Which way an auto sweep runs: away from the nearest wall.
 *
 * A default sweep has to go one way or the other, and "always clockwise" is a
 * coin toss that lands on a wall half the time - which is the one outcome a
 * pan must not have, since its entire content is what it uncovers. The grid
 * already knows which way the nearest surface is (`toWall`), so turning the
 * other way is free and is right whenever it matters. When the wall is dead
 * ahead or dead behind, both ways are equally good and the sign is arbitrary.
 */
function sweepDirection(yaw: number, wall: WallReading | null): number {
  if (!wall?.toWall) return 1;
  const wallBearing = Math.atan2(wall.toWall[2], wall.toWall[0]);
  let delta = (wallBearing - yaw) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta > 0 ? -1 : 1;
}

/* -------------------------------------------------------------------------- */

/** Resolve one waypoint's shot against the spectrum. */
export function resolveShot(
  waypoint: Waypoint,
  grid: WalkGrid | null,
  style: PathStyle,
): ShotIntent {
  const preset = STYLE_PRESETS[style];
  const manual = waypoint.mode === 'manual';

  const wall = grid ? readWall(grid, waypoint.position) : null;
  const view = grid ? readView(grid, waypoint) : null;
  const inferred = inferShotType(wall, view, preset);
  const autoShotType = inferred.shotType;
  const autoDuration = inferDuration(autoShotType, view, preset);

  // No blending. The mode picks a source outright, so what the panel shows is
  // exactly what the camera does.
  const shotType = manual ? waypoint.shotType : autoShotType;
  const duration = clamp(manual ? waypoint.duration : autoDuration, 0.4, 30);
  // Emphasis scales the style's amplitude in both modes, which is what makes a
  // gentle manual orbit expressible.
  //
  // Deliberately NOT clamped to 1. Clamping there made the top of the slider
  // dead, and dead by an amount that depended on the global style: cinematic
  // sets preset.intensity to 1.0, so every emphasis above 100% did nothing at
  // all while the label happily read 200% - in the style whose whole promise is
  // "biggest moves". Amplitude is a multiplier on the shot's own geometry, so
  // values above 1 are meaningful; sampleShot honours them and fitShotToRoom
  // still pulls back anything that would clip a wall.
  const emphasis = clamp(waypoint.emphasis, EMPHASIS_RANGE.min, EMPHASIS_RANGE.max);
  const intensity = clamp(preset.intensity * emphasis, 0, EMPHASIS_RANGE.max);

  const source: ShotIntent['source'] = manual ? 'manual' : 'auto';
  const emphasisNote =
    Math.abs(emphasis - 1) < 0.01 ? '' : ` at ${Math.round(emphasis * 100)}% emphasis`;
  const reason = manual
    ? `you chose ${shotType} for ${duration.toFixed(1)}s${emphasisNote}`
    : `${inferred.reason}${emphasisNote}`;

  const targetPoint = targetFor(view, waypoint);

  /* THE SHOT OPENS ON THE FRAME THAT WAS CAPTURED.
   *
   * `from` is the bearing a shot STARTS on - that is what the dial's handle is
   * labelled and what motion.ts reads - so setting it to the captured yaw makes
   * "press F on this frame" mean the flythrough actually passes through that
   * frame. It is the one promise this whole feature rests on, and it is
   * checkable: scripts/path-check.ts reports the angle between each waypoint's
   * captured facing and its shot's first emitted frame.
   *
   * It used to be `bearing - sweep/2`, centring an arc on a target the
   * generator had chosen for itself. Two things were wrong with that and only
   * one of them was visible. The visible one: a pan opened 37.5 degrees to one
   * side of what it framed. The other: shots that do not sweep at all - push-in,
   * rise, dolly, hold - took `from` as their FACING, so they were aimed 37.5
   * degrees off a target they had just computed, permanently, in every plan.
   *
   * `sweep` still differs per shot, because it is a different quantity for
   * each: for a pan it is how far the view swings, for an orbit how far the
   * CAMERA travels around the subject, and for the rest there is nothing to
   * swing. Not scaled by intensity - the dial owns the arc, move size owns
   * distance. */
  const sweepSize =
    shotType === 'pan' ? DEFAULT_PAN_SWEEP : shotType === 'orbit' ? DEFAULT_ORBIT_SWEEP : 0;
  const derived: ShotAim = {
    from: waypoint.yaw,
    sweep: sweepSize * sweepDirection(waypoint.yaw, wall),
  };
  const aim: ShotAim = waypoint.aim ?? derived;
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
    wallDistance: wall?.clearance ?? 0,
    subjectDistance: view?.subjectDistance ?? 0,
    heightAboveFloor: view?.heightAboveFloor ?? 0,
    aim,
    aimExplicit: waypoint.aim !== null,
    // Nothing has been measured against the collider yet; generatePath fills
    // this in once fitShotToRoom has had its say.
    wallFit: 'clear',
    source,
    emphasis,
    autoShotType,
    autoDuration,
    reason,
  };
}
