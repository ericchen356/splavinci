/**
 * Putting an uploaded splat into the same world as its collider.
 *
 * A generated capture arrives with `semantics_metadata` telling us exactly how
 * to place it (see `placementFromSemantics`). An uploaded one arrives with
 * nothing: two files, two coordinate systems, and no statement anywhere of how
 * they relate. Getting that wrong is the failure this feature has to avoid,
 * because it is invisible everywhere it matters — the walk grid still
 * rasterises, A* still routes, the flythrough still plays, and the camera flies
 * through a room that is not where the splat is.
 *
 * So the relationship is MEASURED rather than assumed. `scanSplat` and
 * `scanCollider` reduce each file to a few numbers; everything in this module
 * is arithmetic over those numbers, which is why it is pure and has no imports
 * beyond a type. The upload form runs exactly the same code the route does, so
 * what the user is shown before they commit is the placement they get.
 *
 * WHAT THIS CANNOT DO. Nothing here can tell a room from an upside-down room
 * by its bounding box: flipping about X leaves every extent identical. The one
 * piece of evidence that does distinguish them is where the splats are —
 * interiors carry furniture, clutter and floor detail below the midline and
 * mostly bare ceiling above it — so `uprightEvidence` measures that asymmetry
 * and reports it as a ratio. It is evidence, not proof, and the UI says so.
 */

import type { Vec3 } from '@/lib/types';
import type { CaptureOrientation } from '@/app/api/uploads/limits';

/** An axis-aligned box, tuple form so it survives JSON. */
export type Extent = { min: Vec3; max: Vec3 };

/** Bins along each of the file's own axes; see `scanSplat`. */
export type AxisProfile = { x: number[]; y: number[]; z: number[] };

/** What `scanSplat` reduces a splat file to. Everything is in the file's frame. */
export type SplatScan = {
  format: 'spz' | 'ply';
  /** Splats in the file, from its header — exact, not an estimate. */
  splatCount: number;
  /** How many were actually read. The rest were skipped by the sampling stride. */
  sampled: number;
  /** Percentile box: the capture without its floaters. Fitting uses this. */
  bounds: Extent;
  /** Every sampled splat's box, so the UI can say how much the trim removed. */
  rawBounds: Extent;
  /** Opacity-weighted mass per bin along each axis, over `bounds`. */
  profile: AxisProfile;
};

/** What `scanCollider` reduces a collider GLB to. */
export type ColliderScan = {
  meshes: number;
  triangles: number;
  bounds: Extent;
  /**
   * The meshes `classifyColliderMeshes` called floor, boxed. Null when it found
   * none, in which case the bottom of `bounds` stands in for the walk surface.
   */
  floorBounds: Extent | null;
};

/** A three.js placement, in the shape lib/assets.ts already consumes. */
export type Placement = {
  position: Vec3;
  rotation: Vec3;
  scale: number;
};

export type Alignment = {
  orientation: CaptureOrientation;
  /** False when the splat is placed in its own units, untouched but for the turn. */
  fitted: boolean;
  placement: Placement;
  /** Splat size in world metres once `placement` is applied. */
  splatExtent: Vec3;
  colliderExtent: Vec3;
  /** Per-axis size disagreement after the fit, in metres. */
  residual: Vec3;
  /**
   * Worst horizontal residual as a fraction of the collider's own footprint.
   *
   * The number to judge a fit by. Height disagrees for honest reasons — a splat
   * carries sky, ceiling haze and a metre of floaters the collision mesh has no
   * reason to model — but a floor plan that disagrees in X or Z means the two
   * files are not describing the same room at the same scale.
   */
  footprintError: number;
};

const IDENTITY_ROTATION: Vec3 = [0, 0, 0];

/**
 * The turn each orientation applies, as XYZ Euler radians.
 *
 * Only rotations about X are needed: every convention this meets disagrees with
 * ours about which axis points up, never about handedness within the ground
 * plane. A capture that needs a yaw as well is a capture whose collider was
 * authored separately, and no amount of guessing fixes that.
 */
export function rotationFor(orientation: CaptureOrientation): Vec3 {
  if (orientation === 'y-down') return [Math.PI, 0, 0];
  if (orientation === 'z-up') return [-Math.PI / 2, 0, 0];
  return IDENTITY_ROTATION;
}

/** Map one point through an orientation. Matches `rotationFor` exactly. */
function orientPoint(point: Vec3, orientation: CaptureOrientation): Vec3 {
  const [x, y, z] = point;
  // 180 degrees about X: y and z both invert.
  if (orientation === 'y-down') return [x, -y, -z];
  // -90 degrees about X: the file's z becomes up, its y goes back into depth.
  if (orientation === 'z-up') return [x, z, -y];
  return [x, y, z];
}

/** A box through an orientation. Axis-aligned in, axis-aligned out. */
export function orientExtent(extent: Extent, orientation: CaptureOrientation): Extent {
  const a = orientPoint(extent.min, orientation);
  const b = orientPoint(extent.max, orientation);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function sizeOf(extent: Extent): Vec3 {
  return [
    extent.max[0] - extent.min[0],
    extent.max[1] - extent.min[1],
    extent.max[2] - extent.min[2],
  ];
}

function centreOf(extent: Extent): Vec3 {
  return [
    (extent.min[0] + extent.max[0]) / 2,
    (extent.min[1] + extent.max[1]) / 2,
    (extent.min[2] + extent.max[2]) / 2,
  ];
}

/**
 * A floor thicker than this is not a slab, so its top is not a walk surface.
 *
 * Measured, not guessed. The fixture room's floor mesh spans 0.10 m — a slab
 * with an underside. Every other capture on this machine spans metres: 3.8 m
 * on the hobbiton terrain, 2.8 m on maple-street and 11.2 m on grand-foyer,
 * because those colliders are one fused mesh whose "floor" is every up-facing
 * triangle in the room — the ground, yes, but also the countertops, the sills
 * and the tops of the furniture.
 */
const FLAT_FLOOR_SPAN_M = 0.35;

/**
 * The height a splat's floor should land on, in the collider's own frame.
 *
 * A thin slab has a top and the top is the walk surface, which is the same
 * choice `createFloorSampler` makes when it calls that height `baseY`. Anything
 * thicker is either relief or a fused mesh, and in both cases the highest
 * "floor" point is nowhere near the ground: taking it puts the splat metres in
 * the air (it lifted the hobbiton capture 3.9 m off its own collider). The
 * bottom of the floor geometry is the ground in both of those cases, and is
 * only a slab's thickness out in the case where the top would have been right.
 */
export function walkSurfaceY(collider: ColliderScan): number {
  const floor = collider.floorBounds;
  if (!floor) return collider.bounds.min[1];
  return floor.max[1] - floor.min[1] <= FLAT_FLOOR_SPAN_M ? floor.max[1] : floor.min[1];
}

/* -------------------------------------------------------------------------- */
/* the fit                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Place the splat on the collider.
 *
 * Scale comes from the horizontal diagonal rather than from any single axis:
 * one axis can disagree because the capture ran out past a doorway or stopped
 * short of a wall, but a room's floor diagonal is the one measurement both
 * files are really trying to state. Height is deliberately not used at all —
 * a splat's vertical extent includes whatever the camera saw through the
 * windows.
 *
 * Position then does two separate things, and they are separate on purpose:
 * the horizontal centres are matched to each other, and the splat's FLOOR is
 * matched to the collider's walk surface. Matching vertical centres instead
 * would let ceiling haze push the whole room into the ground.
 */
export function proposeAlignment(input: {
  splat: SplatScan;
  collider: ColliderScan;
  orientation: CaptureOrientation;
  /** False leaves the file's own units and origin alone. */
  fit: boolean;
}): Alignment {
  const { splat, collider, orientation, fit } = input;

  const oriented = orientExtent(splat.bounds, orientation);
  const splatSize = sizeOf(oriented);
  const colliderSize = sizeOf(collider.bounds);

  const splatDiagonal = Math.hypot(splatSize[0], splatSize[2]);
  const colliderDiagonal = Math.hypot(colliderSize[0], colliderSize[2]);
  const scale =
    fit && splatDiagonal > 1e-9 && colliderDiagonal > 1e-9 ? colliderDiagonal / splatDiagonal : 1;

  let position: Vec3 = [0, 0, 0];
  if (fit) {
    const splatCentre = centreOf(oriented);
    const colliderCentre = centreOf(collider.bounds);
    position = [
      colliderCentre[0] - splatCentre[0] * scale,
      walkSurfaceY(collider) - oriented.min[1] * scale,
      colliderCentre[2] - splatCentre[2] * scale,
    ];
  }

  const worldSize: Vec3 = [splatSize[0] * scale, splatSize[1] * scale, splatSize[2] * scale];
  const residual: Vec3 = [
    Math.abs(worldSize[0] - colliderSize[0]),
    Math.abs(worldSize[1] - colliderSize[1]),
    Math.abs(worldSize[2] - colliderSize[2]),
  ];
  const footprintError = Math.max(
    colliderSize[0] > 1e-9 ? residual[0] / colliderSize[0] : 0,
    colliderSize[2] > 1e-9 ? residual[2] / colliderSize[2] : 0,
  );

  return {
    orientation,
    fitted: fit,
    placement: { position, rotation: rotationFor(orientation), scale },
    splatExtent: worldSize,
    colliderExtent: colliderSize,
    residual,
    footprintError,
  };
}

/* -------------------------------------------------------------------------- */
/* which way is up                                                            */
/* -------------------------------------------------------------------------- */

/** How the splat mass divides about the midline of a given orientation. */
export type UprightEvidence = {
  /** Opacity-weighted mass in the lower half of the room, once oriented. */
  lower: number;
  upper: number;
  /** lower / upper. Above 1 is what a room the right way up looks like. */
  ratio: number;
};

/**
 * The vertical bin profile, read in whatever direction this orientation makes
 * "up". Bin 0 is always the floor end of the result.
 */
export function verticalProfile(profile: AxisProfile, orientation: CaptureOrientation): number[] {
  // A Y-down file's own +y points at the floor, so its y bins are read
  // backwards; a Z-up file's height lives on z, which our world reads forwards.
  if (orientation === 'y-down') return [...profile.y].reverse();
  if (orientation === 'z-up') return profile.z;
  return profile.y;
}

export function uprightEvidence(
  profile: AxisProfile,
  orientation: CaptureOrientation,
): UprightEvidence {
  const bins = verticalProfile(profile, orientation);
  const half = Math.floor(bins.length / 2);
  const lower = bins.slice(0, half).reduce((sum, n) => sum + n, 0);
  const upper = bins.slice(bins.length - half).reduce((sum, n) => sum + n, 0);
  return { lower, upper, ratio: upper > 1e-9 ? lower / upper : Infinity };
}

export type OrientationGuess = {
  orientation: CaptureOrientation;
  /**
   * How much to trust it. 'clear' means the evidence separates the candidates;
   * 'weak' means it does not and the user should look at the room.
   */
  confidence: 'clear' | 'weak';
  /** One sentence naming the measurement, for the form to show verbatim. */
  reason: string;
};

/** Below this the two halves are too alike to call. */
const DECISIVE_RATIO = 1.25;

/**
 * Guess which way up the splat was authored.
 *
 * Two questions in order. Is height even on the Y axis — a Z-up file's shortest
 * dimension is its z, and a room is much shorter than it is wide. Then, given
 * that it is: is the mass at the bottom, as an interior's would be, or at the
 * top, as an interior's would be when you turn it over.
 *
 * The result is a default for a control the user can change, never a decision
 * taken on their behalf.
 */
export function guessOrientation(splat: SplatScan): OrientationGuess {
  const size = sizeOf(splat.bounds);
  const [sx, sy, sz] = size;

  // Height is the short axis of a room by a wide margin (8 x 2.5 x 6 is
  // typical). If z is that axis rather than y, the file is Z-up and nothing
  // about the mass distribution needs asking.
  if (sz < sy * 0.7 && sz < sx * 0.7) {
    return {
      orientation: 'z-up',
      confidence: 'clear',
      reason:
        `The Z axis is the shortest at ${sz.toFixed(1)} against ${sx.toFixed(1)} and ` +
        `${sy.toFixed(1)}, which is where a room keeps its ceiling height.`,
    };
  }

  const upright = uprightEvidence(splat.profile, 'as-authored');
  const flipped = uprightEvidence(splat.profile, 'y-down');
  const best = flipped.ratio > upright.ratio ? 'y-down' : 'as-authored';
  const bestRatio = Math.max(upright.ratio, flipped.ratio);

  if (!Number.isFinite(bestRatio) || bestRatio < DECISIVE_RATIO) {
    return {
      // The 3DGS default, and the more likely of two guesses that the numbers
      // cannot separate: a file exported from a trainer is Y-down far more
      // often than it is Y-up.
      orientation: 'y-down',
      confidence: 'weak',
      reason:
        `The splats are spread evenly top to bottom (${bestRatio.toFixed(2)}:1), so which ` +
        `way up this was authored cannot be measured — check the room on the plan screen.`,
    };
  }

  return {
    orientation: best,
    confidence: 'clear',
    reason:
      `${bestRatio.toFixed(1)}× more splat opacity sits in the lower half this way up, ` +
      `which is what a room with a floor in it looks like.`,
  };
}

/**
 * Whether the COLLIDER looks like it is in the wrong frame.
 *
 * Not an orientation control, on purpose. glTF defines its own world as Y-up,
 * so a .glb that is not is a broken export rather than a convention, and the
 * fix belongs in whatever wrote it. But the symptom is worth naming, because
 * downstream it presents as a room with no floor: `classifyColliderMeshes`
 * finds nothing flat and low, and the walk grid comes out empty.
 */
export function colliderFrameWarning(collider: ColliderScan): string | null {
  const [x, y, z] = sizeOf(collider.bounds);
  if (z < y * 0.7 && z < x * 0.7) {
    return (
      `The collider's shortest axis is Z (${z.toFixed(1)} m against ${x.toFixed(1)} and ` +
      `${y.toFixed(1)}), so it was probably exported Z-up. glTF is defined Y-up and this ` +
      `app raycasts down the Y axis, so re-export it with axis conversion on.`
    );
  }
  if (!collider.floorBounds) {
    return (
      'No mesh in the collider reads as floor — nothing flat, wide and low, and nothing ' +
      'named floor/ground/walkable. Waypoints will still place, but the camera has no ' +
      'walk surface to sit above.'
    );
  }
  return null;
}
