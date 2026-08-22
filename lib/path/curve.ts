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
  cellIndex,
  cellToWorld,
  floorYAtCell,
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

/**
 * Insert points so no gap exceeds the spacing allowed there.
 *
 * Spacing is clamped by the clearance at each end of a segment, so the spline
 * is held tightly through a doorway and allowed to breathe across a room.
 */
export function densify(
  grid: WalkGrid,
  points: THREE.Vector3[],
  maxSpacing: number,
): THREE.Vector3[] {
  if (points.length < 2) return points.slice();

  const clearanceAt = (p: THREE.Vector3): number => {
    const { col, row } = worldToCell(grid, p.x, p.z);
    const c = grid.clearance[cellIndex(grid, col, row)];
    return Number.isFinite(c) ? c : maxSpacing;
  };

  const out: THREE.Vector3[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = a.distanceTo(b);
    // The tighter end governs: rounding is what has to fit through the gap.
    const allowed = Math.max(0.15, Math.min(maxSpacing, clearanceAt(a), clearanceAt(b)));
    const steps = Math.max(1, Math.ceil(length / allowed));
    for (let s = 1; s <= steps; s++) {
      out.push(a.clone().lerp(b, s / steps));
    }
  }
  return out;
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
  cells: Cell[],
  options: Partial<CurveOptions> = {},
  fallbackFloorY = 0,
): BuiltCurve | null {
  const opts = { ...DEFAULT_CURVE, ...options };

  const raw = cellsToWorldPoints(grid, cells, opts.cameraHeight, fallbackFloorY);
  const points = dedupe(densify(grid, raw, opts.maxSpacing));

  if (points.length === 0) return null;
  if (points.length === 1) {
    const only = points[0];
    const curve = new THREE.CatmullRomCurve3([only.clone(), only.clone()], false, 'centripetal');
    return { curve, controlPoints: points, length: 0, violations: 0 };
  }

  // 'centripetal' specifically: the uniform and chordal variants both overshoot
  // on the uneven spacing that comes out of a grid path, and an overshoot here
  // means the camera bulges into a wall on a corner.
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', opts.tension);
  const length = curve.getLength();

  return {
    curve,
    controlPoints: points,
    length,
    violations: countViolations(grid, curve, opts.radius, length),
  };
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
