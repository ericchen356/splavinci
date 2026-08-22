'use client';

/**
 * Free-look camera navigation, kept OUT of RoomScene so each screen can bring
 * its own rig (the review screen will drive the camera off the frame table
 * instead of off user input).
 *
 * Two modes:
 *  - 'orbit'  — drei OrbitControls around a target. Good for inspecting.
 *  - 'fly'    — drag to look, WASD to move, Q/E for down/up. Good for walking
 *               the room the way the final flythrough will.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Vec3 } from '@/lib/types';

export type CameraMode = 'orbit' | 'fly';

export type CameraRigProps = {
  mode?: CameraMode;
  /** Orbit pivot. Ignored in fly mode. */
  target?: Vec3;
  enabled?: boolean;
  /** Fly-mode metres per second. Shift multiplies by 3. */
  moveSpeed?: number;
  /** Fly-mode radians per pixel of drag. */
  lookSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
};

const DEFAULT_TARGET: Vec3 = [5, 1.2, 4];

export function CameraRig({
  mode = 'orbit',
  target = DEFAULT_TARGET,
  enabled = true,
  moveSpeed = 3.2,
  lookSpeed = 0.0026,
  minDistance = 0.2,
  maxDistance = 60,
}: CameraRigProps) {
  if (mode === 'fly') {
    return <FlyControls enabled={enabled} moveSpeed={moveSpeed} lookSpeed={lookSpeed} />;
  }
  return (
    <OrbitControls
      makeDefault
      enabled={enabled}
      target={target}
      enableDamping
      dampingFactor={0.08}
      minDistance={minDistance}
      maxDistance={maxDistance}
      // Stop the orbit from dropping under the floor.
      maxPolarAngle={Math.PI * 0.495}
    />
  );
}

/* --------------------------------- fly mode -------------------------------- */

type FlyProps = { enabled: boolean; moveSpeed: number; lookSpeed: number };

function FlyControls({ enabled, moveSpeed, lookSpeed }: FlyProps) {
  const camera = useThree((s) => s.camera);
  const domElement = useThree((s) => s.gl.domElement);
  const invalidate = useThree((s) => s.invalidate);

  const keys = useRef<Set<string>>(new Set());
  const dragging = useRef(false);
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      move: new THREE.Vector3(),
    }),
    [],
  );

  // Seed the yaw/pitch from wherever the camera currently is, so switching
  // from orbit to fly does not snap the view.
  useEffect(() => {
    euler.current.setFromQuaternion(camera.quaternion, 'YXZ');
  }, [camera, enabled]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      dragging.current = true;
      domElement.setPointerCapture(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging.current = false;
      if (domElement.hasPointerCapture(e.pointerId)) domElement.releasePointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      euler.current.y -= e.movementX * lookSpeed;
      euler.current.x -= e.movementY * lookSpeed;
      const limit = Math.PI / 2 - 0.02;
      euler.current.x = Math.max(-limit, Math.min(limit, euler.current.x));
      camera.quaternion.setFromEuler(euler.current);
      invalidate();
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    domElement.addEventListener('pointerdown', onPointerDown);
    domElement.addEventListener('pointerup', onPointerUp);
    domElement.addEventListener('pointercancel', onPointerUp);
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('contextmenu', onContextMenu);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('pointerup', onPointerUp);
      domElement.removeEventListener('pointercancel', onPointerUp);
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('contextmenu', onContextMenu);
      keys.current.clear();
      dragging.current = false;
    };
  }, [enabled, domElement, camera, lookSpeed, invalidate]);

  useFrame((_, delta) => {
    if (!enabled || keys.current.size === 0) return;
    const held = keys.current;
    const speed = moveSpeed * (held.has('ShiftLeft') || held.has('ShiftRight') ? 3 : 1);

    camera.getWorldDirection(scratch.forward).normalize();
    scratch.right.crossVectors(scratch.forward, scratch.up).normalize();
    scratch.move.set(0, 0, 0);

    if (held.has('KeyW') || held.has('ArrowUp')) scratch.move.add(scratch.forward);
    if (held.has('KeyS') || held.has('ArrowDown')) scratch.move.sub(scratch.forward);
    if (held.has('KeyD') || held.has('ArrowRight')) scratch.move.add(scratch.right);
    if (held.has('KeyA') || held.has('ArrowLeft')) scratch.move.sub(scratch.right);
    if (held.has('KeyE') || held.has('Space')) scratch.move.add(scratch.up);
    if (held.has('KeyQ')) scratch.move.sub(scratch.up);

    if (scratch.move.lengthSq() === 0) return;
    camera.position.addScaledVector(scratch.move.normalize(), speed * delta);
    invalidate();
  });

  return null;
}

/* ------------------------------ camera presets ----------------------------- */

export type CameraPreset = {
  id: string;
  label: string;
  position: Vec3;
  target: Vec3;
};

/**
 * Handy viewpoints for the fixture room (x 0..10, y 0..2.7, z 0..8). The
 * overhead one clears the 2.7 m walls, which is what makes the collider
 * wireframe readable.
 */
export const CAMERA_PRESETS: readonly CameraPreset[] = [
  { id: 'interior', label: 'Interior', position: [1.5, 1.65, 1.5], target: [5.5, 1.2, 4.2] },
  { id: 'overhead', label: 'Overhead', position: [5, 17, 4.2], target: [5, 0, 4] },
  { id: 'corner', label: 'Corner', position: [-4.5, 7.5, -3.5], target: [5, 0.8, 4] },
  { id: 'bedroom', label: 'Bedroom', position: [7.2, 1.6, 5.6], target: [8.6, 0.9, 2.4] },
];

/** Minimal shape of whatever `useThree().controls` happens to be. */
type TargetedControls = { target: THREE.Vector3; update: () => void };

function hasTarget(controls: unknown): controls is TargetedControls {
  return (
    !!controls &&
    typeof controls === 'object' &&
    'target' in controls &&
    (controls as TargetedControls).target instanceof THREE.Vector3
  );
}

/**
 * Imperatively move the default camera (and any OrbitControls) to a preset.
 * `nonce` lets the same preset be re-applied — bump it to re-run.
 */
export function CameraPresetDriver({
  preset,
  nonce = 0,
}: {
  preset: CameraPreset | null;
  nonce?: number;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!preset) return;
    camera.position.set(...preset.position);
    if (hasTarget(controls)) {
      controls.target.set(...preset.target);
      controls.update();
    } else {
      camera.lookAt(new THREE.Vector3(...preset.target));
    }
    invalidate();
  }, [preset, nonce, camera, controls, invalidate]);

  return null;
}
