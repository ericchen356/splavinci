'use client';

/**
 * The collision mesh.
 *
 * Two jobs, deliberately separated:
 *  - a debug wireframe clone, off by default, that makes the walkable volume
 *    visible while the path work is being tuned;
 *  - an always-mounted, never-painted clone of the floor that pointer events
 *    can hit, so the plan screen can click-to-place waypoints on the floor
 *    without needing a collider of its own.
 *
 * Both are clones. The store keeps the canonical Object3D, and an Object3D can
 * only have one parent — cloning lets /scene, /plan and /review each mount the
 * same room simultaneously. Clones share geometry, so this is cheap.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '@/lib/types';
import type { ColliderData } from '@/lib/scene/collider';

export type ColliderLayerProps = {
  collider: ColliderData | null;
  /** Show the debug wireframe. */
  showWireframe?: boolean;
  /** Wireframe colour. Defaults to the app accent. */
  wireframeColor?: string;
  wireframeOpacity?: number;
  /**
   * Mount an invisible-but-pickable copy of the floor. Required for
   * `onFloorPointerDown` / `onFloorClick` to fire.
   */
  pickableFloor?: boolean;
  onFloorPointerDown?: (point: Vec3, event: ThreeEvent<PointerEvent>) => void;
  onFloorClick?: (point: Vec3, event: ThreeEvent<MouseEvent>) => void;
  onFloorPointerMove?: (point: Vec3, event: ThreeEvent<PointerEvent>) => void;
};

const DEFAULT_WIREFRAME_COLOR = '#6ea8fe';

export function ColliderLayer({
  collider,
  showWireframe = false,
  wireframeColor = DEFAULT_WIREFRAME_COLOR,
  wireframeOpacity = 0.55,
  pickableFloor = false,
  onFloorPointerDown,
  onFloorClick,
  onFloorPointerMove,
}: ColliderLayerProps) {
  const wireMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: wireframeColor,
        wireframe: true,
        transparent: true,
        opacity: wireframeOpacity,
        depthWrite: false,
      }),
    [wireframeColor, wireframeOpacity],
  );

  // Draws nothing at all, but is still hit-testable: `visible: false` would
  // make three's raycaster skip it, so we suppress colour and depth instead.
  const pickMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      }),
    [],
  );

  const wireGroup = useMemo(() => {
    if (!collider) return null;
    const clone = collider.root.clone(true);
    clone.name = 'collider-wireframe';
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = wireMaterial;
        mesh.raycast = () => {};
      }
    });
    return clone;
  }, [collider, wireMaterial]);

  const floorPickGroup = useMemo(() => {
    if (!collider || collider.floorMeshes.length === 0) return null;
    const group = new THREE.Group();
    group.name = 'collider-floor-pick';
    for (const source of collider.floorMeshes) {
      const mesh = new THREE.Mesh(source.geometry, pickMaterial);
      mesh.name = `pick:${source.name}`;
      source.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
      group.add(mesh);
    }
    return group;
  }, [collider, pickMaterial]);

  useEffect(() => () => wireMaterial.dispose(), [wireMaterial]);
  useEffect(() => () => pickMaterial.dispose(), [pickMaterial]);

  const toVec3 = (event: { point: THREE.Vector3 }): Vec3 => [
    event.point.x,
    event.point.y,
    event.point.z,
  ];

  return (
    <group name="collider">
      {wireGroup ? <primitive object={wireGroup} visible={showWireframe} /> : null}
      {pickableFloor && floorPickGroup ? (
        <primitive
          object={floorPickGroup}
          onPointerDown={
            onFloorPointerDown
              ? (event: ThreeEvent<PointerEvent>) => onFloorPointerDown(toVec3(event), event)
              : undefined
          }
          onClick={
            onFloorClick
              ? (event: ThreeEvent<MouseEvent>) => onFloorClick(toVec3(event), event)
              : undefined
          }
          onPointerMove={
            onFloorPointerMove
              ? (event: ThreeEvent<PointerEvent>) => onFloorPointerMove(toVec3(event), event)
              : undefined
          }
        />
      ) : null}
    </group>
  );
}
