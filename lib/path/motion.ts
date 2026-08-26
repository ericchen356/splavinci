/**
 * Camera motion for a single shot.
 *
 * Every shot type is expressed as a function of one normalised parameter, so
 * the timeline can sample any of them the same way. Amplitude is scaled by the
 * resolved `intensity`, which is what makes a half-manual orbit a real orbit
 * with a gentler sweep instead of a different shot.
 *
 * Shots are validated against the walk grid after the fact (see generate.ts):
 * an orbit that would swing the camera through a wall gets its intensity pulled
 * down and, failing that, degrades to a hold - visibly less interesting, but
 * never broken.
 */

import * as THREE from 'three';
import type { ShotAim, ShotType, Vec3 } from '@/lib/types';
import { easeInOut } from './curve';

export type ShotContext = {
  /** Where the waypoint sits. */
  anchor: THREE.Vector3;
  /** What the shot frames. Equal to anchor when there is nothing to frame. */
  target: THREE.Vector3;
  /** Direction of travel through the waypoint, normalised and horizontal. */
  tangent: THREE.Vector3;
  /** 0..1 move amplitude. */
  intensity: number;
  /** True when `target` is a real point to frame rather than the anchor itself. */
  hasTarget: boolean;
  /** Explicit arc for a pan, in absolute bearings. Null derives one. */
  aim?: ShotAim | null;
  /**
   * Room to move at the anchor, in metres to the nearest obstacle.
   *
   * Shot amplitudes used to be fixed constants - a 110 degree orbit at up to
   * 3.2 m radius - which in an ordinary room clips a wall immediately. The
   * validator then reduced the amplitude three times and, failing, replaced
   * the shot with a hold, so choosing orbit or push-in appeared to do nothing
   * at all. A shot should fit the space it is in rather than be swapped for a
   * different shot.
   */
  clearance?: number;
  /**
   * Metres the camera may travel FORWARD along its view axis before its body
   * meets something. Undefined means unmeasured, and nothing limits the move.
   *
   * The shots that travel along that axis - push-in, and pull-back, which
   * starts advanced and retreats - used to be limited by `clearance` instead,
   * which is the radius of the largest sphere that fits around the camera. That
   * is the wrong measurement for a move in one direction: a wall 1.2 m BEHIND
   * the camera has nothing to do with how far forward it may go, and it was
   * capping every push-in in a room three times that deep. Measured along the
   * actual axis, the limit is the thing the shot would actually run into.
   */
  axialReach?: number;
  /**
   * Safety scale on ANGULAR amplitude, owned by the wall validator.
   *
   * Separate from `intensity` because the two answer to different people.
   * Intensity is the user's move size and deliberately no longer touches
   * angle; the validator still needs some way to shrink an arc that clips, and
   * without one it could only reduce a quantity orbit does not use, fail, and
   * substitute a hold. Defaults to 1 and is never surfaced as a control.
   */
  fitScale?: number;
};

export type CameraSample = { position: THREE.Vector3; lookAt: THREE.Vector3 };

/**
 * Amplitude constants, in metres or radians.
 *
 * Intensity scales the DISTANCE terms only. The angular ones are owned by the
 * aim dial, because two controls for one quantity is worse than either: move
 * size used to widen a pan's arc, the dial set it outright, and the moment the
 * dial was touched move size silently stopped doing anything to it. Angle is
 * the dial's, distance is move size's, and neither reaches into the other.
 */
const AMPLITUDE = {
  orbitSweep: (110 * Math.PI) / 180,
  panSweep: (75 * Math.PI) / 180,
  /**
   * Share of the distance to the subject that a push-in closes, and that a
   * pull-back opens up, at intensity 1.
   *
   * Was 0.45, which never got to mean anything: the clamp beside it was the
   * omnidirectional clearance, so a push-in in an ordinary room travelled
   * whatever that happened to be - 0.96 m at every emphasis from 20% to 200%,
   * measured. With the clamp now measured along the shot's own axis, the
   * fraction is what actually sets the size of the move, and closing most of
   * the gap to the subject is what a push-in is. Emphasis scales it further,
   * up to the room the axis really has.
   */
  pushInFraction: 0.8,
  pullBackFraction: 0.8,
  riseHeight: 1.4,
  dollyLength: 1.8,
  /**
   * Slow translation carried through a pan, in metres at intensity 1.
   *
   * A pan is nominally rotation only, and a locked-off camera between two
   * moves is exactly what reads as robotic: the flythrough becomes static,
   * move, static, move, and no amount of easing rescues a shot that does not
   * move. Half a metre over several seconds is far too slow to read as a
   * dolly - it reads as the camera being alive - and it keeps velocity
   * continuous into the legs either side instead of stopping dead at both.
   * `hold` is deliberately excluded: holding still is its entire purpose.
   */
  panDrift: 0.55,
  minTargetRadius: 0.9,
  // Past this an "orbit" stops reading as a move around a subject and starts
  // reading as the camera relocating across the room.
  maxOrbitRadius: 3.2,
};

function horizontalDelta(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
}

/**
 * How far a shot may travel along its view axis, with a margin.
 *
 * The margin is not caution about the measurement - `axialReach` already
 * carries the camera's body - it is about where the shot ENDS. Travelling the
 * whole way parks the camera flush against whatever it was framing, which is
 * not a push-in, it is a collision that happens to stop in time.
 *
 * Falls back to the omnidirectional clearance where nothing measured the axis
 * (the panel's live preview before a grid exists), and to unlimited where
 * neither is known - the wall validator is downstream of this either way.
 */
function axialRoom(ctx: ShotContext): number {
  if (ctx.axialReach !== undefined) return ctx.axialReach * 0.85;
  if (ctx.clearance !== undefined) return ctx.clearance * 0.8;
  return Infinity;
}

/**
 * Sample a shot at u in [0,1].
 *
 * u is the eased parameter, not raw time - callers pass easeInOut(t) so a shot
 * accelerates out of the previous stop and settles into the next.
 */
export function sampleShot(shotType: ShotType, ctx: ShotContext, u: number): CameraSample {
  // Not clamped to 1: emphasis above 100% is a real request for a bigger
  // move, and generate.ts pulls back anything that would clip a wall.
  const k = Math.max(0, ctx.intensity);
  const fit = ctx.fitScale === undefined ? 1 : Math.max(0, ctx.fitScale);
  const t = Math.max(0, Math.min(1, u));
  const anchor = ctx.anchor;

  // An explicit aim replaces whatever the shot inferred to frame. Applied here,
  // once, so every shot type honours it rather than only the sweeping ones -
  // a push-in at a blank wall is just as wrong as a pan across one, and the
  // only other way out was to move the waypoint.
  const aimed = ctx.aim
    ? new THREE.Vector3(
        anchor.x + Math.cos(ctx.aim.from) * Math.max(AMPLITUDE.minTargetRadius, horizontalDelta(anchor, ctx.target).length()),
        ctx.target.y,
        anchor.z + Math.sin(ctx.aim.from) * Math.max(AMPLITUDE.minTargetRadius, horizontalDelta(anchor, ctx.target).length()),
      )
    : ctx.target;
  const target = aimed;

  const toTarget = horizontalDelta(anchor, target);
  const radius = Math.max(AMPLITUDE.minTargetRadius, toTarget.length());
  // An aimed shot always has something to point at, by construction.
  const hasTarget = ctx.aim ? true : ctx.hasTarget && toTarget.lengthSq() > 1e-6;

  switch (shotType) {
    case 'hold':
      return { position: anchor.clone(), lookAt: target.clone() };

    case 'orbit': {
      // Orbit a subject NEAR the waypoint, not whatever the shot nominally
      // frames. Framing falls back to the room's centre, and orbiting that at
      // its true radius swings the camera across the whole space: from a
      // corner of a 10x8 m flat the arc ran 6 m and ended 5.6 m from the
      // marker the user placed, and a waypoint sitting exactly at the centre
      // got radius 0 - a completely static frame still labelled "orbit".
      // Clamping the radius and pulling the centre in keeps the camera where
      // it was put, and guarantees the shot actually moves.
      const dir = hasTarget
        ? toTarget.clone().normalize()
        : ctx.tangent.clone().setY(0).normalize();
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
      const roomFor = ctx.clearance !== undefined
        ? Math.max(AMPLITUDE.minTargetRadius * 0.5, ctx.clearance * 0.85)
        : AMPLITUDE.maxOrbitRadius;
      // Radius answers to move size, arc answers to the dial. Those are the
      // two things an orbit genuinely has, and until now the slider drove
      // neither of them - it was measurably inert for this shot at every
      // setting, because arc had been handed to the dial and radius was never
      // scaled by anything the user could reach.
      const natural = Math.max(
        hasTarget ? toTarget.length() : 0,
        AMPLITUDE.minTargetRadius * 0.5,
      );
      const orbitRadius = Math.min(
        natural * Math.max(0.15, k),
        AMPLITUDE.maxOrbitRadius,
        roomFor,
      ) * (fit < 1 ? fit : 1);
      const centre = anchor.clone().addScaledVector(dir, orbitRadius);
      // Sweep centred on the waypoint's own bearing, so the shot starts where
      // the camera already is rather than teleporting to the arc's start -
      // unless an explicit arc says otherwise, which is then taken verbatim.
      const start = Math.atan2(anchor.z - centre.z, anchor.x - centre.x);
      const angle = ctx.aim && Math.abs(ctx.aim.sweep) > 1e-4
        ? start + ctx.aim.sweep * fit * (t - 0.5)
        : start + (t - 0.5) * AMPLITUDE.orbitSweep * fit;
      return {
        position: new THREE.Vector3(
          centre.x + Math.cos(angle) * orbitRadius,
          anchor.y,
          centre.z + Math.sin(angle) * orbitRadius,
        ),
        lookAt: centre.setY(target.y),
      };
    }

    case 'push-in': {
      if (!hasTarget) return dolly(anchor, ctx.tangent, k, t, null, ctx);
      const travel = Math.min(radius * AMPLITUDE.pushInFraction * k, axialRoom(ctx));
      const dir = toTarget.clone().normalize();
      return {
        position: anchor.clone().addScaledVector(dir, travel * t),
        lookAt: target.clone(),
      };
    }

    case 'pull-back': {
      if (!hasTarget) return dolly(anchor, ctx.tangent.clone().negate(), k, t, null, ctx);
      // Forward room, not backward: a pull-back STARTS advanced on its subject
      // and retreats to the anchor, so the far end of it is the one that has to
      // fit.
      const travel = Math.min(radius * AMPLITUDE.pullBackFraction * k, axialRoom(ctx));
      const dir = toTarget.clone().normalize();
      // Starts close and retreats to the waypoint, revealing context.
      return {
        position: anchor.clone().addScaledVector(dir, travel * (1 - t)),
        lookAt: target.clone(),
      };
    }

    case 'pan': {
      // Camera stays put; the look direction sweeps.
      const distance = Math.max(radius, AMPLITUDE.minTargetRadius);

      // An explicit sector is taken verbatim - it is the whole point of the
      // control, so intensity does not narrow it.
      // Drift gently along the route so the camera is never dead still.
      const drift = ctx.tangent.lengthSq() > 1e-6
        ? ctx.tangent.clone().normalize()
        : new THREE.Vector3(0, 0, 1);
      const travelled = AMPLITUDE.panDrift * k * (t - 0.5);
      const eye = anchor.clone().addScaledVector(drift, travelled);

      if (ctx.aim) {
        const angle = ctx.aim.from + ctx.aim.sweep * t;
        return {
          position: eye,
          lookAt: new THREE.Vector3(
            eye.x + Math.cos(angle) * distance,
            target.y,
            eye.z + Math.sin(angle) * distance,
          ),
        };
      }

      const base = hasTarget ? toTarget.clone() : ctx.tangent.clone().multiplyScalar(distance);
      if (base.lengthSq() < 1e-6) base.set(0, 0, distance);
      const angle = (t - 0.5) * AMPLITUDE.panSweep * fit;
      const swept = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      return {
        position: eye,
        lookAt: new THREE.Vector3(eye.x + swept.x, target.y, eye.z + swept.z),
      };
    }

    case 'rise': {
      const lift = AMPLITUDE.riseHeight * k * t;
      const position = new THREE.Vector3(anchor.x, anchor.y + lift, anchor.z);
      return {
        position,
        lookAt: hasTarget ? target.clone() : aheadOf(position, ctx.tangent),
      };
    }

    case 'dolly-through':
    default:
      return dolly(anchor, ctx.tangent, k, t, hasTarget ? target : null, ctx);
  }
}

/** Travel along the path tangent, centred on the waypoint. */
function dolly(
  anchor: THREE.Vector3,
  tangent: THREE.Vector3,
  k: number,
  t: number,
  target: THREE.Vector3 | null = null,
  ctx?: { clearance?: number },
): CameraSample {
  const dir = tangent.lengthSq() > 1e-6 ? tangent.clone().normalize() : new THREE.Vector3(0, 0, 1);
  const room = ctx?.clearance !== undefined ? ctx.clearance * 1.6 : Infinity;
  const length = Math.min(AMPLITUDE.dollyLength * k, room);
  const half = length / 2;
  const position = anchor.clone().addScaledVector(dir, -half + length * t);
  return { position, lookAt: target ? target.clone() : aheadOf(position, dir) };
}

function aheadOf(from: THREE.Vector3, tangent: THREE.Vector3): THREE.Vector3 {
  const dir = tangent.lengthSq() > 1e-6 ? tangent.clone().normalize() : new THREE.Vector3(0, 0, 1);
  return from.clone().addScaledVector(dir, 3);
}

/** Convenience: sample with the standard ease applied. */
export function sampleShotEased(shotType: ShotType, ctx: ShotContext, t: number): CameraSample {
  return sampleShot(shotType, ctx, easeInOut(t));
}

export function vec3(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}
