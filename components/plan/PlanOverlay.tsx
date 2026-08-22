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
import { alpha, theme } from '@/components/theme';
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

   Note where theme's `alpha()` may and may not be used. It returns an rgba()
   string, which THREE.Color silently mangles (see the header of
   components/theme.ts), so every transparency on a material below is the
   material's own `opacity` against an opaque token. The one exception is the
   order badge, which is painted with canvas 2D before it ever becomes a
   texture - `fillStyle` takes rgba() correctly, exactly as the map's does. */

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

/* Strength of the fill and its outline. The map's selected pairing: on the map
   a wedge is seen face-on against a flat plan, where here it is foreshortened
   against a photoreal floor that already has texture of its own, so anything
   fainter is not a mark at a grazing angle. */
const SECTOR_FILL = 0.32;
const SECTOR_EDGE = 0.9;

/**
 * Below this a sweep is not an arc, and nothing is drawn at all.
 *
 * The mini-map's own threshold, but the conclusion here is different, and
 * deliberately so. The map falls back to a facing tick because a wedge is the
 * only thing it can say about direction; the render has the marker's own stem
 * standing in the room and the dashed shot preview running out of it, both of
 * which answer "which way" better than a 90 cm scratch on the floor. Drawing
 * that scratch anyway is what made a static shot look like a broken pan.
 */
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

  /* Two scans of a list that is a handful of entries long, replacing the index
     the whole list used to need. Nothing is drawn for a waypoint that is not
     selected or whose shot does not swing, so there is nothing left to look
     up per waypoint. */
  const sectorAim = selectedId ? aims.find((a) => a.id === selectedId) : undefined;
  const sectorAt =
    sectorAim && Math.abs(sectorAim.sweep) > SWEEP_EPSILON
      ? waypoints.find((w) => w.id === selectedId)
      : undefined;

  return (
    <group name="plan-overlay">
      {/* The sector first, so it sorts under the route and the markers when
          they land at the same depth. Its y does the real work (see
          SECTOR_LIFT); this is only what settles a tie. */}
      {sectorAt && sectorAim && (
        <AimSector
          position={sectorAt.position}
          from={sectorAim.from}
          sweep={sectorAim.sweep}
          reach={reach}
        />
      )}

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
 * WHY ONLY THE SELECTED WAYPOINT GETS ONE
 * A sector is a wide flat stain lying on floor the user is also looking at.
 * One is an annotation; six overlapping at eye height is a haze the room has
 * to be read through, and the faint-and-shorter treatment that keeps the
 * unselected ones out of the way on a 300 px plan does not survive
 * foreshortening - it just adds amber. The map is the view that can afford to
 * show every shot at once, because it is seen face-on and has no room in it to
 * obscure; the render is the view that answers "does THIS arc contain the
 * window", which is a question about one shot at a time.
 *
 * Rendered only for a genuinely non-zero sweep, too. See SWEEP_EPSILON.
 */
function AimSector({
  position,
  from,
  sweep,
  reach,
}: {
  position: Vec3;
  from: number;
  sweep: number;
  reach: number;
}) {
  const t = theme();
  const shape = useAimShape(from, sweep, reach);

  return (
    <group position={[position[0], position[1] + SECTOR_LIFT, position[2]]}>
      <mesh geometry={shape.fan}>
        <meshBasicMaterial
          color={t.mapAim}
          transparent
          opacity={SECTOR_FILL}
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
      <Line
        points={shape.edge}
        color={t.mapAim}
        /* The outline is what survives foreshortening. Seen from eye height a
           filled sector collapses to a few pixels of wash, and the two radii
           running out from the marker are the only part of the shape still
           saying which way it opens. */
        lineWidth={2}
        transparent
        opacity={SECTOR_EDGE}
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
  useEffect(() => () => shape.fan.dispose(), [shape]);
  return shape;
}

type AimShape = {
  /** The filled wedge. */
  fan: THREE.BufferGeometry;
  /** The wedge's outline, stroked as a fat line. */
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
 * Badge size in metres, as the sprite is drawn at the camera's own height.
 *
 * The unselected one is roughly a head's width at 3 m, which is the distance
 * this screen is usually flown at - big enough to read a two-digit number,
 * small enough that six of them do not tile the room. The selected one is a
 * third larger, which together with the inverted fill (see makeOrderTexture)
 * is what separates it at a glance; the two marker tokens are currently the
 * same blue, so colour alone cannot carry that.
 */
const BADGE = 0.3;
const BADGE_SELECTED = 0.4;

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
      {/* The head, at camera height. The number IS the head: a sphere with a
          badge floating above it was two marks for one fact, and the sphere
          was the one that could not tell you which stop it was. Sprite rather
          than a billboarded plane so it faces the camera without a frame of
          rig code, and it takes the click itself - the thing you aim at is the
          thing you can hit. */}
      {badge && (
        <sprite
          position={[0, cameraHeight, 0]}
          scale={selected ? [BADGE_SELECTED, BADGE_SELECTED, 1] : [BADGE, BADGE, 1]}
          onClick={pick}
        >
          {/* depthTest off: the splat is a cloud, and a number half-buried in
              it is unreadable in exactly the crowded shots where the running
              order matters most. */}
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

  /* 96 rather than 64 since the badge became the marker itself and is drawn
     half again as large; at 64 the glyph edges crawled when the camera moved. */
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const mid = size / 2;
  const keyline = size * 0.03;
  const ring = size * 0.055;

  /* Three concentric passes, because this now has to read over a photoreal
     capture rather than over the app's own dark chrome, and a splat is bright
     in one corner of the room and near-black in the next. The dark keyline
     saves the light disc against a sunlit wall; the light disc saves the dark
     keyline against a shadowed one. Whichever way the background goes, one of
     the two boundaries is still a boundary. */
  ctx.beginPath();
  ctx.arc(mid, mid, mid - keyline / 2, 0, Math.PI * 2);
  ctx.fillStyle = selected ? t.markerSelected : t.markerFill;
  ctx.fill();
  ctx.lineWidth = keyline;
  ctx.strokeStyle = alpha(t.mapKeyline, 0.6);
  ctx.stroke();

  /* Inverted against the fill, so the selected badge is a blue disc with a
     pale ring and the rest are pale discs with a blue one. */
  ctx.beginPath();
  ctx.arc(mid, mid, mid - keyline - ring / 2, 0, Math.PI * 2);
  ctx.lineWidth = ring;
  ctx.strokeStyle = selected ? t.markerFill : t.marker;
  ctx.stroke();

  ctx.fillStyle = selected ? t.markerInkInverse : t.markerInk;
  ctx.font = `bold ${Math.round(size * 0.46)}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), mid, mid + size * 0.02);

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
