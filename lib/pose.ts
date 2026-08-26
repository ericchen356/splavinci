/**
 * Camera pose maths, shared by everything that reads or draws a waypoint.
 *
 * `CameraPose` is stored as yaw/pitch (see lib/types.ts) and consumed as a
 * direction, a quaternion or a look-at point depending on who is asking. The
 * conversions are three lines each and were, until this file existed, written
 * out at each call site - which is how a sign flip ends up in the gizmo but not
 * in the generator, and the frame the user captured is not the frame the
 * flythrough plays. One conversion, one convention, one place to check it.
 *
 * THE CONVENTION, ONCE:
 *   yaw   = Math.atan2(dz, dx)   - the same bearing ShotAim.from uses
 *   pitch = Math.asin(dy)        - positive looks up
 *   direction = (cos p * cos y, sin p, cos p * sin y)
 *
 * Pure three maths, no React: the plan screen, the path generator and the
 * headless scripts all call it.
 */

import * as THREE from 'three';
import type { CameraPose } from '@/lib/types';

/** Field of view assumed when a camera has none of its own (an orthographic
 *  one, or a pose reconstructed from a file that predates the field). */
export const DEFAULT_FOV = 55;

/** Straight up, and the only up this app has - there is no roll to author. */
const UP = new THREE.Vector3(0, 1, 0);

/** How far from vertical the view has to be before `UP` stops working as a
 *  reference for the gizmo's orientation. At dead vertical the cross product
 *  that builds the basis collapses and the frustum spins on its own axis. */
const NEAR_VERTICAL = 0.9995;

/**
 * Unit view direction for a yaw/pitch pair, as a plain triple.
 *
 * Plain rather than a Vector3 so the grid marcher and the shot rule - both of
 * which want three numbers and no allocation - can share this one definition of
 * the convention instead of writing the trig out again.
 */
export function poseAxis(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: cp * Math.cos(yaw), y: Math.sin(pitch), z: cp * Math.sin(yaw) };
}

/** Unit view direction for a yaw/pitch pair. */
export function poseDirection(yaw: number, pitch: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = poseAxis(yaw, pitch);
  return out.set(a.x, a.y, a.z);
}

/** Yaw/pitch for a direction, which need not be normalised. */
export function directionToYawPitch(direction: THREE.Vector3): { yaw: number; pitch: number } {
  const d = direction.lengthSq() > 1e-12 ? direction.clone().normalize() : new THREE.Vector3(0, 0, 1);
  return {
    yaw: Math.atan2(d.z, d.x),
    pitch: Math.asin(Math.max(-1, Math.min(1, d.y))),
  };
}

/**
 * Read the live pose off a three camera.
 *
 * `getWorldDirection` rather than the camera's euler: the fly rig writes a
 * quaternion, a preset writes a look-at, and playback writes a matrix, so the
 * only thing all three agree on is where the camera actually points.
 */
export function poseFromCamera(camera: THREE.Camera): CameraPose {
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const { yaw, pitch } = directionToYawPitch(direction);
  const perspective = camera as THREE.PerspectiveCamera;
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    yaw,
    pitch,
    fov: perspective.isPerspectiveCamera ? perspective.fov : DEFAULT_FOV,
  };
}

/**
 * Rotation that points an object's -Z axis along the pose's view direction.
 *
 * -Z because that is where a three camera looks, so a gizmo modelled as a
 * camera - and any real camera dropped in later - shares one orientation rule.
 */
export function poseQuaternion(
  yaw: number,
  pitch: number,
  out = new THREE.Quaternion(),
): THREE.Quaternion {
  const forward = poseDirection(yaw, pitch);
  // Matrix4.lookAt puts -Z on (target - eye), so the target IS the direction.
  const up = Math.abs(forward.y) > NEAR_VERTICAL ? FALLBACK_UP : UP;
  return out.setFromRotationMatrix(
    scratch.lookAt(ORIGIN, forward, up),
  );
}

const ORIGIN = new THREE.Vector3();
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);
const scratch = new THREE.Matrix4();
