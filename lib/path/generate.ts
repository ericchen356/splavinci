/**
 * The path generator: waypoints + collider + style -> a full FrameEntry table.
 *
 * The timeline alternates shot and travel segments:
 *
 *   shot(w0) travel(w0->w1) shot(w1) travel(w1->w2) ... shot(wN)
 *
 * Travel is attributed to the waypoint it heads toward, so the review screen's
 * label names the shot you are about to see rather than the one just finished.
 *
 * INCREMENTAL RECOMPUTE
 * Each segment is keyed by a hash of everything that can change its geometry.
 * A travel segment's key covers the two waypoints it spans; a shot's key covers
 * its own parameters plus its neighbours' positions, because the neighbours are
 * what determine the tangent it moves along. Editing one waypoint therefore
 * changes exactly the keys of the segments touching it and its immediate
 * neighbours, and every other segment is served from cache. That falls out of
 * the keying rather than being bookkept separately, so it cannot drift out of
 * sync with what actually affects a segment. Marking a waypoint `pinned` forces
 * that same neighbourhood to recompute even if nothing else changed.
 *
 * Anything ambiguous - two waypoints with no walkable route between them, a
 * waypoint dropped inside a wall, an orbit that would clip - is reported in
 * `warnings` rather than silently producing a broken path.
 */

import * as THREE from 'three';
import type { FrameEntry, PathSettings, ShotType, Vec3, Waypoint } from '@/lib/types';
import type { ColliderData } from '@/lib/scene/collider';
import {
  floorYAtCell,
  worldToCell,
  isPassable,
  type GridOptions,
  type WalkGrid,
} from './grid';
import { getWalkGrid } from './gridCache';
import { findPath, simplifyPath, type Cell } from './astar';
import { buildCurve, easeInOut, DEFAULT_CURVE } from './curve';
import { sampleShot, vec3, type ShotContext } from './motion';
import { resolveShot, STYLE_PRESETS, type ShotIntent } from './shots';
import {
  EMPTY_PATH,
  type PathResult,
  type PathSegmentInfo,
  type PathStats,
  type PathWarning,
} from './result';

export type GenerateOptions = {
  fps: number;
  /** Camera height above the floor. */
  cameraHeight: number;
  /** Camera body radius; gates pathfinding and shot validation. */
  radius: number;
  /** Ceiling on how fast the view may rotate. A brisk whip pan, not a cut. */
  maxTurnRateDegPerSec: number;
  grid?: GridOptions;
};

export const DEFAULT_GENERATE: GenerateOptions = {
  fps: 30,
  cameraHeight: DEFAULT_CURVE.cameraHeight,
  radius: DEFAULT_CURVE.radius,
  maxTurnRateDegPerSec: 200,
};

export type PathInput = {
  collider: ColliderData | null;
  waypoints: readonly Waypoint[];
  settings: PathSettings;
  options?: Partial<GenerateOptions>;
};

/* -------------------------------------------------------------------------- */
/* cache                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cached travel legs, keyed by everything that can change their geometry.
 * In-memory only and never serialised, so holding the live THREE curve is fine
 * and saves rebuilding the spline on every edit.
 */
export type PathCache = {
  grid: WalkGrid | null;
  gridKey: string;
  legs: Map<string, LegResult>;
};

export function createPathCache(): PathCache {
  return { grid: null, gridKey: '', legs: new Map() };
}

function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function waypointKey(w: Waypoint): string {
  return [
    w.id,
    w.position.map((v) => round(v)).join(','),
    w.mode,
    w.shotType,
    round(w.duration, 2),
    round(w.emphasis, 3),
  ].join('|');
}

function positionKey(w: Waypoint | undefined): string {
  return w ? w.position.map((v) => round(v)).join(',') : 'none';
}

/* -------------------------------------------------------------------------- */
/* generation                                                                  */
/* -------------------------------------------------------------------------- */

export function generatePath(input: PathInput, cache: PathCache = createPathCache()): PathResult {
  const t0 = now();
  const opts = { ...DEFAULT_GENERATE, ...input.options };
  const waypoints = input.waypoints;
  const warnings: PathWarning[] = [];

  if (!input.collider) {
    return withWarnings(EMPTY_PATH, [{
      code: 'no-collider', severity: 'error', waypointIds: [],
      message: 'No collider loaded, so there is nothing to route around yet.',
    }]);
  }
  if (waypoints.length === 0) {
    return withWarnings(EMPTY_PATH, [{
      code: 'no-waypoints', severity: 'info', waypointIds: [],
      message: 'Drop at least two waypoints to generate a path.',
    }]);
  }

  /* ---- grid (cached across calls; only rebuilt when inputs change) ---- */
  const gridKey = JSON.stringify({
    tris: input.collider.triangleCount,
    names: input.collider.meshNames,
    grid: input.options?.grid ?? null,
  });
  const gt0 = now();
  if (!cache.grid || cache.gridKey !== gridKey) {
    cache.grid = getWalkGrid(input.collider, opts.grid);
    cache.gridKey = gridKey;
    // The grid moved under the cached legs, so none of them are valid.
    cache.legs.clear();
  }
  const grid = cache.grid;
  const gridMs = now() - gt0;

  const fallbackFloorY = Number.isFinite(input.collider.floorBounds.max.y)
    ? input.collider.floorBounds.max.y
    : 0;

  /* ---- resolve every shot up front; travel timing depends on it ---- */
  const preset = STYLE_PRESETS[input.settings.style];
  const shots: ShotIntent[] = waypoints.map((w) =>
    resolveShot(w, grid, input.settings.style),
  );

  if (waypoints.length === 1) {
    warnings.push({
      code: 'single-waypoint', severity: 'info', waypointIds: [waypoints[0].id],
      message: 'Only one waypoint: the camera will perform its shot in place.',
    });
  }

  /* ---- travel legs: A* + spline, cached ---- */
  const legs: (LegResult | null)[] = [];
  let recomputed = 0;
  let reused = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    // `pinned` is deliberately NOT part of the key. It used to be, and that
    // made every drag cost the A* and spline twice: the pinned generate stored
    // the leg under `...|pinned`, generate() then cleared the pins, and the
    // next lookup missed on `...|` - a key never written for that position.
    // The `!a.pinned && !b.pinned` guard below is what scopes the rebuild;
    // the key only needs to describe the geometry.
    const key = [
      'travel', a.id, b.id, positionKey(a), positionKey(b),
      input.settings.style, round(opts.radius, 3), round(opts.cameraHeight, 3),
    ].join('|');

    const hit = cache.legs.get(key);
    if (hit && !a.pinned && !b.pinned) {
      reused++;
      legs.push({ ...hit, cached: true });
      continue;
    }

    const leg = computeLeg(grid, a, b, opts, fallbackFloorY, preset.metresPerSecond);
    recomputed++;
    cache.legs.set(key, leg);
    legs.push({ ...leg, cached: false });
  }

  /* ---- tangents: direction of travel through each waypoint ---- */
  const tangents = waypoints.map((_, i) => {
    const incoming = i > 0 ? legs[i - 1]?.endTangent : null;
    const outgoing = i < legs.length ? legs[i]?.startTangent : null;
    const v = new THREE.Vector3();
    if (incoming) v.add(incoming);
    if (outgoing) v.add(outgoing);
    if (v.lengthSq() < 1e-8) v.set(0, 0, 1);
    v.y = 0;
    return v.normalize();
  });

  /* ---- assemble the timeline ---- */
  const frames: FrameEntry[] = [];
  const segments: PathSegmentInfo[] = [];
  const polyline: Vec3[] = [];
  let time = 0;

  const pushSegment = (
    kind: 'shot' | 'travel',
    id: string,
    waypointId: string,
    fromId: string | null,
    toId: string | null,
    duration: number,
    sample: (t: number) => { position: Vec3; lookAt: Vec3 },
    cached: boolean,
  ) => {
    const count = Math.max(2, Math.round(duration * opts.fps));
    const frameStart = frames.length;
    for (let f = 0; f < count; f++) {
      const t = count === 1 ? 0 : f / (count - 1);
      const { position, lookAt } = sample(t);
      frames.push({
        timeSeconds: round(time + t * duration, 4),
        position,
        lookAt,
        activeWaypointId: waypointId,
      });
    }
    segments.push({
      id, kind, waypointId,
      fromWaypointId: fromId, toWaypointId: toId,
      startTime: round(time, 4), endTime: round(time + duration, 4),
      frameStart, frameCount: count, reused: cached,
    });
    time += duration;
  };

  // A waypoint's stored position is a point on the FLOOR (that is what a
  // mini-map click means), so the camera anchor is lifted to eye height.
  // Without this the camera would sink to the floor at every waypoint and pop
  // back up for each travel leg.
  const anchorOf = (wp: Waypoint) =>
    new THREE.Vector3(
      wp.position[0],
      cameraYAt(grid, wp.position, opts.cameraHeight, fallbackFloorY),
      wp.position[2],
    );

  // Memoised: a travel leg needs the NEXT waypoint's opening pose to stay
  // continuous with it, so each shot is asked for twice and fitting it is the
  // expensive part.
  const fittedShots = new Map<number, FittedShot>();
  const shotContextFor = (index: number): FittedShot | null => {
    if (index < 0 || index >= waypoints.length) return null;
    const cached = fittedShots.get(index);
    if (cached) return cached;
    const wp = waypoints[index];
    const intent = shots[index];
    const ctx: ShotContext = {
      anchor: anchorOf(wp),
      target: new THREE.Vector3(...intent.targetPoint),
      tangent: tangents[index],
      intensity: intent.intensity,
      // A waypoint whose target resolved to its own column has nothing to
      // frame; the shot falls back to its direction of travel.
      hasTarget: intent.targetDistance > 1e-6,
    };
    const fitted = fitShotToRoom(grid, intent.shotType, ctx, opts.radius);
    fittedShots.set(index, fitted);
    return fitted;
  };

  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    const shot = shots[i];

    /* shot at waypoint i */
    const validated = shotContextFor(i)!;
    const anchor = validated.ctx.anchor;
    if (validated.degraded) {
      warnings.push({
        code: 'shot-clipped', severity: 'warning', waypointIds: [w.id],
        message: validated.fellBackToHold
          ? `${shot.shotType} at ${w.id} would have gone through a wall; held in place instead.`
          : `${shot.shotType} at ${w.id} was tightened to ${Math.round(validated.ctx.intensity * 100)}% to clear the walls.`,
      });
      // Keep the reported intent honest about what will actually be rendered.
      shots[i] = { ...shot, shotType: validated.shotType, intensity: validated.ctx.intensity };
    }

    pushSegment(
      'shot', `shot:${w.id}`, w.id, null, null,
      shot.duration,
      (t) => {
        const s = sampleShot(validated.shotType, validated.ctx, easeInOut(t));
        return { position: vec3(s.position), lookAt: vec3(s.lookAt) };
      },
      false,
    );

    /* travel from i to i+1 */
    const leg = legs[i];
    if (i < waypoints.length - 1 && leg) {
      polyline.push(...leg.polyline);
      const nextShot = shots[i + 1];
      const nextWaypoint = waypoints[i + 1];

      // The poses the neighbouring shots actually END and BEGIN at.
      //
      // A shot is a displacement about its anchor and does not return to it:
      // push-in finishes advanced toward its subject, rise finishes 1.4 m
      // higher, orbit finishes part-way round an arc. The travel leg used to
      // start unconditionally at the A* curve's first point, so the camera
      // teleported between the two - measured at up to 2.99 m in a single
      // frame, about 90 m/s, against a typical step of 0.0013 m.
      const exitPose = sampleShot(validated.shotType, validated.ctx, 1);
      const nextCtx = shotContextFor(i + 1);
      const entryPose = nextCtx
        ? sampleShot(nextCtx.shotType, nextCtx.ctx, 0)
        : { position: anchorOf(nextWaypoint), lookAt: new THREE.Vector3(...nextShot.targetPoint) };

      const curveStart = leg.curve ? leg.curve.getPointAt(0) : exitPose.position.clone();
      const curveEnd = leg.curve ? leg.curve.getPointAt(1) : entryPose.position.clone();
      // Offsets that reconcile the curve's endpoints with the shot poses, faded
      // out over the first and last fifth of the leg so the middle still flies
      // the routed path exactly.
      const startOffset = exitPose.position.clone().sub(curveStart);
      const endOffset = entryPose.position.clone().sub(curveEnd);

      const fromLook = exitPose.lookAt.clone();
      const toLook = entryPose.lookAt.clone();
      const blendSpan = blendFractionFor(leg.duration);
      // Lead expressed in curve parameter, since getPointAt is arc-length
      // based: a constant metre lead behaves the same on a long leg and a short
      // one, where a constant parameter lead would not.
      const lookAheadU = leg.length > 1e-6
        ? Math.min(0.5, LOOK_AHEAD_DISTANCE / leg.length)
        : 0.5;
      const endTangent = leg.curve
        ? leg.curve.getTangentAt(1)
        : new THREE.Vector3(0, 0, 1);

      if (leg.warnings.length > 0) warnings.push(...leg.warnings);

      pushSegment(
        'travel', `travel:${w.id}->${nextWaypoint.id}`,
        nextWaypoint.id, w.id, nextWaypoint.id,
        leg.duration,
        (t) => {
          const e = easeInOut(t);
          if (!leg.curve) {
            // Degenerate leg: hold the exit pose rather than inventing motion.
            return { position: vec3(exitPose.position), lookAt: vec3(exitPose.lookAt) };
          }
          const base = leg.curve.getPointAt(clamp01(e));
          const p = base.clone()
            .addScaledVector(startOffset, blendOut(e, blendSpan))
            .addScaledVector(endOffset, blendOut(1 - e, blendSpan));

          // While travelling, face along the direction of travel.
          //
          // Interpolating between the two shots' framing instead looked
          // reasonable and was not: the auto rule resolves most waypoints to
          // the room's centre, so the camera fixed on one point and moonwalked
          // through the leg once it passed it - 198 of 198 frames on one
          // segment more than 90 degrees off its own direction of motion. A
          // travelling camera looks where it is going; the shots at either end
          // are what frame a subject.
          // Aim at a point a fixed distance further along the route, not at
          // the instantaneous tangent. The tangent whips through a corner -
          // measured at 68 degrees in a single frame rounding the nook - while
          // a point held ahead averages the turn over its own lead distance
          // and sweeps through it the way an operator would.
          //
          // Past the end of the curve the aim point is EXTRAPOLATED along the
          // exit tangent rather than clamped. Clamping parks it on the final
          // point, the camera closes on it, and the look direction becomes
          // unstable and then flips - 156 degrees in one frame. Switching to a
          // different aim rule near the end is no better: changing rule mid
          // flight is itself the discontinuity.
          const u = e + lookAheadU;
          const aheadPoint = u <= 1
            ? leg.curve.getPointAt(u)
            : curveEnd.clone().addScaledVector(endTangent, (u - 1) * leg.length);

          // Blend look DIRECTIONS, never look points.
          //
          // Interpolating the aim point from "far ahead on the route" toward
          // "what the next shot frames" walks that point straight through the
          // camera: measured 0.23 m away at 86% of a leg, where a millimetre
          // of travel swings the view 80 degrees. Directions are unit vectors,
          // so a blend between them cannot collapse, and the aim point is
          // re-projected to a fixed distance afterwards.
          const aim = safeDirection(aheadPoint, p, endTangent);
          const bFrom = blendOut(e, blendSpan);
          if (bFrom > 0) aim.lerp(safeDirection(fromLook, p, aim), bFrom);
          const bTo = blendOut(1 - e, blendSpan);
          if (bTo > 0) aim.lerp(safeDirection(toLook, p, aim), bTo);
          if (aim.lengthSq() < 1e-8) aim.copy(endTangent);
          aim.normalize();

          const look = p.clone().addScaledVector(aim, LOOK_AHEAD_DISTANCE);
          return { position: vec3(p), lookAt: vec3(look) };
        },
        leg.cached === true,
      );
    }
  }

  // Bound the worst-case view rotation across the whole table.
  const clampedFrames = limitTurnRate(frames, opts.fps, opts.maxTurnRateDegPerSec);

  const stats: PathStats = {
    gridCols: grid.cols, gridRows: grid.rows, cellSize: grid.cellSize,
    recomputedSegments: recomputed, reusedSegments: reused,
    turnRateClampedFrames: clampedFrames,
    generateMs: round(now() - t0, 2), gridMs: round(gridMs, 2),
  };

  return {
    frames, fps: opts.fps, duration: round(time, 4),
    segments, shots, polyline, warnings, stats,
  };
}


/**
 * Cap how fast the view direction may rotate, across the finished table.
 *
 * Every geometric rule that produces a look target has some configuration
 * where its derivative blows up - a spline tangent rounding a tight corner, an
 * aim point passing near the camera, a shot handing over to a leg that frames
 * something behind it. Chasing those case by case fixed each measurement and
 * moved the whip somewhere else. A rate limit bounds the worst case by
 * construction, whatever the source, which is also what a real camera rig
 * does: an operator cannot snap a head 80 degrees between two frames either.
 *
 * Applied forward in time, so a fast target turn becomes a fast-but-finite
 * sweep that catches up within a few frames rather than a one-frame cut. The
 * cap is deliberately generous - a genuine whip pan is still allowed.
 */
function limitTurnRate(frames: FrameEntry[], fps: number, degreesPerSecond: number): number {
  if (frames.length < 2) return 0;
  const maxStep = (degreesPerSecond * Math.PI) / 180 / Math.max(1, fps);

  const prev = new THREE.Vector3();
  const want = new THREE.Vector3();
  const axis = new THREE.Vector3();
  let clamped = 0;

  const dirOf = (f: FrameEntry, out: THREE.Vector3) =>
    out.set(
      f.lookAt[0] - f.position[0],
      f.lookAt[1] - f.position[1],
      f.lookAt[2] - f.position[2],
    );

  dirOf(frames[0], prev);
  if (prev.lengthSq() < 1e-12) return 0;
  prev.normalize();

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    dirOf(frame, want);
    const distance = want.length();
    if (distance < 1e-6) {
      // Degenerate target: keep the previous direction rather than inventing one.
      frame.lookAt = [
        frame.position[0] + prev.x * LOOK_AHEAD_DISTANCE,
        frame.position[1] + prev.y * LOOK_AHEAD_DISTANCE,
        frame.position[2] + prev.z * LOOK_AHEAD_DISTANCE,
      ];
      continue;
    }
    want.divideScalar(distance);

    const dot = Math.min(1, Math.max(-1, prev.dot(want)));
    const angle = Math.acos(dot);
    if (angle > maxStep) {
      axis.crossVectors(prev, want);
      if (axis.lengthSq() < 1e-12) {
        // Exactly opposed: any perpendicular axis is as good as another.
        axis.set(0, 1, 0).cross(prev);
        if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0).cross(prev);
      }
      axis.normalize();
      want.copy(prev).applyAxisAngle(axis, maxStep).normalize();
      clamped++;
    }

    // Re-project at the target's own distance so framing scale is preserved.
    frame.lookAt = [
      frame.position[0] + want.x * distance,
      frame.position[1] + want.y * distance,
      frame.position[2] + want.z * distance,
    ];
    prev.copy(want);
  }
  return clamped;
}

/* -------------------------------------------------------------------------- */

type LegResult = {
  curve: THREE.CatmullRomCurve3 | null;
  /** Arc length of the curve, so a look-ahead can be expressed in metres. */
  length: number;
  duration: number;
  polyline: Vec3[];
  warnings: PathWarning[];
  startTangent: THREE.Vector3 | null;
  endTangent: THREE.Vector3 | null;
  hasLookTargets: boolean;
  cached?: boolean;
};

function computeLeg(
  grid: WalkGrid,
  a: Waypoint,
  b: Waypoint,
  opts: GenerateOptions,
  fallbackFloorY: number,
  metresPerSecond: number,
): LegResult {
  const warnings: PathWarning[] = [];
  const from = worldToCell(grid, a.position[0], a.position[2]);
  const to = worldToCell(grid, b.position[0], b.position[2]);

  const res = findPath(grid, from, to, { radius: opts.radius });

  if (!res.found) {
    // Ambiguous case, reported rather than papered over: emit a straight hop so
    // the timeline stays coherent, and say plainly that it clips.
    warnings.push({
      code: 'unreachable', severity: 'error', waypointIds: [a.id, b.id],
      message:
        `No walkable route from ${a.id} to ${b.id} (${res.failure}). ` +
        `The camera will cut straight across, which may pass through walls.`,
    });
    const ay = cameraYAt(grid, a.position, opts.cameraHeight, fallbackFloorY);
    const by = cameraYAt(grid, b.position, opts.cameraHeight, fallbackFloorY);
    const pa = new THREE.Vector3(a.position[0], ay, a.position[2]);
    const pb = new THREE.Vector3(b.position[0], by, b.position[2]);
    const curve = new THREE.CatmullRomCurve3([pa, pb], false, 'centripetal');
    const dir = pb.clone().sub(pa).setY(0);
    const length = dir.length();
    return {
      curve, length, duration: Math.max(0.4, length / metresPerSecond),
      polyline: [vec3(pa), vec3(pb)], warnings,
      startTangent: length > 1e-6 ? dir.clone().normalize() : null,
      endTangent: length > 1e-6 ? dir.clone().normalize() : null,
      hasLookTargets: true,
    };
  }

  if (res.snappedStart || res.snappedGoal) {
    warnings.push({
      code: 'waypoint-snapped', severity: 'warning',
      waypointIds: [res.snappedStart ? a.id : b.id].filter(Boolean),
      message:
        `${res.snappedStart ? a.id : b.id} sits inside a wall or off the floor; ` +
        `it was nudged to the nearest spot the camera can occupy.`,
    });
  }

  const simple = simplifyPath(grid, res.cells, opts.radius);
  const built = buildCurve(
    grid, simple,
    { radius: opts.radius, cameraHeight: opts.cameraHeight },
    fallbackFloorY,
  );

  if (!built || built.length < 1e-4) {
    return {
      curve: null, length: 0, duration: 0.4, polyline: [], warnings,
      startTangent: null, endTangent: null, hasLookTargets: true,
    };
  }

  if (built.violations > 0) {
    warnings.push({
      code: 'curve-clips-wall', severity: 'warning', waypointIds: [a.id, b.id],
      message:
        `The smoothed curve between ${a.id} and ${b.id} clips a wall at ` +
        `${built.violations} sampled point(s).`,
    });
  }

  // Sample the finished curve rather than returning the simplified A* nodes:
  // this is what gets drawn on the floor and on the mini-map, and a polygonal
  // corner-node line would visibly disagree with the curve the camera flies.
  const polyline: Vec3[] = [];
  {
    const steps = Math.max(2, Math.ceil(built.length / 0.15));
    const p = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      built.curve.getPointAt(i / steps, p);
      const { col, row } = worldToCell(grid, p.x, p.z);
      polyline.push([p.x, floorYAtCell(grid, col, row, fallbackFloorY), p.z]);
    }
  }

  return {
    curve: built.curve,
    length: built.length,
    duration: Math.max(0.4, built.length / metresPerSecond),
    polyline,
    warnings,
    startTangent: built.curve.getTangentAt(0).setY(0).normalize(),
    endTangent: built.curve.getTangentAt(1).setY(0).normalize(),
    hasLookTargets: true,
  };
}

/* -------------------------------------------------------------------------- */

type FittedShot = {
  shotType: ShotType;
  ctx: ShotContext;
  degraded: boolean;
  fellBackToHold: boolean;
};

/**
 * Keep a shot inside the room.
 *
 * An orbit at full sweep in a corner will swing the camera through a wall. Try
 * progressively gentler versions before giving up, and only then fall back to a
 * hold - a smaller move is a better outcome than a broken one, and a hold is a
 * better outcome than flying through a wall.
 */
function fitShotToRoom(
  grid: WalkGrid,
  shotType: ShotType,
  ctx: ShotContext,
  radius: number,
): FittedShot {
  const SAMPLES = 24;
  const clips = (candidate: ShotContext, type: ShotType): boolean => {
    for (let i = 0; i <= SAMPLES; i++) {
      const { position } = sampleShot(type, candidate, i / SAMPLES);
      const { col, row } = worldToCell(grid, position.x, position.z);
      if (!isPassable(grid, col, row, radius)) return true;
    }
    return false;
  };

  if (!clips(ctx, shotType)) {
    return { shotType, ctx, degraded: false, fellBackToHold: false };
  }
  for (const scale of [0.6, 0.35, 0.15]) {
    const softer: ShotContext = { ...ctx, intensity: ctx.intensity * scale };
    if (!clips(softer, shotType)) {
      return { shotType, ctx: softer, degraded: true, fellBackToHold: false };
    }
  }
  return {
    shotType: 'hold',
    ctx: { ...ctx, intensity: 0 },
    degraded: true,
    fellBackToHold: true,
  };
}

/* -------------------------------------------------------------------------- */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Seconds over which a travel leg eases off its neighbouring shot's pose.
 *
 * A fixed duration, not a fixed fraction of the leg. As a fraction, a short
 * hop compressed the entire turn into two or three frames and produced a
 * 50-degree-per-frame snap - the very discontinuity the blend exists to
 * remove. Capped at 40% of the leg so a very short leg still spends some of
 * itself actually travelling.
 */
const BLEND_SECONDS = 0.45;

/** How far ahead a travelling camera looks, in metres. */
const LOOK_AHEAD_DISTANCE = 3;

/**
 * Unit direction from `from` to `to`, falling back when they coincide.
 *
 * A look target that lands on the camera has no direction, and normalising it
 * yields a zero vector that then poisons whatever it is blended with.
 */
function safeDirection(to: THREE.Vector3, from: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  const d = to.clone().sub(from);
  if (d.lengthSq() < 1e-6) return fallback.clone().normalize();
  return d.normalize();
}

function blendFractionFor(durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0.4;
  return Math.min(0.4, Math.max(0.05, BLEND_SECONDS / durationSeconds));
}

/**
 * 1 at e = 0, smoothly 0 by e = `span`.
 *
 * Smoothstep rather than linear so the correction's velocity is continuous
 * too: a linear fade removes the position jump but replaces it with a visible
 * kink where the correction stops being applied.
 */
function blendOut(e: number, span: number): number {
  if (e <= 0) return 1;
  if (e >= span) return 0;
  const x = 1 - e / span;
  return x * x * (3 - 2 * x);
}

/**
 * Eye height for a waypoint. Waypoint positions are floor points, so the
 * camera's y comes from the floor sampled at that cell plus the camera height -
 * which keeps the camera level over an uneven or multi-level floor.
 */
export function cameraYAt(
  grid: WalkGrid,
  position: Vec3,
  cameraHeight: number,
  fallbackFloorY: number,
): number {
  const { col, row } = worldToCell(grid, position[0], position[2]);
  return floorYAtCell(grid, col, row, fallbackFloorY) + cameraHeight;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function withWarnings(result: PathResult, warnings: PathWarning[]): PathResult {
  return { ...result, warnings };
}
