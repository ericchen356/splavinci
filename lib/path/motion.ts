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
import type { ShotType, Vec3 } from '@/lib/types';
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
  /** True when `target` is a real object rather than the anchor itself. */
  hasTarget: boolean;
};

export type CameraSample = { position: THREE.Vector3; lookAt: THREE.Vector3 };

/** Amplitude constants, in metres or radians at intensity 1. */
const AMPLITUDE = {
  orbitSweep: (110 * Math.PI) / 180,
  panSweep: (75 * Math.PI) / 180,
  pushInFraction: 0.45,
  pullBackFraction: 0.45,
  riseHeight: 1.4,
  dollyLength: 1.8,
  minTargetRadius: 0.9,
};

function horizontalDelta(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
}

/**
 * Sample a shot at u in [0,1].
 *
 * u is the eased parameter, not raw time - callers pass easeInOut(t) so a shot
 * accelerates out of the previous stop and settles into the next.
 */
export function sampleShot(shotType: ShotType, ctx: ShotContext, u: number): CameraSample {
  const k = Math.max(0, Math.min(1, ctx.intensity));
  const t = Math.max(0, Math.min(1, u));
  const anchor = ctx.anchor;
  const target = ctx.target;

  const toTarget = horizontalDelta(anchor, target);
  const radius = Math.max(AMPLITUDE.minTargetRadius, toTarget.length());
  const hasTarget = ctx.hasTarget && toTarget.lengthSq() > 1e-6;

  switch (shotType) {
    case 'hold':
      return { position: anchor.clone(), lookAt: target.clone() };

    case 'orbit': {
      if (!hasTarget) return { position: anchor.clone(), lookAt: aheadOf(anchor, ctx.tangent) };
      // Sweep centred on the waypoint's own bearing, so the shot starts where
      // the camera already is rather than teleporting to the arc's start.
      const start = Math.atan2(anchor.z - target.z, anchor.x - target.x);
      const angle = start + (t - 0.5) * AMPLITUDE.orbitSweep * k;
      return {
        position: new THREE.Vector3(
          target.x + Math.cos(angle) * radius,
          anchor.y,
          target.z + Math.sin(angle) * radius,
        ),
        lookAt: target.clone(),
      };
    }

    case 'push-in': {
      if (!hasTarget) return dolly(anchor, ctx.tangent, k, t);
      const travel = radius * AMPLITUDE.pushInFraction * k;
      const dir = toTarget.clone().normalize();
      return {
        position: anchor.clone().addScaledVector(dir, travel * t),
        lookAt: target.clone(),
      };
    }

    case 'pull-back': {
      if (!hasTarget) return dolly(anchor, ctx.tangent.clone().negate(), k, t);
      const travel = radius * AMPLITUDE.pullBackFraction * k;
      const dir = toTarget.clone().normalize();
      // Starts close and retreats to the waypoint, revealing context.
      return {
        position: anchor.clone().addScaledVector(dir, travel * (1 - t)),
        lookAt: target.clone(),
      };
    }

    case 'pan': {
      // Camera stays put; the look direction sweeps.
      const base = hasTarget ? toTarget.clone() : ctx.tangent.clone().multiplyScalar(radius);
      if (base.lengthSq() < 1e-6) base.set(0, 0, radius);
      const angle = (t - 0.5) * AMPLITUDE.panSweep * k;
      const swept = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      return {
        position: anchor.clone(),
        lookAt: new THREE.Vector3(anchor.x + swept.x, target.y, anchor.z + swept.z),
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
      return dolly(anchor, ctx.tangent, k, t, hasTarget ? target : null);
  }
}

/** Travel along the path tangent, centred on the waypoint. */
function dolly(
  anchor: THREE.Vector3,
  tangent: THREE.Vector3,
  k: number,
  t: number,
  target: THREE.Vector3 | null = null,
): CameraSample {
  const dir = tangent.lengthSq() > 1e-6 ? tangent.clone().normalize() : new THREE.Vector3(0, 0, 1);
  const half = (AMPLITUDE.dollyLength * k) / 2;
  const position = anchor.clone().addScaledVector(dir, -half + AMPLITUDE.dollyLength * k * t);
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
