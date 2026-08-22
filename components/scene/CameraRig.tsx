'use client';

/**
 * Free-look camera navigation, kept OUT of RoomScene so each screen can bring
 * its own rig (the review screen drives the camera off the frame table instead
 * of off user input).
 *
 * Fly is the only mode: drag to look, WASD to move, Q/E for down/up. Orbit
 * (drei OrbitControls) used to sit alongside it and was removed - it pivots
 * around a point the user cannot see and cannot be walked through a doorway,
 * which is most of the job on these screens. It was also the only thing
 * publishing `useThree().controls`, so CameraPresetDriver below now points the
 * camera itself rather than moving an orbit pivot.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  cellIndex,
  cellToWorld,
  denseBounds,
  floorYAtCell,
  reachableMask,
  resolveCameraRadius,
  worldToCell,
  type WalkGrid,
} from '@/lib/path';
import type { Vec3 } from '@/lib/types';

/**
 * Camera body radius used when deciding where the camera may stand.
 *
 * Shared with waypoint placement on /plan: a preset that drops the camera
 * somewhere a waypoint could never go is describing a different room.
 */
export const CAMERA_BODY_RADIUS = 0.3;

/** Camera height above the floor directly under it. */
const EYE_HEIGHT = 1.6;

export type CameraRigProps = {
  enabled?: boolean;
  /** Metres per second. Shift multiplies by 3. */
  moveSpeed?: number;
  /** Radians per pixel of drag. */
  lookSpeed?: number;
};

export function CameraRig({
  enabled = true,
  moveSpeed = 3.2,
  lookSpeed = 0.0026,
}: CameraRigProps) {
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

  // Seed the yaw/pitch from wherever the camera currently is, so mounting the
  // rig over an already-framed camera does not snap the view.
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
      // Re-read the orientation here, not just on mount: anything else that
      // moved the camera meanwhile (a preset jump) would otherwise be undone
      // by the first pixel of this drag.
      euler.current.setFromQuaternion(camera.quaternion, 'YXZ');
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
  /**
   * Where the preset looks. With orbit gone this is not a pivot - it only sets
   * the direction the camera faces on arrival; the user is free from there.
   */
  target: Vec3;
};

/**
 * Viewpoints derived from the scene's own geometry.
 *
 * Hardcoded presets only ever fit the room they were written for: values tuned
 * to a 10 x 8 m apartment drop the camera into the dirt of a 30 x 37 m outdoor
 * capture. Everything here is expressed relative to the capture's own extents
 * and floor height, so a capture we have never seen still gets usable framing.
 *
 * Pass `grid` whenever one exists. A walk grid knows two things a collider AABB
 * cannot: where the capture actually has content, and where a camera can stand.
 * Both matter - maple-street's AABB is 14.7 x 12.1 m around 6.8 x 9.1 m of real
 * floor - and Interior in particular is only meaningful in grid terms.
 */
export function derivePresets(
  bounds: THREE.Box3 | null,
  floorY = 0,
  grid: WalkGrid | null = null,
): readonly CameraPreset[] {
  const box = grid ? denseBounds(grid) : bounds;
  if (!box || box.isEmpty()) return FALLBACK_PRESETS;

  /* FloorSampler.baseY - what the screens pass as floorY - is the HIGHEST floor
     point anywhere in the capture. That is fine on a flat fixture and wrong on
     terrain: 3.25 m on hobbiton against a median ground of 0.25 m, so every
     preset was framed three metres in the air. The grid's median is the
     representative ground level. */
  const ground = grid ? grid.medianFloorY : floorY;

  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const spanX = box.max.x - box.min.x;
  const spanZ = box.max.z - box.min.z;
  const span = Math.max(spanX, spanZ);
  const centre: Vec3 = [cx, ground + Math.min(1.2, span * 0.08), cz];

  // The dense box is bounded by floor heights, not by the top of the geometry,
  // so the tallest thing to clear comes from the collider's own AABB.
  const ceiling = bounds && !bounds.isEmpty() ? bounds.max.y : box.max.y;

  const interior: CameraPreset = (grid && interiorFromGrid(grid)) ?? {
    id: 'interior',
    label: 'Interior',
    // No grid to stand on: a quarter of the way in from a corner, which is a
    // guess about the room's shape and only right for a rectangular one.
    position: [cx - spanX * 0.25, ground + EYE_HEIGHT, cz - spanZ * 0.25],
    target: centre,
  };

  return [
    interior,
    {
      id: 'overhead',
      label: 'Overhead',
      // High enough to clear the tallest geometry, so the collider reads.
      // Nudged off dead-vertical because the fly rig clamps pitch just short of
      // 90 degrees: a perfectly top-down preset would snap on the first drag.
      position: [
        cx,
        Math.max(ceiling + span * 0.35, ground + span * 0.9),
        cz + Math.max(0.2, span * 0.03),
      ],
      target: [cx, ground, cz],
    },
    {
      id: 'corner',
      label: 'Corner',
      position: [box.min.x - span * 0.28, ground + span * 0.45, box.min.z - span * 0.28],
      target: [cx, ground + span * 0.06, cz],
    },
    {
      id: 'far',
      label: 'Wide',
      position: [cx + span * 0.75, ground + span * 0.32, cz + span * 0.75],
      target: centre,
    },
  ];
}

/**
 * Interior, placed on a cell the camera can actually occupy.
 *
 * "A quarter of the way in from the corner of the bounding box" is a guess
 * about a room's shape, and it is wrong for anything that is not a rectangle:
 * on maple-street it lands in solid geometry (no floor under it at all), and on
 * hobbiton it stands at a height taken from the highest terrain in the capture,
 * four metres above the ground it is supposed to be standing on. Neither is
 * "inside".
 *
 * Standing on a reachable cell, at eye height above THAT cell's own floor,
 * looking across the reachable region, is true for any capture's shape.
 */
function interiorFromGrid(grid: WalkGrid): CameraPreset | null {
  const { radius } = resolveCameraRadius(grid, CAMERA_BODY_RADIUS);
  const reach = reachableMask(grid, radius);
  if (reach.cells === 0) return null;

  // Centroid and extent of the space the camera can move through. Collected as
  // a list because the stand point is then a scan over it, which - unlike a
  // ring search out from a guessed point - cannot come up empty.
  const cells: { col: number; row: number; x: number; z: number; clearance: number }[] = [];
  let sumX = 0;
  let sumZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = cellIndex(grid, col, row);
      if (reach.mask[i] !== 1) continue;
      const { x, z } = cellToWorld(grid, col, row);
      cells.push({ col, row, x, z, clearance: grid.clearance[i] });
      sumX += x;
      sumZ += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (cells.length === 0) return null;

  const cx = sumX / cells.length;
  const cz = sumZ / cells.length;

  /* Stand back from the centroid along the region's longer axis, towards
     whichever side has more room. Standing ON the centroid and looking at it
     is a view of nothing; backing off gives the shot some depth. */
  const alongX = maxX - minX >= maxZ - minZ;
  const roomLow = alongX ? cx - minX : cz - minZ;
  const roomHigh = alongX ? maxX - cx : maxZ - cz;
  const back = Math.max(roomLow, roomHigh) * 0.6 * (roomLow >= roomHigh ? -1 : 1);
  const wantX = alongX ? cx + back : cx;
  const wantZ = alongX ? cz : cz + back;

  /* Only the more open half of the region is a candidate. "Passable" is a
     floor, not a preference: on maple-street the camera radius has to relax to
     0.10 m for the space to stay connected, and the nearest passable cell to
     the want point was 0.12 m from a wall - technically inside, visually
     face-first into plaster. */
  const median = medianOf(cells.map((c) => c.clearance));
  const open = cells.filter((c) => c.clearance >= median);
  const candidates = open.length > 0 ? open : cells;

  let stand = candidates[0];
  let best = Infinity;
  for (const cell of candidates) {
    const d = (cell.x - wantX) ** 2 + (cell.z - wantZ) ** 2;
    if (d < best) {
      best = d;
      stand = cell;
    }
  }

  const standFloor = floorYAtCell(grid, stand.col, stand.row, grid.medianFloorY);
  const centreCell = worldToCell(grid, cx, cz);
  const centreFloor = floorYAtCell(grid, centreCell.col, centreCell.row, grid.medianFloorY);
  const aim = EYE_HEIGHT * 0.75;

  // Looking slightly below eye level reads as standing in a room rather than
  // staring at the horizon.
  let target: Vec3 = [cx, centreFloor + aim, cz];
  // A pocket small enough that the stand point IS the centroid would hand
  // lookAt a zero-length direction, and the camera's orientation becomes NaN.
  if (Math.hypot(cx - stand.x, cz - stand.z) < 0.5) {
    target = alongX
      ? [stand.x + 2, standFloor + aim, stand.z]
      : [stand.x, standFloor + aim, stand.z + 2];
  }

  return {
    id: 'interior',
    label: 'Interior',
    position: [stand.x, standFloor + EYE_HEIGHT, stand.z],
    target,
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Used before any collider has loaded. */
const FALLBACK_PRESETS: readonly CameraPreset[] = [
  { id: 'interior', label: 'Interior', position: [1.5, 1.65, 1.5], target: [5.5, 1.2, 4.2] },
  { id: 'overhead', label: 'Overhead', position: [5, 17, 4.2], target: [5, 0, 4] },
  { id: 'corner', label: 'Corner', position: [-4.5, 7.5, -3.5], target: [5, 0.8, 4] },
  { id: 'far', label: 'Wide', position: [14, 8, 14], target: [5, 1, 4] },
];

/** @deprecated Prefer derivePresets(bounds, floorY, grid) - these only fit the sample room. */
export const CAMERA_PRESETS = FALLBACK_PRESETS;

/**
 * Imperatively move the default camera to a preset.
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
  const invalidate = useThree((s) => s.invalidate);
  const applied = useRef('');
  const aim = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (!preset) return;
    // Re-running with the same preset and the same nonce means something else
    // changed - a re-rendered presets array, a new bounds object holding the
    // same numbers - not a request to reframe. Re-seating the camera then would
    // yank the user back out of wherever they had flown to.
    const key = `${preset.id}:${nonce}`;
    if (applied.current === key) return;
    applied.current = key;

    camera.position.set(...preset.position);
    // There is no orbit pivot to hand the target to any more, so the preset
    // only lands facing the right way if the camera is pointed here. The fly
    // rig re-reads the camera's orientation on pointerdown, so this survives.
    camera.lookAt(aim.set(...preset.target));
    invalidate();
  }, [preset, nonce, camera, invalidate, aim]);

  return null;
}
