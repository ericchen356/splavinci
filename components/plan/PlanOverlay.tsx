'use client';

/**
 * Waypoint markers and the generated route, drawn inside the room's scene graph.
 *
 * Mounted as a child of RoomScene so it shares the room's coordinate space -
 * no second transform to keep in step. Reads the same waypoint list the
 * mini-map draws, which is what keeps the two views honest about each other.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3, Waypoint } from '@/lib/types';
import { isDrag } from '@/components/scene/pointer';

export type PlanOverlayProps = {
  waypoints: readonly Waypoint[];
  selectedId: string | null;
  polyline: readonly Vec3[];
  /** Where the selected waypoint's shot will sweep, drawn dashed while its
   *  controls are being adjusted. See components/plan/shotPreview.ts. */
  shotPreview?: readonly Vec3[];
  onSelect?: (id: string) => void;
  /** Camera height, so markers read at the height the camera will fly. */
  cameraHeight?: number;
};

const ACCENT = '#6ea8fe';
const SELECTED = '#dce9ff';
const PREVIEW = '#ffb454';

/** Shared default: a fresh literal would rebuild the preview memo every render. */
const NO_POINTS: readonly Vec3[] = [];

export function PlanOverlay({
  waypoints,
  selectedId,
  polyline,
  shotPreview = NO_POINTS,
  onSelect,
  cameraHeight = 1.55,
}: PlanOverlayProps) {
  // Lift the route just clear of the floor; drawn coplanar it z-fights.
  const routePoints = useMemo<THREE.Vector3[]>(
    () => polyline.map((p) => new THREE.Vector3(p[0], p[1] + 0.03, p[2])),
    [polyline],
  );

  // Already at camera height - this is where the camera goes, not floor work.
  const previewPoints = useMemo<THREE.Vector3[]>(
    () => shotPreview.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    [shotPreview],
  );

  return (
    <group name="plan-overlay">
      {routePoints.length > 1 && (
        <Line points={routePoints} color={ACCENT} lineWidth={3} dashed={false} />
      )}

      {previewPoints.length > 1 && (
        <Line points={previewPoints} color={PREVIEW} lineWidth={2} dashed dashSize={0.14} gapSize={0.1} />
      )}

      {waypoints.map((w, i) => (
        <WaypointMarker
          key={w.id}
          waypoint={w}
          order={i + 1}
          selected={w.id === selectedId}
          cameraHeight={cameraHeight}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}

/**
 * One waypoint marker. A component rather than inline JSX in the map, because
 * the order badge builds its texture through a hook - calling that inside a
 * loop would change the hook count whenever a waypoint is added or removed.
 */
function WaypointMarker({
  waypoint,
  order,
  selected,
  cameraHeight,
  onSelect,
}: {
  waypoint: Waypoint;
  order: number;
  selected: boolean;
  cameraHeight: number;
  onSelect?: (id: string) => void;
}) {
  const colour = selected ? SELECTED : ACCENT;
  const badge = useOrderTexture(order, selected);
  const pick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // Releasing a look-around drag over a marker is not a request to select it.
    if (isDrag(e)) return;
    onSelect?.(waypoint.id);
  };

  return (
    <group position={[waypoint.position[0], waypoint.position[1], waypoint.position[2]]}>
      {/* floor disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} onClick={pick}>
        <circleGeometry args={[selected ? 0.28 : 0.22, 24]} />
        <meshBasicMaterial color={colour} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      {/* stem up to camera height, so the marker reads in 3D */}
      <mesh position={[0, cameraHeight / 2, 0]} onClick={pick}>
        <cylinderGeometry args={[0.012, 0.012, cameraHeight, 8]} />
        <meshBasicMaterial color={colour} transparent opacity={0.55} />
      </mesh>
      {/* head at camera height */}
      <mesh position={[0, cameraHeight, 0]} onClick={pick}>
        <sphereGeometry args={[selected ? 0.1 : 0.075, 16, 12]} />
        <meshBasicMaterial color={colour} />
      </mesh>
      {badge && (
        <sprite position={[0, cameraHeight + 0.24, 0]} scale={[0.32, 0.32, 1]}>
          <spriteMaterial map={badge} transparent depthTest={false} />
        </sprite>
      )}
    </group>
  );
}

/**
 * Tiny canvas texture for the waypoint's order number.
 *
 * Owned by the marker rather than by a module-level cache. The cache never
 * dropped an entry, so every number a plan ever used kept a GPU texture alive
 * for the lifetime of the tab - and it bought nothing, because a marker's key
 * is its own order number and no two markers share one. Tying the texture to
 * the component instead means it is freed when the marker goes away or is
 * renumbered.
 */
function useOrderTexture(n: number, selected: boolean): THREE.CanvasTexture | null {
  const texture = useMemo(() => makeOrderTexture(n, selected), [n, selected]);
  useEffect(() => () => texture?.dispose(), [texture]);
  return texture;
}

function makeOrderTexture(n: number, selected: boolean): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#dce9ff' : '#16191f';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = ACCENT;
  ctx.stroke();

  ctx.fillStyle = selected ? '#0d0f12' : '#e8eaed';
  ctx.font = 'bold 32px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), size / 2, size / 2 + 1);

  return new THREE.CanvasTexture(canvas);
}
