'use client';

/**
 * Publishes the live camera pose out of the render loop, for the mini-maps.
 *
 * Mount inside a <Canvas>, next to whatever is driving the camera:
 *
 *   <CameraRig mode={mode} />
 *   <CameraTracker onChange={setPose} />
 *
 * Reading the camera every frame is free; handing it to React every frame is
 * not — a setState at 120fps re-renders the whole screen, sidebar included, for
 * a dot that moves two pixels. So the pose leaves the loop at a fixed low rate,
 * and only once it has actually moved.
 */

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { Vec3 } from '@/lib/types';

/** Matches the MiniMap `camera` prop. */
export type CameraPose = { position: Vec3; lookAt: Vec3 };

export type CameraTrackerProps = {
  onChange: (pose: CameraPose) => void;
  /** Publishes per second. */
  hz?: number;
  /** Metres of travel below which the pose counts as unchanged. */
  moveEpsilon?: number;
  /** Chord length between facing directions below which it counts as unchanged. */
  turnEpsilon?: number;
  /** Metres ahead of the camera the reported `lookAt` sits. */
  lookAhead?: number;
};

export function CameraTracker({
  onChange,
  hz = 12,
  moveEpsilon = 0.02,
  turnEpsilon = 0.01,
  lookAhead = 3,
}: CameraTrackerProps) {
  const camera = useThree((s) => s.camera);

  const since = useRef(0);
  const published = useRef(false);
  const last = useMemo(
    () => ({ position: new THREE.Vector3(), direction: new THREE.Vector3() }),
    [],
  );
  const direction = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    since.current += delta;
    if (since.current < 1 / hz) return;
    since.current = 0;

    // A THREE.Camera stores no look-at target, so derive one from where it is
    // actually pointing rather than from whatever the rig was last told.
    camera.getWorldDirection(direction);

    const moved = camera.position.distanceToSquared(last.position) > moveEpsilon * moveEpsilon;
    const turned = direction.distanceToSquared(last.direction) > turnEpsilon * turnEpsilon;
    if (published.current && !moved && !turned) return;

    published.current = true;
    last.position.copy(camera.position);
    last.direction.copy(direction);

    onChange({
      position: [camera.position.x, camera.position.y, camera.position.z],
      lookAt: [
        camera.position.x + direction.x * lookAhead,
        camera.position.y + direction.y * lookAhead,
        camera.position.z + direction.z * lookAhead,
      ],
    });
  });

  return null;
}
