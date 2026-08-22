/**
 * Step 3 of path generation: turn a grid path into a camera curve with
 * ease-in-out timing.
 *
 * The handover from A* to the spline is the delicate part. String pulling
 * reduces a 121-cell staircase to three corner nodes, which describes the route
 * perfectly and makes poor spline input: a Catmull-Rom through three widely
 * spaced points rounds the corner generously enough to cut through the wall the
 * corner was there to avoid.
 *
 * Two things keep that from happening, and it is worth being precise about
 * which does the work. The load-bearing one is upstream: string pulling uses a
 * conservative line-of-sight, so it naturally retains more nodes exactly where
 * geometry is tight (six through a doorway, two across an open room) and the
 * spline never gets a long unconstrained span around a tight corner. The
 * densification below is insurance on top of that - it bounds rounding to about
 * one sample spacing, tied to the clearance actually available at each end of a
 * segment, and it gives arc-length sampling an evenly spaced curve to work
 * with. Measured on this collider from 0.06 m to 0.4 m cells, both the bare and
 * the densified spline come out with zero clearance violations; densification
 * is cheap, so it stays as a guard for coarser grids and larger scenes.
 *
 * A validation pass then walks the finished curve against the grid and reports
 * anything that still clips, rather than shipping a path that quietly flies
 * through a wall.
 */
import * as THREE from 'three';
import type { Vec3 } from '@/lib/types';
import {
  cellToWorld,
  floorYAtCell,
  hasLineOfSight,
  isPassable,
  worldToCell,
  type WalkGrid,
} from './grid';
import type { Cell } from './astar';

export type CurveOptions = {
  /** Camera height above the floor surface. */
  cameraHeight: number;
  /** Camera body radius, for validation. */
  radius: number;
  /** Upper bound on spacing when densifying before the spline. */
  maxSpacing: number;
  /** Catmull-Rom tension for the 'catmullrom' curve type. */
  tension: number;
};

export const DEFAULT_CURVE: CurveOptions = {
  cameraHeight: 1.55,
  radius: 0.3,
  maxSpacing: 0.9,
  tension: 0.5,
};

/* -------------------------------------------------------------------------- */

/** Grid cells -> world points at camera height, following the floor. */
export function cellsToWorldPoints(
  grid: WalkGrid,
  cells: Cell[],
  cameraHeight: number,
  fallbackFloorY: number,
): THREE.Vector3[] {
  return cells.map((c) => {
    const { x, z } = cellToWorld(grid, c.col, c.row);
    const y = floorYAtCell(grid, c.col, c.row, fallbackFloorY) + cameraHeight;
    return new THREE.Vector3(x, y, z);
  });
}

/** Drop consecutive duplicates, which make CatmullRomCurve3 produce NaNs. */
function dedupe(points: THREE.Vector3[], epsilon = 1e-4): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const p of points) {
    if (out.length === 0 || out[out.length - 1].distanceToSquared(p) > epsilon * epsilon) {
      out.push(p);
    }
  }
  return out;
}

export type BuiltCurve = {
  curve: THREE.CatmullRomCurve3;
  /** Densified control points actually fed to the spline. */
  controlPoints: THREE.Vector3[];
  length: number;
  /** Curve samples that violate camera clearance, if any. */
  violations: number;
};

export function buildCurve(
  grid: WalkGrid,
  /** The FULL A* cell path, not a simplified one - refinement draws from it. */
  cells: Cell[],
  options: Partial<CurveOptions> = {},
  fallbackFloorY = 0,
): BuiltCurve | null {
  const opts = { ...DEFAULT_CURVE, ...options };
  if (cells.length === 0) return null;

  // String pulling gives the corners the route actually turns; those are the
  // control points a spline wants.
  const cornerIndices = simplifyIndices(grid, cells, opts.radius);
  const worldOf = (index: number) => {
    const c = cells[index];
    const { x, z } = cellToWorld(grid, c.col, c.row);
    return new THREE.Vector3(
      x,
      floorYAtCell(grid, c.col, c.row, fallbackFloorY) + opts.cameraHeight,
      z,
    );
  };

  let indices = cornerIndices.slice();
  let curve: THREE.CatmullRomCurve3 | null = null;
  let points: THREE.Vector3[] = [];
  let violations = 0;

  // Start smooth and add constraints only where the curve actually clips.
  //
  // The previous approach densified the polyline BEFORE splining, which pinned
  // the spline onto the straight segments between corners - the curve was a
  // spline in name and a run of straight lines on screen. Refining the other
  // way round keeps every span as curved as it is allowed to be: most legs
  // pass on the first attempt and never gain a control point at all.
  for (let attempt = 0; attempt <= MAX_REFINEMENTS; attempt++) {
    points = dedupe(indices.map(worldOf));
    if (points.length === 0) return null;
    if (points.length === 1) {
      const only = points[0];
      const flat = new THREE.CatmullRomCurve3([only.clone(), only.clone()], false, 'centripetal');
      return { curve: flat, controlPoints: points, length: 0, violations: 0 };
    }

    curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', opts.tension);
    const bad = violatingSpans(grid, curve, opts.radius, indices.length);
    violations = bad.total;
    if (bad.spans.size === 0 || attempt === MAX_REFINEMENTS) break;

    // Give each offending span the A* cell midway along it. That is a point the
    // router already proved passable, so the spline is pulled back toward the
    // route rather than toward an arbitrary correction.
    const next: number[] = [];
    for (let k = 0; k < indices.length; k++) {
      next.push(indices[k]);
      if (k + 1 < indices.length && bad.spans.has(k)) {
        const mid = Math.floor((indices[k] + indices[k + 1]) / 2);
        if (mid > indices[k] && mid < indices[k + 1]) next.push(mid);
      }
    }
    if (next.length === indices.length) break;
    indices = next;
  }

  if (!curve) return null;
  return { curve, controlPoints: points, length: curve.getLength(), violations };
}

/** How many times a leg may gain control points before we accept what we have. */
const MAX_REFINEMENTS = 4;

/**
 * Which control-point spans the curve leaves passable space in.
 *
 * Reported per span rather than as a count so refinement can add a point only
 * where the curve strayed, instead of subdividing spans that were already fine.
 */
function violatingSpans(
  grid: WalkGrid,
  curve: THREE.CatmullRomCurve3,
  radius: number,
  controlCount: number,
): { spans: Set<number>; total: number } {
  const length = curve.getLength();
  const samples = Math.max(2, Math.ceil(length / Math.max(0.05, grid.cellSize * 0.75)));
  const spans = new Set<number>();
  const spanCount = Math.max(1, controlCount - 1);
  const p = new THREE.Vector3();
  let total = 0;

  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    curve.getPoint(u, p);
    const { col, row } = worldToCell(grid, p.x, p.z);
    if (isPassable(grid, col, row, radius)) continue;
    total++;
    // Catmull-Rom parameterises uniformly across spans, so u maps directly.
    spans.add(Math.min(spanCount - 1, Math.floor(u * spanCount)));
  }
  return { spans, total };
}

/** simplifyPath, but returning indices into `cells` so refinement can interpolate. */
function simplifyIndices(grid: WalkGrid, cells: Cell[], radius: number): number[] {
  if (cells.length <= 2) return cells.map((_, i) => i);
  const out = [0];
  let anchor = 0;
  while (anchor < cells.length - 1) {
    let furthest = anchor + 1;
    for (let probe = cells.length - 1; probe > anchor; probe--) {
      const a = cells[anchor];
      const b = cells[probe];
      if (hasLineOfSight(grid, a.col, a.row, b.col, b.row, radius)) { furthest = probe; break; }
    }
    out.push(furthest);
    anchor = furthest;
  }
  return out;
}

/** Sample the finished curve and count points the camera could not occupy. */
export function countViolations(
  grid: WalkGrid,
  curve: THREE.CatmullRomCurve3,
  radius: number,
  length = curve.getLength(),
): number {
  const samples = Math.max(2, Math.ceil(length / Math.max(0.05, grid.cellSize)));
  let violations = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    curve.getPoint(i / samples, p);
    const { col, row } = worldToCell(grid, p.x, p.z);
    if (!isPassable(grid, col, row, radius)) violations++;
  }
  return violations;
}

/* --------------------------------- timing --------------------------------- */

/**
 * Smoothstep ease-in-out. Constant-speed travel reads as robotic; a camera that
 * accelerates out of a stop and settles into the next one reads as intentional.
 */
export function easeInOut(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Easing that only brakes where the camera is actually stopping.
 *
 * Applying ease-in-out to every segment sounds right and is not: it forces
 * zero velocity at BOTH ends of every segment, so the camera accelerates,
 * decelerates to a complete stop, and accelerates again at every boundary.
 * Measured on a four-waypoint path, that left half of all frames at a
 * standstill - each move smooth on its own, the sequence staccato.
 *
 * These are Hermite cubics with the end derivatives chosen so a junction
 * between two moving segments is C1: the outgoing segment leaves at unit
 * parameter rate and the incoming one picks it up at the same rate, so there is
 * no stop between them. Braking is reserved for junctions where the next thing
 * genuinely holds still.
 */
export function segmentEase(easeIn: boolean, easeOut: boolean): (t: number) => number {
  return hermiteRate(easeIn ? 0 : 1, easeOut ? 0 : 1);
}

/**
 * Timing curve with the parameter rate pinned at each end.
 *
 * Booleans are not enough. Choosing merely "brake or don't" still lets a slow
 * drifting pan hand over to a leg running fourteen times faster in a single
 * frame - no longer a stop, but a lurch. `r0` and `r1` are this segment's rate
 * relative to its neighbours' actual speeds, so the world-space velocity
 * matches across the junction rather than only being non-zero on both sides.
 *
 * Cubic Hermite with f(0)=0, f(1)=1, f'(0)=r0, f'(1)=r1. Rates are clamped
 * because an extreme ratio makes the cubic non-monotonic, which would run the
 * camera backwards mid-segment.
 */
export function hermiteRate(r0: number, r1: number): (t: number) => number {
  const a = clampRate(r0);
  const b = clampRate(r1);

  // Quintic, not cubic. A cubic can match the neighbours' velocities but says
  // nothing about acceleration, so acceleration jumps at every junction - the
  // kick you feel entering and leaving a move. Measured peak jerk on a
  // five-waypoint path was 265 m/s^3. Pinning acceleration to zero at both
  // ends as well removes the step: the camera ramps into its speed and out of
  // it, which is what a dolly or a crane physically does.
  //
  // f(0)=0 f(1)=1 f'(0)=a f'(1)=b f''(0)=0 f''(1)=0.
  // With a=b=0 this reduces to smootherstep, and with a=b=1 to a straight
  // line, so the no-braking and full-braking cases stay exactly as intended.
  const S = 1 - a;
  const K = b - a - 3 * S;
  const c5 = -3 * S - 3 * K;
  const c4 = 7 * K + 6 * S;
  const c3 = -2 * S - 4 * K;

  return (t) => {
    const x = clamp01(t);
    const x2 = x * x;
    const x3 = x2 * x;
    return clamp01(a * x + c3 * x3 + c4 * x3 * x + c5 * x3 * x2);
  };
}

/**
 * Ceiling of 1, not 2.
 *
 * A segment's parameter must still travel from 0 to 1 over its own duration,
 * so if it is asked to both START and END faster than its own average it has
 * no choice but to slow down in between to balance the books. At a rate of 2
 * at both ends the velocity dipped to about 6% of natural mid-move and then
 * re-accelerated - a visible hitch in the middle of a travel leg, and the
 * largest acceleration anywhere in the flythrough at 12.4 m/s^2.
 *
 * Capping at 1 means a segment never starts faster than its own natural rate.
 * Handing over from a much faster neighbour then shows a genuine deceleration
 * rather than an exact velocity match, which is what actually happens when a
 * camera slows to perform a move.
 */
function clampRate(r: number): number {
  if (!Number.isFinite(r) || r < 0) return 0;
  return Math.min(1, r);
}

/** Stronger ease for longer moves, where a hard start is more noticeable. */
export function easeInOutCubic(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Arc-length parameterisation.
 *
 * CatmullRomCurve3.getPoint(t) walks the spline's parameter, not its length, so
 * a camera driven straight off `t` speeds up wherever the control points are
 * sparse. getPointAt() re-parameterises by arc length, which is what makes the
 * easing curve mean what it says.
 */
export function sampleCurveEased(
  curve: THREE.CatmullRomCurve3,
  count: number,
  ease: (t: number) => number = easeInOut,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const n = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    out.push(curve.getPointAt(clamp01(ease(i / n))));
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function toVec3(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}
