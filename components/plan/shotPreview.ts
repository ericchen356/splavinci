/**
 * What one waypoint's shot will actually do, sampled for drawing.
 *
 * "Move size" means how far the camera travels, and until now moving the slider
 * moved a percentage label - the shot itself did not exist until Generate was
 * pressed, so the one control whose whole meaning is distance had no visible
 * effect on any distance. This resolves and samples exactly what the generator
 * would (lib/path/shots.ts, lib/path/motion.ts) minus the A* travel legs, so
 * the line drawn is the real shot at the real amplitude, for the cost of 24
 * samples rather than a full regenerate per slider tick.
 *
 * The one thing it cannot know before generating is the tangent, which the
 * generator takes from the curve of the legs either side. A straight line
 * through the neighbouring waypoints is the same direction to within the
 * curvature of a leg, which is close enough to preview by.
 */

import * as THREE from 'three';
import type { PathStyle, Vec3, Waypoint } from '@/lib/types';
import {
  DEFAULT_GENERATE,
  easeInOut,
  freeRadiusAt,
  marchView,
  resolveShot,
  sampleShot,
  type CameraSample,
  type ShotContext,
  type WalkGrid,
} from '@/lib/path';

const SAMPLES = 24;

/**
 * Cap on the drawn view wedge, in metres. A pan out in the open frames the
 * centre of the room, which in a 30 m capture is far enough away that the wedge
 * covers the whole mini-map and stops reading as a local indicator. Emphasis
 * scales the sweep ANGLE, and the angle survives the clamp intact.
 */
const MAX_LOOK_RADIUS = 3.5;

/**
 * A polyline previewing waypoint `index`'s shot, in world space.
 *
 * For a shot that travels, this is where the camera goes. For one that pivots
 * in place it is the wedge the view sweeps, because a pan is what the auto rule
 * picks for any open floor and its camera positions are a single point - a
 * preview that showed only travel would be blank for the most common shot.
 */
export function shotPreviewPoints(
  waypoints: readonly Waypoint[],
  index: number,
  grid: WalkGrid | null,
  style: PathStyle,
): Vec3[] {
  const waypoint = waypoints[index];
  if (!waypoint) return [];

  const intent = resolveShot(waypoint, grid, style);
  // The waypoint IS the camera position - the pose that was captured - so the
  // preview starts exactly where the flythrough will.
  const anchor = new THREE.Vector3(
    waypoint.position[0],
    waypoint.position[1],
    waypoint.position[2],
  );
  const context: ShotContext = {
    anchor,
    target: new THREE.Vector3(...intent.targetPoint),
    tangent: tangentThrough(waypoints, index),
    intensity: intent.intensity,
    hasTarget: intent.targetDistance > 1e-6,
    aim: intent.aim,
    /* The generator scales every shot by the room around it, so a preview that
       leaves this out draws a bigger move than the one that will be flown -
       which is the whole thing the preview exists to answer. Both measurements,
       because they limit different shots: the sphere bounds an orbit, the axis
       bounds a push-in. */
    clearance: grid
      ? freeRadiusAt(grid, waypoint.position[0], waypoint.position[1], waypoint.position[2])
      : undefined,
    axialReach: grid ? axialReach(grid, anchor, intent.targetPoint) : undefined,
  };

  const samples: CameraSample[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    samples.push(sampleShot(intent.shotType, context, easeInOut(i / SAMPLES)));
  }

  // 1 cm: below that the "travel" is float noise, not a move worth drawing.
  const travels = samples.some((s) => s.position.distanceToSquared(anchor) > 1e-4);
  if (travels) return samples.map((s) => [s.position.x, s.position.y, s.position.z]);

  const wedge: Vec3[] = [[anchor.x, anchor.y, anchor.z]];
  for (const sample of samples) {
    const ray = sample.lookAt.clone().sub(anchor);
    const length = ray.length();
    if (length < 1e-6) continue;
    ray.multiplyScalar(Math.min(length, MAX_LOOK_RADIUS) / length);
    wedge.push([anchor.x + ray.x, anchor.y + ray.y, anchor.z + ray.z]);
  }
  if (wedge.length < 3) return [];
  wedge.push([anchor.x, anchor.y, anchor.z]);
  return wedge;
}

/**
 * How far the camera may fly from the anchor toward what it frames.
 *
 * The same measurement generate.ts makes, and made here rather than imported
 * from it because the generator's copy is a closure over one run's grid and
 * radius. If these two ever disagree the preview is drawing a move the
 * flythrough will not perform, which is the one thing it exists not to do.
 */
function axialReach(grid: WalkGrid, from: THREE.Vector3, target: Vec3): number | undefined {
  const axis = new THREE.Vector3(target[0] - from.x, 0, target[2] - from.z);
  if (axis.lengthSq() < 1e-8) return undefined;
  axis.normalize();
  const limit = Math.hypot(
    grid.bounds.max.x - grid.bounds.min.x,
    grid.bounds.max.z - grid.bounds.min.z,
  );
  return marchView(grid, from, axis, limit, DEFAULT_GENERATE.radius).distance;
}

/** Direction of travel through a waypoint, from its neighbours. */
function tangentThrough(waypoints: readonly Waypoint[], index: number): THREE.Vector3 {
  const here = waypoints[index];
  const previous = waypoints[index - 1];
  const next = waypoints[index + 1];
  const tangent = new THREE.Vector3();

  if (previous) tangent.add(horizontalUnit(previous.position, here.position));
  if (next) tangent.add(horizontalUnit(here.position, next.position));
  if (tangent.lengthSq() < 1e-8) return new THREE.Vector3(0, 0, 1);
  return tangent.normalize();
}

function horizontalUnit(from: Vec3, to: Vec3): THREE.Vector3 {
  const v = new THREE.Vector3(to[0] - from[0], 0, to[2] - from[2]);
  return v.lengthSq() < 1e-8 ? v : v.normalize();
}
