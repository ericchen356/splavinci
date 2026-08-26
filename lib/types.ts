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

/**
 * A camera pose, exactly as it stood when it was captured.
 *
 * Bearings use the same convention as `ShotAim.from` - `Math.atan2(dz, dx)` -
 * so a captured facing can be handed straight to a shot's aim without a
 * conversion step that only one of the two call sites would remember to apply.
 * Pitch is the elevation of the view direction, positive looking up.
 *
 * Stored as yaw/pitch rather than as a quaternion or a look-at point. A
 * quaternion carries a roll this app has no way to author and no way to show;
 * a look-at point is a position plus a distance, and the distance is a fiction
 * that would then have to survive every edit to the position.
 */
export type CameraPose = {
  position: Vec3;
  /** Radians, atan2(dz, dx). */
  yaw: number;
  /** Radians, positive looking up. */
  pitch: number;
  /** Vertical field of view in degrees, as the viewport had it. */
  fov: number;
};

/** A stop the camera visits, in list order.
 *
 *  A waypoint IS a camera pose - the frame the user was looking at when they
 *  pressed the capture key - not a point on the floor. That is the whole
 *  difference between "go and stand there" and "put the camera here, like
 *  this": height and facing are authored rather than inferred, and the shot
 *  the generator builds starts from a frame the user has already seen.
 *
 *  What the pose FRAMES is still derived from the room's own geometry - there
 *  are no individually meshed objects to reference - but it is now measured
 *  along the captured view axis rather than guessed from where the waypoint
 *  stands (see lib/path/shots.ts). */
export type Waypoint = {
  id: string;
  /** Where the camera is. In the air, on a balcony, anywhere it was flown. */
  position: Vec3;
  /** Facing, radians, atan2(dz, dx). Matches `ShotAim.from`. */
  yaw: number;
  /** Elevation of the view, radians, positive looking up. */
  pitch: number;
  /** Vertical field of view in degrees, so the 3D gizmo draws the real frame. */
  fov: number;
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
   * Where this shot points. Null takes the captured facing.
   *
   * Authoritative when set, and deliberately not scaled by emphasis: naming an
   * arc IS the amplitude, and a second control quietly shrinking it would
   * reproduce exactly the problem the auto/manual blend had.
   */
  aim: ShotAim | null;
  /**
   * Perform this shot as authored even where the collider says it clips.
   *
   * The wall validator shrinks a shot that would pass through geometry and,
   * where even a motionless camera clips, replaces it with a hold. That is the
   * right default and it is wrong often enough to need an override: a collider
   * is a reconstruction, not a measurement, and a capture routinely carries a
   * phantom slab across a doorway or reads a curtain as masonry. Without this
   * the only remedy for a shot the mesh disagrees with was to move the
   * waypoint - which changes the frame the user captured in order to work
   * around a wall that is not there.
   *
   * The clip is still MEASURED and still reported when this is set; what
   * changes is that the shot is not altered. Nothing here is guesswork the
   * user cannot see.
   */
  ignoreWalls: boolean;
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
