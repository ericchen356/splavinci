/**
 * Step 4 of path generation: resolve what each waypoint's shot actually is.
 *
 * Each waypoint carries a controlSpectrum from 0 (let the system decide) to 1
 * (do exactly what I picked). The two ends are easy. The middle is the point of
 * the feature, and it needs care, because the three things being resolved do
 * not interpolate the same way:
 *
 *   duration   genuinely continuous - lerp it.
 *   intensity  genuinely continuous - lerp it. This is what stops the midpoint
 *              from being a hard switch: a half-manual orbit is a real orbit
 *              with a gentler sweep, not a different shot.
 *   shotType   categorical. There is no halfway between "orbit" and "pan", so
 *              it changes over at 0.5. That is a judgement call rather than a
 *              derivation, so both candidates and the blend factor are reported
 *              and the UI can show which side of the line a waypoint sits on.
 *
 * The auto end infers from the nearest object's proportions rather than its
 * name, so it behaves sensibly on a capture whose labels we have never seen.
 */

import type { PathStyle, ShotType, Vec3, Waypoint } from '@/lib/types';

/** Minimal object description the inference needs. */
export type ShotObject = {
  id: string;
  position: Vec3;
  /** World-space extents. Inference falls back to a generic shot without it. */
  size?: Vec3;
  radius?: number;
  label?: string;
};

export type StylePreset = {
  /** Travel speed in metres per second. */
  metresPerSecond: number;
  /** Multiplier on inferred shot durations. */
  dwell: number;
  /** Default move amplitude at the fully-auto end. */
  intensity: number;
  /** Extra seconds of settle added between moves. */
  settle: number;
};

export const STYLE_PRESETS: Record<PathStyle, StylePreset> = {
  // Slow and lingering; the camera is in no hurry.
  cozy: { metresPerSecond: 0.75, dwell: 1.25, intensity: 0.8, settle: 0.35 },
  // Brisk and even. Covers ground, never dawdles, never rushes.
  realEstate: { metresPerSecond: 1.15, dwell: 0.9, intensity: 0.7, settle: 0.15 },
  // Slowest and widest. Big moves, long holds.
  cinematic: { metresPerSecond: 0.62, dwell: 1.55, intensity: 1.0, settle: 0.5 },
  // Fast tour. Short shots, small moves.
  quick: { metresPerSecond: 1.9, dwell: 0.55, intensity: 0.5, settle: 0.05 },
};

/** Past this distance a waypoint is framing the room, not an object. */
export const MAX_TARGET_DISTANCE = 3.6;

/** Where shotType flips from the inferred choice to the user's. */
export const SHOT_TYPE_CROSSOVER = 0.5;

export type ShotIntent = {
  waypointId: string;
  /** The shot that will actually be rendered. */
  shotType: ShotType;
  /** Seconds this shot occupies. */
  duration: number;
  /** 0..1 amplitude applied to the move. */
  intensity: number;
  /** Object being framed, if any. */
  targetObjectId: string | null;
  /** World point the camera looks at during the shot. */
  targetPoint: Vec3;
  /** Distance from the waypoint to its target. */
  targetDistance: number;
  /** Which end of the spectrum won the shotType. */
  source: 'auto' | 'manual' | 'blended';
  blend: number;
  autoShotType: ShotType;
  autoDuration: number;
  manualShotType: ShotType;
  manualDuration: number;
  /** Short human-readable justification, shown in the waypoint panel. */
  reason: string;
};

/* -------------------------------------------------------------------------- */

function dist2(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function objectRadius(o: ShotObject): number {
  if (o.radius !== undefined) return o.radius;
  if (o.size) return Math.hypot(o.size[0], o.size[1], o.size[2]) / 2;
  return 0.5;
}

/** Nearest object to a point, within MAX_TARGET_DISTANCE. */
export function nearestObject(
  position: Vec3,
  objects: readonly ShotObject[],
  maxDistance = MAX_TARGET_DISTANCE,
): { object: ShotObject; distance: number } | null {
  let best: ShotObject | null = null;
  let bestD2 = Infinity;
  for (const o of objects) {
    const d2 = dist2(position, o.position);
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  if (!best) return null;
  const distance = Math.sqrt(bestD2);
  // Measure to the object's surface, so a large object stays "near" from
  // further away than a small one.
  if (distance - objectRadius(best) > maxDistance) return null;
  return { object: best, distance };
}

/**
 * Infer a shot from an object's proportions.
 *
 * Deliberately geometric rather than label-driven: "wardrobe" means nothing on
 * a capture we have not seen, but "twice as tall as it is wide" always means
 * the interesting axis is vertical.
 */
export function inferShotType(target: ShotObject | null): { shotType: ShotType; reason: string } {
  if (!target) {
    return { shotType: 'dolly-through', reason: 'open space, nothing close to frame' };
  }
  if (!target.size) {
    // Known target, unknown proportions: move in rather than guess a big move.
    return { shotType: 'push-in', reason: `moves in on ${target.label ?? target.id}` };
  }

  const [sx, sy, sz] = target.size;
  const spread = Math.max(sx, sz);
  const thin = Math.max(1e-3, Math.min(sx, sz));
  const footprint = sx * sz;
  const name = target.label ?? target.id;

  if (sy >= 1.8) {
    return { shotType: 'rise', reason: `${name} is tall (${sy.toFixed(1)} m) - lift to take it in` };
  }
  if (sy >= 1.0 && sy >= 1.4 * spread) {
    return { shotType: 'rise', reason: `${name} reads vertical - lift along it` };
  }
  if (spread >= 2.6 * thin && spread >= 1.0) {
    return { shotType: 'pan', reason: `${name} is long and shallow - sweep across it` };
  }
  if (footprint >= 1.3) {
    return { shotType: 'orbit', reason: `${name} has a big footprint - go around it` };
  }
  return { shotType: 'push-in', reason: `${name} is a detail - move in on it` };
}

/** Inferred shot length: bigger things earn longer looks. */
export function inferDuration(
  shotType: ShotType,
  target: ShotObject | null,
  preset: StylePreset,
): number {
  const radius = target ? objectRadius(target) : 0.6;

  // Base seconds per shot type, before size and style are applied.
  const base: Record<ShotType, number> = {
    orbit: 4.2,
    'push-in': 3.0,
    'pull-back': 3.2,
    pan: 3.4,
    'dolly-through': 2.6,
    rise: 3.4,
    hold: 2.0,
  };

  const sizeBonus = Math.min(2.4, radius * 1.6);
  const seconds = (base[shotType] + sizeBonus) * preset.dwell;
  return clamp(seconds, 0.8, 14);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* -------------------------------------------------------------------------- */

/** Resolve one waypoint's shot against the spectrum. */
export function resolveShot(
  waypoint: Waypoint,
  objects: readonly ShotObject[],
  style: PathStyle,
): ShotIntent {
  const preset = STYLE_PRESETS[style];
  const blend = clamp(waypoint.controlSpectrum, 0, 1);

  // An explicit target wins; otherwise frame whatever is nearest.
  const explicit = waypoint.targetObjectId
    ? (objects.find((o) => o.id === waypoint.targetObjectId) ?? null)
    : null;
  const near = explicit
    ? { object: explicit, distance: Math.sqrt(dist2(waypoint.position, explicit.position)) }
    : nearestObject(waypoint.position, objects);

  const target = near?.object ?? null;
  const inferred = inferShotType(target);
  const autoShotType = inferred.shotType;
  const autoDuration = inferDuration(autoShotType, target, preset);

  const manualShotType = waypoint.shotType;
  const manualDuration = waypoint.duration;

  // Categorical: has to pick a side. Continuous: actually blends.
  const shotType = blend >= SHOT_TYPE_CROSSOVER ? manualShotType : autoShotType;
  const duration = clamp(lerp(autoDuration, manualDuration, blend), 0.4, 30);
  const intensity = clamp(lerp(preset.intensity, 1, blend), 0, 1);

  const source: ShotIntent['source'] =
    blend <= 0.001 ? 'auto' : blend >= 0.999 ? 'manual' : 'blended';

  const reason =
    source === 'manual'
      ? `you chose ${manualShotType} for ${manualDuration.toFixed(1)}s`
      : source === 'auto'
        ? inferred.reason
        : `${Math.round(blend * 100)}% manual - ${shotType} at ${duration.toFixed(1)}s ` +
          `(auto suggested ${autoShotType} at ${autoDuration.toFixed(1)}s)`;

  const targetPoint: Vec3 = target
    ? target.position
    : [waypoint.position[0], waypoint.position[1], waypoint.position[2]];

  return {
    waypointId: waypoint.id,
    shotType,
    duration,
    intensity,
    targetObjectId: target?.id ?? null,
    targetPoint,
    targetDistance: near?.distance ?? 0,
    source,
    blend,
    autoShotType,
    autoDuration,
    manualShotType,
    manualDuration,
    reason,
  };
}

/** Build ShotObjects from anything carrying id/position and optional bounds. */
export function toShotObjects(
  items: readonly {
    id?: string;
    position?: Vec3;
    size?: Vec3;
    radius?: number;
    label?: string;
    spec?: { id: string; position: Vec3; label: string };
  }[],
): ShotObject[] {
  const out: ShotObject[] = [];
  for (const item of items) {
    const id = item.spec?.id ?? item.id;
    const position = item.position ?? item.spec?.position;
    if (!id || !position) continue;
    out.push({
      id,
      position,
      size: item.size,
      radius: item.radius,
      label: item.label ?? item.spec?.label,
    });
  }
  return out;
}
