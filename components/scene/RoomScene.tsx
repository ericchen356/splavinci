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
 *     <CameraRig mode="orbit" />
 *     <RoomScene interactiveObjects onFloorClick={place}>
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
import type { LoadedObject } from '@/lib/scene/assetTypes';
import type { SplatTransform } from '@/lib/scene/splat';
import { useRoomAssets } from '@/lib/scene/useRoomAssets';
import { SplatLayer } from './SplatLayer';
import { ColliderLayer } from './ColliderLayer';
import { ObjectsLayer } from './ObjectsLayer';

export type RoomSceneProps = {
  /* --- what to draw --- */
  showSplat?: boolean;
  showObjects?: boolean;
  /**
   * Force the collider wireframe on/off. Omit to follow the shared store
   * toggle (`useRoomAssets().showCollider`), which is what /scene drives.
   */
  showCollider?: boolean;
  splatTransform?: SplatTransform;
  splatOpacity?: number;

  /* --- interaction --- */
  /** Enable pointer events on the object meshes. */
  interactiveObjects?: boolean;
  highlightedObjectIds?: readonly string[];
  onObjectClick?: (object: LoadedObject, event: ThreeEvent<MouseEvent>) => void;
  onObjectHover?: (object: LoadedObject | null, event: ThreeEvent<PointerEvent>) => void;
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
  showObjects = true,
  showCollider,
  splatTransform,
  splatOpacity = 1,
  interactiveObjects = false,
  highlightedObjectIds,
  onObjectClick,
  onObjectHover,
  pickableFloor,
  onFloorClick,
  onFloorPointerDown,
  onFloorPointerMove,
  children,
}: RoomSceneProps) {
  const assets = useRoomAssets();

  const wireframeOn = showCollider ?? assets.showCollider;
  const floorPickable =
    pickableFloor ?? Boolean(onFloorClick || onFloorPointerDown || onFloorPointerMove);

  return (
    <group name="room">
      {/* A dim ambient + hemisphere pair so the object meshes read against the
          splat cloud without fighting it. Cheap, and no shadow maps. */}
      <ambientLight intensity={0.85} />
      <hemisphereLight args={['#dfe7f5', '#2a2620', 0.6]} />
      <directionalLight position={[6, 9, 4]} intensity={0.55} />

      {showSplat ? <SplatLayer transform={splatTransform} opacity={splatOpacity} /> : null}

      <ColliderLayer
        collider={assets.colliderData}
        showWireframe={wireframeOn}
        pickableFloor={floorPickable}
        onFloorClick={onFloorClick}
        onFloorPointerDown={onFloorPointerDown}
        onFloorPointerMove={onFloorPointerMove}
      />

      <ObjectsLayer
        objects={assets.loadedObjects}
        visible={showObjects}
        interactive={interactiveObjects}
        highlightedIds={highlightedObjectIds}
        onObjectClick={onObjectClick}
        onObjectHover={onObjectHover}
      />

      {children}
    </group>
  );
}
