'use client';

/**
 * Waypoint markers, the generated route, and each shot's aim sector, drawn
 * inside the room's scene graph.
 *
 * Mounted as a child of RoomScene so it shares the room's coordinate space -
 * no second transform to keep in step. Reads the same waypoint list AND the
 * same aim list the mini-map draws, which is what keeps the two views honest
 * about each other: the corner map and the render are two projections of one
 * plan, not two drawings of it.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec3, Waypoint } from '@/lib/types';
import { useRoomStore } from '@/lib/scene/roomStore';
import { isDrag } from '@/components/scene/pointer';
import { theme } from '@/components/theme';
import type { WaypointAim } from './MiniMap';

export type PlanOverlayProps = {
  waypoints: readonly Waypoint[];
  selectedId: string | null;
  polyline: readonly Vec3[];
  /** Where the selected waypoint's shot will sweep, drawn dashed while its
   *  controls are being adjusted. See components/plan/shotPreview.ts. */
  shotPreview?: readonly Vec3[];
  /**
   * Where each waypoint's shot points and how far it swings, drawn flat on the
   * floor as a sector.
   *
   * Literally the same array the mini-map takes, and deliberately the same
   * type rather than a local one: the wedge in the corner and the sector on
   * the floor are one fact about the shot, and giving each view its own shape
   * for it is how the two quietly start disagreeing about which way a pan
   * runs. A reader who trusts the map and then flies the render has to find
   * the same arc in both.
   */
  aims?: readonly WaypointAim[];
  onSelect?: (id: string) => void;
  /** Camera height, so markers read at the height the camera will fly. */
  cameraHeight?: number;
};

/* Colours come from the token block, not from three constants here. These
   materials sit over a photoreal capture that the chrome around them is tuned
   against, so a marker blue that drifts from the panel blue is immediately
   visible - and THREE.Color cannot read a custom property, so the value has to
   be threaded in from components/theme.ts rather than referenced.

   Note what is NOT used below: theme's `alpha()`. It returns an rgba() string,
   which THREE.Color silently mangles (see the header of components/theme.ts),
   so every transparency here is the material's own `opacity` against an opaque
   token - not the map's trick of baking alpha into the colour string. */

/** Shared default: a fresh literal would rebuild the preview memo every render. */
const NO_POINTS: readonly Vec3[] = [];
const NO_AIMS: readonly WaypointAim[] = [];

/* -------------------------------------------------------------------------- */
/* the aim sector                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How far a sector reaches, as a fraction of the capture's footprint diagonal.
 *
 * Taken from the mini-map rather than invented: its selected wedge is a fixed
 * 46 px drawn on a 300 px map that is fitted to the room's diagonal (8 px of
 * padding a side), so in world terms it already reaches 46 / 284 - about a
 * sixth - of that diagonal. Reusing the number is what makes the two marks the
 * same size relative to the room, so a sector that looks like it covers the
 * sofa on the map covers the sofa in the render.
 */
const SECTOR_REACH_OF_ROOM = 46 / 284;

/**
 * The metre band that fraction is held inside - the one place the sector does
 * NOT copy the map.
 *
 * On the map, a bigger capture simply means the wedge spans more metres; it is
 * still a small mark in a corner. In the render those metres are floor the
 * user is standing on, and past a few of them the sector stops reading as
 * "this shot points that way" and becomes a stain across the room. The upper
 * bound matches shotPreview's MAX_LOOK_RADIUS, which was clamped for exactly
 * this reason. The lower bound keeps the mark bigger than the marker disc it
 * is rooted in, so a tight capture does not reduce it to a collar.
 */
const SECTOR_REACH_MIN = 0.9;
const SECTOR_REACH_MAX = 3.5;

/** Unselected reach, relative to the selected one. The mini-map's 26 : 46. */
const SECTOR_REACH_IDLE = 26 / 46;

/**
 * Clear of the floor, and deliberately below the marker disc's 0.02 and the
 * route's 0.03.
 *
 * Those two are the answers to "which stop is this" and "where does the camera
 * go", and a sector is a wide flat shape that would swallow both if it sorted
 * above them. Small enough that it still reads as lying ON the floor rather
 * than hovering over it, which is the whole point of drawing it flat.
 */
const SECTOR_LIFT = 0.012;

/** Arc per fan segment, so a 20 degree wedge is not over-tessellated and a
 *  300 degree one is not visibly faceted. */
const SECTOR_SEGMENT = Math.PI / 24;
const SECTOR_SEGMENTS_MAX = 96;

/* Strength of the fill and its outline. Same pairing the map uses, nudged up
   for the idle case: on the map a wedge is seen face-on against a flat plan,
   where here it is foreshortened against a photoreal floor that already has
   texture of its own, and 0.14 amber at a grazing angle is not a mark. */
const SECTOR_FILL_SELECTED = 0.32;
const SECTOR_FILL_IDLE = 0.18;
const SECTOR_EDGE_SELECTED = 0.9;
const SECTOR_EDGE_IDLE = 0.5;

/** Below this a sweep is a facing, not an arc. The mini-map's own threshold. */
const SWEEP_EPSILON = 1e-3;

export function PlanOverlay({
  waypoints,
  selectedId,
  polyline,
  shotPreview = NO_POINTS,
  aims = NO_AIMS,
  onSelect,
  cameraHeight = 1.55,
}: PlanOverlayProps) {
  const t = theme();
  const reach = useSectorReach();

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

  /* Indexed rather than scanned per waypoint. The map can afford a `.find`
     inside its loop because it redraws on a timer anyway; this list is walked
     during React's render on every slider tick in the waypoint panel. */
  const aimById = useMemo(() => new Map(aims.map((a) => [a.id, a])), [aims]);

  return (
    <group name="plan-overlay">
      {/* Sectors first, so they sort under the route and the markers when two
          of them land at the same depth. Their y does the real work (see
          SECTOR_LIFT); this is only what settles a tie. */}
      {waypoints.map((w) => {
        const aim = aimById.get(w.id);
        return aim ? (
          <AimSector
            key={w.id}
            waypoint={w}
            aim={aim}
            reach={reach}
            selected={w.id === selectedId}
          />
        ) : null;
      })}

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
 * One waypoint's aim, as a sector lying flat on the floor it is standing on.
 *
 * WHY IT IS DRAWN AT ALL, GIVEN THE MAP ALREADY DRAWS IT
 * The map answers "which way does shot 3 point" in plan; it cannot answer
 * "does that arc actually contain the window", because the map has no window
 * in it. The render does. Putting the same arc down on the same floor is what
 * lets someone check the framing against the room rather than against a
 * drawing of the room.
 *
 * WHY UNSELECTED WAYPOINTS GET ONE TOO
 * Because the map gives them one, and the two views are projections of a
 * single list - a mark that appears in one and not the other is the reader's
 * problem to reconcile, not ours to save a few triangles over. It also makes
 * the useful comparison possible at a glance: shots 2 and 3 both facing the
 * same wall is a thing you see instantly with every sector down and never see
 * one selection at a time. They are drawn faint and at just over half the
 * reach, exactly as on the map, so the selected one still wins the eye.
 */
function AimSector({
  waypoint,
  aim,
  reach,
  selected,
}: {
  waypoint: Waypoint;
  aim: WaypointAim;
  reach: number;
  selected: boolean;
}) {
  const t = theme();
  const shape = useAimShape(aim.from, aim.sweep, reach * (selected ? 1 : SECTOR_REACH_IDLE));

  return (
    <group
      position={[waypoint.position[0], waypoint.position[1] + SECTOR_LIFT, waypoint.position[2]]}
    >
      {shape.fan && (
        <mesh geometry={shape.fan}>
          <meshBasicMaterial
            color={t.mapAim}
            transparent
            opacity={selected ? SECTOR_FILL_SELECTED : SECTOR_FILL_IDLE}
            /* Never occlude: the sector is an annotation, and a marker or a
               route leg disappearing behind one would be a lie about the
               plan. */
            depthWrite={false}
            /* The fan's winding flips with the sign of `sweep`, and a sector
               is a two-sided annotation anyway - it has to survive the camera
               dropping below the floor line of a capture with a step in it. */
            side={THREE.DoubleSide}
            /* Belt and braces against the floor. SECTOR_LIFT is what clears
               the splat, which is a cloud rather than a surface and does not
               respond to a depth bias in any predictable way; the offset is
               for the collider's floor triangles, which ARE a plane and which
               12 mm can still lose to at a grazing angle on a far wall, where
               the depth buffer has almost no precision left to spend. */
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}
      <Line
        points={shape.edge}
        color={t.mapAim}
        /* The outline is what survives foreshortening. Seen from eye height a
           filled sector collapses to a few pixels of wash, and the two radii
           running out from the marker are the only part of the shape still
           saying which way it opens. */
        lineWidth={selected ? 2 : 1.5}
        transparent
        opacity={selected ? SECTOR_EDGE_SELECTED : SECTOR_EDGE_IDLE}
        depthWrite={false}
        dashed={false}
      />
    </group>
  );
}

/**
 * The sector's fan and its outline, rebuilt only when the arc itself changes.
 *
 * A hook rather than a plain call because the geometry is a GPU resource and
 * these are rebuilt on every tick of the aim dial: without the disposal the
 * cleanup does, dragging the dial across its range leaks one buffer per frame.
 * Same reasoning as useOrderTexture below.
 */
function useAimShape(from: number, sweep: number, radius: number): AimShape {
  const shape = useMemo(() => buildAimShape(from, sweep, radius), [from, sweep, radius]);
  useEffect(() => () => shape.fan?.dispose(), [shape]);
  return shape;
}

type AimShape = {
  /** The filled wedge - null for a shot that only faces a direction. */
  fan: THREE.BufferGeometry | null;
  /** What to stroke: the wedge's outline, or the bare facing tick. */
  edge: THREE.Vector3[];
};

/**
 * Build one wedge in the waypoint's own frame.
 *
 * THE ORIENTATION, WHICH IS THE ONLY THING HERE THAT CAN BE WRONG
 * `from` is an absolute bearing measured as atan2(dz, dx) - see ShotAim in
 * lib/types.ts, and resolveShot, which produces exactly that from its target
 * point. So bearing b is the horizontal direction (cos b, sin b) in (x, z),
 * and that is the line below, unmodified: no sign flip, no swapped axis.
 *
 * The mini-map arrives at the same place by a different route and it is worth
 * writing down why they agree, because the map LOOKS like it is doing
 * something else. Its projection sends world x to canvas x and world z to
 * canvas y, and canvas angles run from +x toward +y - so a canvas angle IS a
 * world bearing, which is why its `toAngle` only ever adds the plan's rotation
 * and never negates. Its ctx.arc walks from `from` to `from + sweep` with
 * `counterclockwise` set from the sign of the sweep, which is the same walk as
 * the parametrisation here. Two views, one convention.
 */
function buildAimShape(from: number, sweep: number, radius: number): AimShape {
  const tip = new THREE.Vector3(Math.cos(from) * radius, 0, Math.sin(from) * radius);
  // No swing: one tick showing which way it faces, as the map does.
  if (Math.abs(sweep) <= SWEEP_EPSILON) {
    return { fan: null, edge: [new THREE.Vector3(), tip] };
  }

  const segments = Math.min(
    SECTOR_SEGMENTS_MAX,
    Math.max(3, Math.ceil(Math.abs(sweep) / SECTOR_SEGMENT)),
  );

  // Vertex 0 is the apex at the waypoint, left at the origin; the rim follows.
  const position = new Float32Array((segments + 2) * 3);
  const edge: THREE.Vector3[] = [new THREE.Vector3()];
  for (let i = 0; i <= segments; i++) {
    const bearing = from + (sweep * i) / segments;
    const x = Math.cos(bearing) * radius;
    const z = Math.sin(bearing) * radius;
    position[(i + 1) * 3] = x;
    position[(i + 1) * 3 + 2] = z;
    edge.push(new THREE.Vector3(x, 0, z));
  }
  edge.push(new THREE.Vector3());

  const index: number[] = [];
  for (let i = 0; i < segments; i++) index.push(0, i + 1, i + 2);

  const fan = new THREE.BufferGeometry();
  fan.setAttribute('position', new THREE.BufferAttribute(position, 3));
  fan.setIndex(index);
  return { fan, edge };
}

/**
 * How far the sectors reach, in metres, sized off the capture's own footprint.
 *
 * Read from the room store rather than taken as a prop: this overlay is
 * already mounted inside RoomScene's group, and the store is the same one that
 * built the room around it - so the alternative is a prop that only ever
 * carries a value the component is standing in the middle of. Narrow selector,
 * so a splat progress tick does not re-render the whole overlay.
 *
 * The collider AABB is a little larger than the walkable region the map fits
 * itself to, which makes the sector read very slightly bigger here than there.
 * The clamp swallows the difference on any capture where it would be visible.
 */
function useSectorReach(): number {
  const bounds = useRoomStore((s) => s.collider.data?.bounds ?? null);
  return useMemo(() => {
    if (!bounds) return SECTOR_REACH_MIN;
    const diagonal = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    const reach = diagonal * SECTOR_REACH_OF_ROOM;
    return reach < SECTOR_REACH_MIN
      ? SECTOR_REACH_MIN
      : reach > SECTOR_REACH_MAX
        ? SECTOR_REACH_MAX
        : reach;
  }, [bounds]);
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
