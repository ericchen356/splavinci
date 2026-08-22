'use client';

/**
 * The room, as scene-graph content.
 *
 * Mount this INSIDE an existing R3F <Canvas>. It deliberately owns no canvas,
 * no camera and no controls, so /plan and /review can supply their own camera
 * rig and drop their own overlays (waypoint gizmos, path ribbons, comment
 * pins) in as children — those children land in the same coordinate space as
 * the room.
 *
 *   <Canvas>
 *     <CameraRig />
 *     <RoomScene onFloorClick={place}>
 *       <MyWaypointGizmos />
 *     </RoomScene>
 *   </Canvas>
 *
 * It reads from the shared room store, so several screens can mount it without
 * re-downloading anything.
 */

import type { ReactNode } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3 } from '@/lib/types';
import type { SplatTransform } from '@/lib/scene/splat';
import { useRoomAssets } from '@/lib/scene/useRoomAssets';
import { SplatLayer } from './SplatLayer';
import { ColliderLayer } from './ColliderLayer';

export type RoomSceneProps = {
  /* --- what to draw --- */
  showSplat?: boolean;
  /**
   * Force the collider wireframe on/off. Omit to follow the shared store
   * toggle (`useRoomAssets().showCollider`), which is what /scene drives.
   */
  showCollider?: boolean;
  splatTransform?: SplatTransform;
  splatOpacity?: number;

  /* --- interaction --- */
  /**
   * Mount an invisible pickable floor. Turned on automatically when any of the
   * floor handlers below are supplied.
   */
  pickableFloor?: boolean;
  onFloorClick?: (point: Vec3, event: ThreeEvent<MouseEvent>) => void;
  onFloorPointerDown?: (point: Vec3, event: ThreeEvent<PointerEvent>) => void;
  onFloorPointerMove?: (point: Vec3, event: ThreeEvent<PointerEvent>) => void;

  /* --- extension --- */
  /** Rendered inside the room's group, in room world space. */
  children?: ReactNode;
};

export function RoomScene({
  showSplat = true,
  showCollider,
  splatTransform,
  splatOpacity = 1,
  pickableFloor,
  onFloorClick,
  onFloorPointerDown,
  onFloorPointerMove,
  children,
}: RoomSceneProps) {
  const assets = useRoomAssets();

  // Default the splat placement from the active capture. A Y-down capture
  // rendered with the identity transform comes out upside down, and every
  // camera and path assumption inverts with it.
  const placement = splatTransform ?? assets.assetSet.placement;

  const wireframeOn = showCollider ?? assets.showCollider;
  const floorPickable =
    pickableFloor ?? Boolean(onFloorClick || onFloorPointerDown || onFloorPointerMove);

  return (
    <group name="room">
      {/* A dim ambient + hemisphere pair so mounted overlays read against the
          splat cloud without fighting it. Cheap, and no shadow maps. */}
      <ambientLight intensity={0.85} />
      <hemisphereLight args={['#dfe7f5', '#2a2620', 0.6]} />
      <directionalLight position={[6, 9, 4]} intensity={0.55} />

      {showSplat ? <SplatLayer transform={placement} opacity={splatOpacity} /> : null}

      <ColliderLayer
        collider={assets.colliderData}
        showWireframe={wireframeOn}
        pickableFloor={floorPickable}
        onFloorClick={onFloorClick}
        onFloorPointerDown={onFloorPointerDown}
        onFloorPointerMove={onFloorPointerMove}
      />

      {children}
    </group>
  );
}
