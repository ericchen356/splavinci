/**
 * SHARED TYPE CONTRACT — single source of truth for every agent/screen.
 *
 * Defined once here and imported everywhere. Do NOT redeclare any of these
 * shapes locally, and do not widen/narrow a field without updating this file
 * (every screen reads from it, so a local divergence silently breaks sync).
 */

/** A point in world space. Tuple form so it is JSON-safe and drops straight
 *  into an R3F `position={...}` prop. `new THREE.Vector3(...v)` to do math. */
export type Vec3 = [x: number, y: number, z: number];

/** The camera moves the user can ask for at a waypoint. */
export type ShotType =
  | 'orbit'
  | 'push-in'
  | 'pull-back'
  | 'pan'
  | 'dolly-through'
  | 'rise'
  | 'hold';

export const SHOT_TYPES: readonly ShotType[] = [
  'orbit',
  'push-in',
  'pull-back',
  'pan',
  'dolly-through',
  'rise',
  'hold',
] as const;

/** Who decides a waypoint's shot. */
export type WaypointMode = 'auto' | 'manual';

/** A stop the camera visits, in list order.
 *
 *  `position` is the raw 3D point the user clicked on the splat - there are no
 *  individually meshed objects to reference, so what a waypoint frames is
 *  derived from the room's own geometry (see lib/path/shots.ts). */
export type Waypoint = {
  id: string;
  position: Vec3;
  /**
   * Who decides this waypoint's shot.
   *
   * Deliberately a mode, not a 0..1 auto-to-manual blend. A blend conflated
   * three unrelated decisions - which shot, how long, how big - into one
   * control: the duration you typed was not the duration you got, shot type
   * snapped discontinuously at the midpoint of a slider that looked
   * continuous, and "60% manual" described no intention anyone actually has.
   * Emphasis below stays continuous, because scaling a move genuinely is a
   * matter of degree.
   */
  mode: WaypointMode;
  /** Authoritative only when mode is 'manual'. */
  shotType: ShotType;
  /** Seconds. Authoritative only when mode is 'manual'. */
  duration: number;
  /**
   * Multiplier on the style's move amplitude; 1 means "as the style intends".
   * Applies in both modes, so an inferred shot can be played down without
   * taking manual control of it, and a manual shot can be gentle.
   */
  emphasis: number;
  /**
   * Where this shot points. Null lets the generator choose.
   *
   * Authoritative when set, and deliberately not scaled by emphasis: naming an
   * arc IS the amplitude, and a second control quietly shrinking it would
   * reproduce exactly the problem the auto/manual blend had.
   */
  aim: ShotAim | null;
  /** True once the user has dragged or edited this waypoint; marks it and its
   *  immediate neighbours for targeted recompute instead of a full rebuild. */
  pinned: boolean;
};

/**
 * Where a shot points, and how far it swings, in absolute world bearings.
 *
 * Bearings belong to the room, not to whatever the shot happens to have
 * chosen to frame: "sweep from the window across to the fireplace" stays put
 * when the inferred target changes, an offset would not. Without this the
 * only recourse for a shot aimed at a blank wall was to move the waypoint.
 *
 * `from` is a bearing in radians, measured like Math.atan2(dz, dx). `sweep` is
 * signed, so direction is explicit and an arc wider than half a turn is
 * representable - neither is true if you store two endpoints and infer the
 * shorter way round. A sweep of 0 means "face this way and hold", which is
 * what the shots that do not swing use.
 */
export type ShotAim = {
  from: number;
  sweep: number;
};

/** Sensible emphasis range for the UI. 1 is the style's own amplitude. */
export const EMPHASIS_RANGE = { min: 0.2, max: 2, step: 0.05 } as const;

/** One sampled camera frame. The path generator emits a full table of these;
 *  the review screen reads it for mini-map sync and the technique label. */
export type FrameEntry = {
  timeSeconds: number;
  position: Vec3;
  lookAt: Vec3;
  /** Waypoint whose shot governs this frame. */
  activeWaypointId: string;
};

/** A spatial note pinned to a moment and a place in the flythrough. */
export type Comment = {
  id: string;
  timeSeconds: number;
  position: Vec3;
  lookAt: Vec3;
  text: string;
};

/** Global pacing/feel preset applied across the whole path. */
export type PathStyle = 'cozy' | 'realEstate' | 'cinematic' | 'quick';

export type PathSettings = {
  style: PathStyle;
};

export const PATH_STYLES: readonly PathStyle[] = [
  'cozy',
  'realEstate',
  'cinematic',
  'quick',
] as const;

/** One entry of objects.json — an individually meshed object in the room.
 *
 *  NO LONGER LOADED. Captures do not ship a per-object manifest any more: a
 *  waypoint targets a raw point on the splat and the shot is inferred from the
 *  collider's walls instead (lib/path/shots.ts). Kept only as the shape of the
 *  legacy file for anything still reading one off disk. */
export type SceneObject = {
  id: string;
  meshUrl: string;
  position: Vec3;
  label: string;
};
