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
import { theme } from '@/components/theme';

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

/* Colours come from the token block, not from three constants here. These
   materials sit over a photoreal capture that the chrome around them is tuned
   against, so a marker blue that drifts from the panel blue is immediately
   visible - and THREE.Color cannot read a custom property, so the value has to
   be threaded in from components/theme.ts rather than referenced. */

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
  const t = theme();

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
        <Line points={routePoints} color={t.mapRoute} lineWidth={3} dashed={false} />
      )}

      {previewPoints.length > 1 && (
        <Line
          points={previewPoints}
          color={t.mapAim}
          lineWidth={2}
          dashed
          dashSize={0.14}
          gapSize={0.1}
        />
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
  const t = theme();
  const colour = selected ? t.markerSelected : t.marker;
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
  const t = theme();

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = selected ? t.markerSelected : t.markerFill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = t.marker;
  ctx.stroke();

  ctx.fillStyle = selected ? t.markerInkInverse : t.markerInk;
  ctx.font = "bold 32px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), size / 2, size / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);

  /* Why the number is not simply drawn and left alone.
   *
   * A canvas's first row is its TOP; a GL texture's first row is what UV v=0
   * samples, which is the BOTTOM of the sprite quad. three bridges that with
   * texture.flipY, default true, by asking the driver for UNPACK_FLIP_Y_WEBGL
   * at upload - and it asks through WebGLState.pixelStorei, which caches the
   * last value it set. Spark writes its ordering and LOD index textures with
   * raw `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)` calls straight on the
   * context (spark.module.js x3) and never calls renderer.resetState(), so
   * three's cache says "already true" while the driver is actually on false.
   * The flip three thinks it requested silently never happens and the glyph
   * uploads bottom-up: the badge renders upside down.
   *
   * So flipY is not something to rely on here. Spark only ever forces the
   * unpack flip OFF, which makes flipY=false the one value the upload is
   * guaranteed to honour; the row order is then corrected in the map's own UV
   * transform, which lives in the shader and cannot be desynchronised by
   * anything outside three. Correct with or without Spark in the scene. */
  texture.flipY = false;
  texture.repeat.set(1, -1);
  texture.offset.set(0, 1);

  return texture;
}
