/**
 * Headless regression check for the path generator.
 *
 *   npx tsx scripts/path-check.ts
 *
 * Exercises the whole chain against the real collider: grid, A*, smoothing,
 * wall-distance shot inference, incremental recompute, and the ambiguous cases
 * that must warn rather than fail silently.
 */
import { loadColliderFromDisk, poseWaypoints } from './path-lab';
import {
  generatePath, createPathCache, getWalkGrid, isFreeAt, readWall, readView, roomShape,
} from '@/lib/path';
import * as THREE from 'three';
import { directionToYawPitch, poseAxis, poseDirection, poseQuaternion } from '@/lib/pose';
import type { PathSettings, Vec3, Waypoint } from '@/lib/types';

const collider = await loadColliderFromDisk('public/sample-room/collider.glb');
const grid = getWalkGrid(collider);

/* Waypoints as the capture key makes them: a camera at eye height, pointed at
   the next stop. Floor points are not a shape this pipeline accepts any more. */
const spots: Vec3[] = [
  [3.0, 0, 2.2],
  [4.4, 0, 5.2],
  [1.6, 0, 7.0],
  [8.2, 0, 4.0],
  [8.4, 0, 1.8],
];
const waypoints: Waypoint[] = poseWaypoints(grid, spots);
const settings: PathSettings = { style: 'realEstate' };
const cache = createPathCache();

const r = generatePath({ collider, waypoints, settings }, cache);
console.log(`frames ${r.frames.length}  duration ${r.duration}s  fps ${r.fps}`);
console.log(`grid ${r.stats.gridCols}x${r.stats.gridRows} @ ${r.stats.cellSize.toFixed(4)}m  ` +
            `gridMs ${r.stats.gridMs}  generateMs ${r.stats.generateMs}`);
console.log(`segments ${r.segments.length}  recomputed ${r.stats.recomputedSegments}  reused ${r.stats.reusedSegments}`);
console.log(`legs      ${r.stats.directLegs} flown direct  ${r.stats.routedLegs} routed around geometry`);
console.log('\nshots:');
for (const s of r.shots) console.log(`  ${s.waypointId}  ${s.shotType.padEnd(13)} ${s.duration.toFixed(1)}s  int ${s.intensity.toFixed(2)}  [${s.source}]  ${s.reason}`);
console.log('\nsegments:');
for (const s of r.segments) console.log(`  ${s.startTime.toFixed(2)}-${s.endTime.toFixed(2)}s  ${s.kind.padEnd(6)} ${s.id.padEnd(22)} active=${s.waypointId} frames=${s.frameCount} reused=${s.reused}`);
console.log('\nwarnings:', r.warnings.length);
for (const w of r.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

// monotonic time check
let bad = 0;
for (let i = 1; i < r.frames.length; i++) if (r.frames[i].timeSeconds < r.frames[i-1].timeSeconds) bad++;
console.log(`\nmonotonic timeSeconds: ${bad === 0 ? 'OK' : bad + ' REGRESSIONS'}`);
const ids = new Set(r.frames.map(f => f.activeWaypointId));
console.log('activeWaypointIds present:', [...ids].join(', '));

// FrameEntry contract: exactly { timeSeconds, position, lookAt, activeWaypointId }.
const FRAME_KEYS = ['timeSeconds', 'position', 'lookAt', 'activeWaypointId'].join(',');
const frameKeys = Object.keys(r.frames[0]).sort().join(',');
console.log(`FrameEntry keys: ${frameKeys} ` +
            `(${frameKeys === FRAME_KEYS.split(',').sort().join(',') ? 'OK' : 'CHANGED'})`);

/* ---------------- the pose convention ---------------- */
/* One trig identity shared by the capture key, the shot rule and the gizmo that
   draws it, so a sign flip in any of them shows up as a camera pointing one way
   and a shot pointing another. Checked here because it is invisible on screen:
   a frustum drawn 180 degrees out still looks like a frustum. */
console.log('\n=== pose convention ===');
{
  const forward = new THREE.Vector3();
  let worst = 0;
  for (const yaw of [-3, -1.2, 0, 0.7, 2.5, 3.1]) {
    for (const pitch of [-1.4, -0.6, 0, 0.6, 1.4]) {
      // The gizmo is modelled looking down -Z, like a three camera, and rotated
      // by poseQuaternion; the shot rule marches along poseAxis. They must be
      // the same ray.
      forward.set(0, 0, -1).applyQuaternion(poseQuaternion(yaw, pitch));
      const axis = poseAxis(yaw, pitch);
      const off = Math.hypot(forward.x - axis.x, forward.y - axis.y, forward.z - axis.z);
      if (off > worst) worst = off;
    }
  }
  console.log(`gizmo -Z vs marched view axis: worst disagreement ${worst.toExponential(2)} ` +
              `(${worst < 1e-9 ? 'OK' : 'MISMATCH'})`);

  // And the round trip, so a captured camera reproduces the pose it was read
  // from rather than one 180 degrees away that happens to normalise the same.
  let worstTrip = 0;
  for (const yaw of [-3, -1.2, 0, 0.7, 2.5]) {
    for (const pitch of [-1.2, 0, 0.9]) {
      const back = directionToYawPitch(poseDirection(yaw, pitch));
      const dy = Math.abs(((back.yaw - yaw + Math.PI) % (Math.PI * 2)) - Math.PI);
      const dp = Math.abs(back.pitch - pitch);
      worstTrip = Math.max(worstTrip, dy, dp);
    }
  }
  console.log(`yaw/pitch -> direction -> yaw/pitch: worst drift ${worstTrip.toExponential(2)} ` +
              `(${worstTrip < 1e-9 ? 'OK' : 'MISMATCH'})`);
}

/* ---------------- the path is in space, not on the floor ---------------- */
console.log('\n=== flight, not floor ===');
{
  const ys = r.frames.map((f) => f.position[1]);
  const floorish = waypoints[0].position[1];
  console.log(`camera y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} m ` +
              `(waypoints captured at ${floorish.toFixed(2)} m)`);
  const buried = r.frames.filter(
    (f) => !isFreeAt(grid, f.position[0], f.position[1], f.position[2], 0.3)).length;
  console.log(`frames the camera body could not occupy: ${buried} of ${r.frames.length}`);
  const yRange = Math.max(...r.polyline.map((p) => p[1])) - Math.min(...r.polyline.map((p) => p[1]));
  console.log(`drawn route spans ${yRange.toFixed(3)} m of height ` +
              `(a floor-projected route spans the floor's own relief)`);
}

/* ---------------- captured-frame inference ---------------- */
console.log('\n=== shot rule ===');
const shape = roomShape(grid);
console.log(`median clearance ${shape.medianClearance.toFixed(2)}m (openness 0.5)  ` +
            `centre (${shape.centre[0].toFixed(2)}, ${shape.centre[2].toFixed(2)})  ` +
            `dense bounds x ${shape.bounds.min.x.toFixed(1)}..${shape.bounds.max.x.toFixed(1)} ` +
            `z ${shape.bounds.min.z.toFixed(1)}..${shape.bounds.max.z.toFixed(1)}`);
for (const w of waypoints) {
  const wall = readWall(grid, w.position);
  const view = readView(grid, w);
  const shot = r.shots.find((s) => s.waypointId === w.id)!;
  console.log(`  ${w.id}  wall ${wall.clearance.toFixed(2)}m  ` +
              `view ${view.subjectDistance.toFixed(2)}m${view.hit ? '' : ' (open)'}  ` +
              `viewOpenness ${view.openness.toFixed(2)}  ` +
              `${view.heightAboveFloor.toFixed(2)}m up${view.elevated ? ' ELEVATED' : ''}` +
              `  -> ${shot.shotType}`);
}

/* Does the flythrough actually show what was framed? The whole promise of a
   captured waypoint is that its shot starts on the frame the user pressed F
   on, so the angle between the captured facing and the shot's own opening look
   direction is the one number that says whether that survived the pipeline. */
console.log('\naiming, captured vs generated:');
const offBy = (i: number, yaw: number): number => {
  const f = r.frames[i];
  const bearing = Math.atan2(f.lookAt[2] - f.position[2], f.lookAt[0] - f.position[0]);
  return ((((bearing - yaw) * 180) / Math.PI % 360) + 540) % 360 - 180;
};
for (const w of waypoints) {
  const seg = r.segments.find((s) => s.kind === 'shot' && s.waypointId === w.id)!;
  const open = offBy(seg.frameStart, w.yaw);
  /* Where the view is not already on its mark the camera is still turning onto
     it, which the rate limiter caps at a speed a real head can be swung. So the
     honest second number is how long that takes, and whether it happens at all
     - a shot that never reaches its framing is a different failure from one
     that arrives a moment late. `pan` sweeps off its opening bearing by design,
     so the search stops as soon as it has been reached once. */
  let settled = -1;
  for (let k = 0; k < seg.frameCount; k++) {
    if (Math.abs(offBy(seg.frameStart + k, w.yaw)) <= 5) { settled = k; break; }
  }
  console.log(`  ${w.id}  captured ${((w.yaw * 180) / Math.PI).toFixed(1).padStart(6)} deg  ` +
              `opens off by ${open.toFixed(1).padStart(6)} deg  ` +
              (settled < 0
                ? 'NEVER within 5 deg'
                : `on its mark after ${(settled / r.fps).toFixed(2)}s`));
}

/* ---------------- incremental recompute ---------------- */
console.log('\n=== incremental recompute ===');
const r2 = generatePath({ collider, waypoints, settings }, cache);
console.log(`regenerate, nothing changed : recomputed ${r2.stats.recomputedSegments}  reused ${r2.stats.reusedSegments}  (${r2.stats.generateMs}ms)`);

const moved = waypoints.map((w) =>
  w.id === 'w3' ? { ...w, position: [2.4, w.position[1], 6.4] as Vec3, pinned: true } : w);
const r3 = generatePath({ collider, waypoints: moved, settings }, cache);
console.log(`drag w3 (pinned)            : recomputed ${r3.stats.recomputedSegments}  reused ${r3.stats.reusedSegments}  (${r3.stats.generateMs}ms)`);
console.log('  recomputed legs:', r3.segments.filter(s => s.kind === 'travel' && !s.reused).map(s => s.id).join(', ') || '(none)');
console.log('  reused legs    :', r3.segments.filter(s => s.kind === 'travel' && s.reused).map(s => s.id).join(', ') || '(none)');

const unpinned = moved.map((w) => ({ ...w, pinned: false }));
const r4 = generatePath({ collider, waypoints: unpinned, settings }, cache);
console.log(`same again, unpinned        : recomputed ${r4.stats.recomputedSegments}  reused ${r4.stats.reusedSegments}  (${r4.stats.generateMs}ms)`);

const restyled = generatePath({ collider, waypoints: unpinned, settings: { style: 'cinematic' } }, cache);
console.log(`change style to cinematic   : recomputed ${restyled.stats.recomputedSegments}  reused ${restyled.stats.reusedSegments}  duration ${restyled.duration}s`);

/* ---------------- unreachable ---------------- */
console.log('\n=== ambiguous cases ===');
const sealed: Waypoint[] = poseWaypoints(grid, [[3.0, 0, 2.2], [0.1, 0, 0.1]]);
const rs = generatePath({ collider, waypoints: sealed, settings }, createPathCache());
for (const w of rs.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
console.log(`  still produced ${rs.frames.length} frames, ${rs.duration}s (coherent timeline, flagged)`);

const single = generatePath(
  { collider, waypoints: poseWaypoints(grid, [[3, 0, 2.2]]), settings },
  createPathCache(),
);
for (const w of single.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

const none = generatePath({ collider, waypoints: [], settings }, createPathCache());
for (const w of none.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

/* ---------------- overriding the collider ---------------- */
/* A collider is a reconstruction, so a waypoint has to be able to say "that
   wall is not there". The measurement must not change - only what is done
   about it - so the same waypoint is generated both ways and compared. */
console.log('\n=== ignoring the walls ===');
{
  /* The second waypoint sits where the collider says a camera cannot be at all
     - the case that degrades all the way to a hold, and the one the user hits
     when the mesh has invented a wall around a spot they can plainly see. */
  const pair = poseWaypoints(grid, [[3.0, 0, 2.2], [0.1, 0, 0.1]]);
  const rise: Partial<Waypoint> =
    { mode: 'manual', shotType: 'rise', duration: 4, emphasis: 1.6 };
  const asked: Waypoint[] = [pair[0], { ...pair[1], ...rise }];
  const forced: Waypoint[] = [pair[0], { ...pair[1], ...rise, ignoreWalls: true }];

  const travelOf = (list: Waypoint[]) => {
    const out = generatePath({ collider, waypoints: list, settings }, createPathCache());
    const shot = out.shots[1];
    const seg = out.segments.find((sg) => sg.kind === 'shot' && sg.waypointId === shot.waypointId)!;
    const ys = [];
    for (let k = 0; k < seg.frameCount; k++) ys.push(out.frames[seg.frameStart + k].position[1]);
    return { out, shot, rise: Math.max(...ys) - Math.min(...ys) };
  };

  const a = travelOf(asked);
  const b = travelOf(forced);
  console.log(`  collider obeyed  : ${a.shot.shotType.padEnd(7)} wallFit=${a.shot.wallFit.padEnd(9)} ` +
              `camera rises ${a.rise.toFixed(2)} m`);
  console.log(`  collider ignored : ${b.shot.shotType.padEnd(7)} wallFit=${b.shot.wallFit.padEnd(9)} ` +
              `camera rises ${b.rise.toFixed(2)} m`);
  for (const w of [...a.out.warnings, ...b.out.warnings].filter((w) => w.code === 'shot-clipped')) {
    console.log(`  [${w.severity}] ${w.message}`);
  }
}

/* ---------------- captured in the air ---------------- */
/* The case the old pipeline could not represent at all: a waypoint flown up and
   pitched down. It must keep its height, be recognised as an establishing view,
   and be flown to directly rather than routed along the floor. */
console.log('\n=== an aerial capture ===');
{
  const ground = poseWaypoints(grid, [[3.0, 0, 2.2], [8.2, 0, 4.0]]);
  const aerial: Waypoint[] = [
    ground[0],
    { ...ground[1], position: [ground[1].position[0], 4.2, ground[1].position[2]],
      pitch: -0.55, id: 'aerial' },
  ];
  const ra = generatePath({ collider, waypoints: aerial, settings }, createPathCache());
  const view = readView(grid, aerial[1]);
  const shot = ra.shots.find((s) => s.waypointId === 'aerial')!;
  console.log(`  aerial waypoint ${view.heightAboveFloor.toFixed(2)}m up, ` +
              `elevated=${view.elevated} -> ${shot.shotType} (${shot.reason})`);
  console.log(`  legs: ${ra.stats.directLegs} direct, ${ra.stats.routedLegs} routed`);
  const ys = ra.frames.map((f) => f.position[1]);
  console.log(`  camera y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} m ` +
              `(the aerial is at 4.20 m; a floor-bound path could not exceed ~1.6 m)`);
  const pitches = ra.frames.map((f) => {
    const dy = f.lookAt[1] - f.position[1];
    const d = Math.hypot(f.lookAt[0] - f.position[0], f.lookAt[2] - f.position[2]);
    return (Math.atan2(dy, d) * 180) / Math.PI;
  });
  console.log(`  view pitch ${Math.min(...pitches).toFixed(1)}..${Math.max(...pitches).toFixed(1)} deg ` +
              `(captured at -31.5; the old fixed ceiling was 28)`);
  for (const w of ra.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
}
