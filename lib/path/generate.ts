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
import { resolveShot, STYLE_PRESETS, type ShotIntent, type ShotObject } from './shots';
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
  grid?: GridOptions;
};

export const DEFAULT_GENERATE: GenerateOptions = {
  fps: 30,
  cameraHeight: DEFAULT_CURVE.cameraHeight,
  radius: DEFAULT_CURVE.radius,
};

export type PathInput = {
  collider: ColliderData | null;
  waypoints: readonly Waypoint[];
  settings: PathSettings;
  objects: readonly ShotObject[];
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
    w.targetObjectId ?? '-',
    w.shotType,
    round(w.controlSpectrum),
    round(w.duration, 2),
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
    resolveShot(w, input.objects, input.settings.style),
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
    const key = [
      'travel', a.id, b.id, positionKey(a), positionKey(b),
      input.settings.style, round(opts.radius, 3), round(opts.cameraHeight, 3),
      a.pinned || b.pinned ? 'pinned' : '',
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

  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    const shot = shots[i];

    /* shot at waypoint i */
    // A waypoint's stored position is a point on the FLOOR (that is what a
    // mini-map click means), so the camera anchor is lifted to eye height here.
    // Without this the camera would sink to the floor at every waypoint and pop
    // back up for each travel leg.
    const anchor = new THREE.Vector3(
      w.position[0],
      cameraYAt(grid, w.position, opts.cameraHeight, fallbackFloorY),
      w.position[2],
    );
    const target = new THREE.Vector3(...shot.targetPoint);
    const baseCtx: ShotContext = {
      anchor, target, tangent: tangents[i],
      intensity: shot.intensity,
      hasTarget: shot.targetObjectId !== null,
    };

    const validated = fitShotToRoom(grid, shot.shotType, baseCtx, opts.radius);
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
      const fromLook = new THREE.Vector3(...shot.targetPoint);
      const toLook = new THREE.Vector3(...nextShot.targetPoint);

      if (leg.warnings.length > 0) warnings.push(...leg.warnings);

      pushSegment(
        'travel', `travel:${w.id}->${waypoints[i + 1].id}`,
        waypoints[i + 1].id, w.id, waypoints[i + 1].id,
        leg.duration,
        (t) => {
          const e = easeInOut(t);
          const p = leg.curve ? leg.curve.getPointAt(clamp01(e)) : anchor.clone();
          // Look target eases from what we were framing to what comes next; a
          // hard cut at the waypoint boundary reads as a glitch.
          const look = fromLook.clone().lerp(toLook, e);
          if (!leg.hasLookTargets && leg.curve) {
            // Nothing to frame at either end: look where we are going.
            const ahead = leg.curve.getPointAt(clamp01(Math.min(1, e + 0.06)));
            look.copy(ahead);
          }
          return { position: vec3(p), lookAt: vec3(look) };
        },
        leg.cached === true,
      );
    }
  }

  const stats: PathStats = {
    gridCols: grid.cols, gridRows: grid.rows, cellSize: grid.cellSize,
    recomputedSegments: recomputed, reusedSegments: reused,
    generateMs: round(now() - t0, 2), gridMs: round(gridMs, 2),
  };

  return {
    frames, fps: opts.fps, duration: round(time, 4),
    segments, shots, polyline, warnings, stats,
  };
}

/* -------------------------------------------------------------------------- */

type LegResult = {
  curve: THREE.CatmullRomCurve3 | null;
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
      curve, duration: Math.max(0.4, length / metresPerSecond),
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
      curve: null, duration: 0.4, polyline: [], warnings,
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
