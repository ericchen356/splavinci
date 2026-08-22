'use client';

/**
 * Top-down mini-map, drawn from the collider's own footprint.
 *
 * It renders the same WalkGrid the path generator routes on (see
 * lib/path/gridCache.ts), so what the user sees as a wall is exactly what A*
 * treats as a wall - a map drawn from separate geometry could show a doorway
 * the router does not believe in.
 *
 * Shared by both screens rather than duplicated: the plan screen passes
 * waypoints and takes clicks, the review screen passes a camera pose and
 * comments. Everything is optional, so each screen lights up only what it uses.
 *
 * INTERACTION
 * Everything runs off pointer events, not `click`, for two reasons. A `click`
 * fires at the end of a drag as well as a press, so a stray drag across the map
 * used to drop a waypoint nobody asked for; and a marker cannot be dragged at
 * all through a click handler. One gesture is tracked from pointerdown, and
 * once its travel passes CLICK_SLOP_PX it is a drag and can never also place
 * anything - the same rule the 3D view applies through `isDrag`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, Vec3, Waypoint } from '@/lib/types';
import { cellIndex, worldToCell, type WalkGrid } from '@/lib/path';
import { CLICK_SLOP_PX } from '@/components/scene/pointer';
import { alpha, theme } from '@/components/theme';
import { buildPlanLayer, planColours, strokeSegments } from './blueprint';

export type WaypointAim = {
  id: string;
  /** Absolute bearing, atan2(dz, dx). */
  from: number;
  /** Signed arc. Zero for shots that only face a direction. */
  sweep: number;
};

export type MiniMapProps = {
  grid: WalkGrid | null;
  waypoints?: readonly Waypoint[];
  selectedId?: string | null;
  /** Generated route, drawn as a line. */
  polyline?: readonly Vec3[];
  /** Live camera pose. Draws the you-are-here chevron, and is what the plan
   *  turns to follow - without one the map stays north-up. */
  camera?: { position: Vec3; lookAt: Vec3 } | null;
  comments?: readonly Comment[];
  /**
   * Where each waypoint's shot points, and how far it swings.
   *
   * Drawn on the map because that is where the room is: a bearing in a number
   * field says nothing about whether it faces a wall.
   */
  aims?: readonly WaypointAim[];
  /** Where the selected waypoint's shot will take the camera, drawn dashed.
   *  See components/plan/shotPreview.ts. */
  shotPreview?: readonly Vec3[];
  /** Click on empty floor. Receives world x/z. */
  onPick?: (x: number, z: number) => void;
  onWaypointPick?: (id: string) => void;
  onCommentPick?: (id: string) => void;
  /** Drag a marker to a new world x/z. Omit to leave markers immovable. */
  onWaypointDrag?: (id: string, x: number, z: number) => void;
  height?: number;
  /**
   * Camera body radius. Supplying it lets the map distinguish floor the camera
   * can reach from floor cut off behind gaps too narrow for it.
   */
  cameraRadius?: number;
  /** Shown top-left inside the map. */
  title?: string;
  hint?: string;
};

/** Shared default, so a screen that passes no preview does not hand `draw` a
 *  fresh array - and a fresh dependency - on every render. */
const NO_POINTS: readonly Vec3[] = [];
const NO_AIMS: readonly WaypointAim[] = [];

/* Canvas type. The map draws its own labels, so it cannot inherit the app font
   stack and has to name it - kept here rather than in each fillText call so
   the map cannot end up in three different faces. */
const CANVAS_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const LABEL_FONT_PX = 12;
const MARKER_FONT_PX = 11;

/* Marker geometry. The hit radii are deliberately larger than the drawn ones:
   a 6px dot is a 12px target, which is half the 24px minimum, and these markers
   are dragged as well as clicked. */
const MARKER_R = 7;
const MARKER_R_SELECTED = 9;
const MARKER_HIT_R = 13;
const COMMENT_HIT_R = 12;

/* The you-are-here chevron, in canvas px measured from the camera's own
   position: how far the tip runs ahead of it, how far the shoulders sit
   behind, how wide they are, and how far the tail bows out past them. Split
   fore and aft rather than given as one length because the glyph has to sit
   centred on the position it reports - a triangle grown forward from the
   camera point puts the mark half a body ahead of where the camera is. */
const CAMERA_TIP = 11;
const CAMERA_TAIL = 6.5;
const CAMERA_HALF_WIDTH = 7.5;
const CAMERA_BULGE = 3;

/** A press in progress, from pointerdown to pointerup. */
type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Travel has passed the slop, so this is a drag and never a placement. */
  dragging: boolean;
  /** Waypoint to move as the pointer moves, if there is one and it can move. */
  dragId: string | null;
  /** What was under the pointer when it went down - a click resolves to this
   *  rather than to whatever happens to be under it on release. */
  waypointId: string | null;
  commentId: string | null;
};

/**
 * The topmost marker within `radius` of a screen point, or null.
 *
 * Nearest rather than first in list order: two waypoints that overlap on the
 * map both have to stay reachable, and picking by list order made the earlier
 * one permanently win. Ties go to the later item, which is the one drawn on
 * top, so the hit matches what the user is actually looking at.
 */
function hitTest<T>(
  items: readonly T[],
  at: (item: T) => { sx: number; sy: number },
  sx: number,
  sy: number,
  radius: number,
): T | null {
  let best: T | null = null;
  let bestDistance = radius;
  for (const item of items) {
    const p = at(item);
    const distance = Math.hypot(p.sx - sx, p.sy - sy);
    if (distance <= bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

function localPoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): { sx: number; sy: number } {
  const rect = canvas.getBoundingClientRect();
  return { sx: event.clientX - rect.left, sy: event.clientY - rect.top };
}

type Projection = {
  toScreen(x: number, z: number): { sx: number; sy: number };
  toWorld(sx: number, sy: number): { x: number; z: number };
  /** A world bearing as a canvas angle. Arcs and wedges need this, not toScreen. */
  toAngle(bearing: number): number;
  /** A world XZ offset as a canvas offset: rotated, unscaled. For arrow heads. */
  toDelta(dx: number, dz: number): { ex: number; ey: number };
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Radians the plan is turned by, clockwise on screen. 0 is north-up. */
  rotation: number;
  cx: number;
  cy: number;
};

/**
 * Plan-to-canvas transform, optionally turned.
 *
 * Rotation lives here rather than in a canvas transform because the map is an
 * input surface as well as a picture: markers, the route, hit-testing and
 * drag-to-move all go through toScreen/toWorld, and a ctx.rotate() would turn
 * the picture while leaving every coordinate the pointer code compares against
 * pointing the old way. Labels are the reason it is not the other way round -
 * drawn through toScreen they stay upright at any angle, where a canvas
 * transform would stand the numbers on their heads.
 */
function projectionFor(
  box: { minX: number; minZ: number; maxX: number; maxZ: number },
  width: number,
  height: number,
  rotation = 0,
): Projection {
  const pad = 8;
  const w = box.maxX - box.minX;
  const h = box.maxZ - box.minZ;
  // A turning plan is fitted to its own diagonal, so the corners stay inside
  // the panel at every angle. Fitting the upright box instead would clip the
  // ends of a long room as it came round, and fitting per-angle would make the
  // whole plan breathe in and out as you turned - the scale has to be constant
  // for the map to be readable while it moves.
  const span = rotation === 0 ? { w, h } : { w: Math.hypot(w, h), h: Math.hypot(w, h) };
  const scale = Math.min((width - pad * 2) / span.w, (height - pad * 2) / span.h);
  const offsetX = (width - w * scale) / 2;
  const offsetY = (height - h * scale) / 2;
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    scale, offsetX, offsetY, rotation, cx, cy,
    toScreen(x, z) {
      const ux = offsetX + (x - box.minX) * scale - cx;
      const uy = offsetY + (z - box.minZ) * scale - cy;
      return { sx: cx + ux * cos - uy * sin, sy: cy + ux * sin + uy * cos };
    },
    toWorld(sx, sy) {
      const dx = sx - cx;
      const dy = sy - cy;
      const ux = dx * cos + dy * sin;
      const uy = -dx * sin + dy * cos;
      return {
        x: box.minX + (ux + cx - offsetX) / scale,
        z: box.minZ + (uy + cy - offsetY) / scale,
      };
    },
    toAngle(bearing) {
      return bearing + rotation;
    },
    toDelta(dx, dz) {
      return { ex: dx * cos - dz * sin, ey: dx * sin + dz * cos };
    },
  };
}

export function MiniMap({
  grid,
  waypoints = [],
  selectedId = null,
  polyline = [],
  camera = null,
  comments = [],
  aims = NO_AIMS,
  shotPreview = NO_POINTS,
  onPick,
  onWaypointPick,
  onCommentPick,
  onWaypointDrag,
  height = 240,
  cameraRadius,
  title,
  hint,
}: MiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const projRef = useRef<Projection | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [overMarker, setOverMarker] = useState(false);
  const [overMap, setOverMap] = useState(false);
  const [dragging, setDragging] = useState(false);

  /* The turn the plan is drawn at. Held in a ref and eased toward the camera's
     bearing rather than tracked exactly: a pose that jitters by a degree a
     frame would make the whole map shiver, and an instant snap when the shot
     cuts to a new heading is far more disorienting than a short swing. */
  const rotRef = useRef(0);
  /* draw() eases one step per call, and calls are driven by the camera prop.
     When the camera stops mid-swing the easing would stop with it, leaving the
     plan parked at whatever angle it happened to reach - so an unconverged
     draw books its own next frame. */
  const drawRef = useRef<() => void>(() => {});
  const settleRef = useRef<number | null>(null);

  const plan = useMemo(
    () => (grid ? buildPlanLayer(grid, planColours(), cameraRadius) : null),
    [grid, cameraRadius],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const width = wrap.clientWidth;
    if (width <= 0) return;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    /* Every colour below comes from the token block in app/globals.css, read
       through components/theme.ts. A canvas cannot resolve a custom property,
       and the five hexes that used to be inlined here are exactly the ones that
       got left behind whenever the panels around them were restyled. */
    const t = theme();
    const colours = planColours();

    // No background fill. The map floats on the 3D render, so anything it does
    // not have an opinion about should show the scene rather than a slab.

    if (!grid) {
      ctx.fillStyle = t.muted;
      ctx.font = `${LABEL_FONT_PX}px ${CANVAS_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for the collider…', 12, height / 2);
      ctx.textBaseline = 'alphabetic';
      return;
    }

    /* Heading-up, always: the map is read while flying, and matching what is on
       screen beats keeping north at the top. There is no north-up mode any
       more - it was one click on a compass nobody used, and the compass was
       costing a corner of a 300px map to say something the plan's own shape
       already says. A screen with no camera pose (review, before playback)
       falls through to target 0, which is north-up by construction.

       Canvas up is -y, so a bearing b comes to the top when the plan is turned
       by (-PI/2 - b). */
    let target = 0;
    if (camera) {
      const dx = camera.lookAt[0] - camera.position[0];
      const dz = camera.lookAt[2] - camera.position[2];
      if (Math.hypot(dx, dz) > 1e-4) target = -Math.PI / 2 - Math.atan2(dz, dx);
    }
    // Ease along the short way round, so passing due north does not unwind the
    // long way through three quarters of a turn.
    let delta = (target - rotRef.current) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    rotRef.current += delta * 0.25;
    if (Math.abs(delta) > 0.002 && settleRef.current === null) {
      settleRef.current = requestAnimationFrame(() => {
        settleRef.current = null;
        drawRef.current();
      });
    }

    const proj = projectionFor(plan?.extent ?? {
      minX: grid.bounds.min.x, minZ: grid.bounds.min.z,
      maxX: grid.bounds.max.x, maxZ: grid.bounds.max.z,
    }, width, height, rotRef.current);
    projRef.current = proj;

    if (plan?.fill) {
      // Nearest-neighbour: smoothing bleeds the floor fill out past the wall
      // line and the two stop agreeing about where the edge is.
      ctx.imageSmoothingEnabled = false;
      // The only draw that cannot go through toScreen - drawImage places a
      // rectangle, so the turn has to be a canvas transform. Same centre and
      // angle as the projection, or the fill and its outline come apart.
      ctx.save();
      ctx.translate(proj.cx, proj.cy);
      ctx.rotate(proj.rotation);
      ctx.translate(-proj.cx, -proj.cy);
      ctx.drawImage(
        plan.fill, proj.offsetX, proj.offsetY,
        (plan.extent.maxX - plan.extent.minX) * proj.scale,
        (plan.extent.maxZ - plan.extent.minZ) * proj.scale,
      );
      ctx.restore();
    }
    if (plan) {
      // Outlines last, so the line work sits on top of the fills. This is what
      // makes the plan read as rooms and hallways rather than as a field of
      // coloured cells.
      strokeSegments(ctx, plan.openOutline, proj, colours.outline, 1.25);
    }

    /* the generated route */
    if (polyline.length > 1) {
      ctx.strokeStyle = t.mapRoute;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      polyline.forEach((p, i) => {
        const { sx, sy } = proj.toScreen(p[0], p[2]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    /* what the selected waypoint's shot will sweep, before anything is generated */
    if (shotPreview.length > 1) {
      ctx.strokeStyle = t.mapAim;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      shotPreview.forEach((p, i) => {
        const { sx, sy } = proj.toScreen(p[0], p[2]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* where each shot points, under the markers so it never hides a number */
    for (const w of waypoints) {
      const aim = aims.find((a) => a.id === w.id);
      if (!aim) continue;
      const { sx, sy } = proj.toScreen(w.position[0], w.position[2]);
      const selected = w.id === selectedId;
      const reach = selected ? 46 : 26;

      if (Math.abs(aim.sweep) > 1e-3) {
        // The arc the camera actually sweeps, as a wedge rooted at the marker.
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, reach, proj.toAngle(aim.from), proj.toAngle(aim.from + aim.sweep), aim.sweep < 0);
        ctx.closePath();
        ctx.fillStyle = alpha(t.mapAim, selected ? 0.3 : 0.14);
        ctx.fill();
        ctx.strokeStyle = alpha(t.mapAim, selected ? 0.9 : 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // No swing: a single tick showing which way it faces.
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        const tick = proj.toAngle(aim.from);
        ctx.lineTo(sx + Math.cos(tick) * reach, sy + Math.sin(tick) * reach);
        ctx.strokeStyle = alpha(t.mapAim, selected ? 0.9 : 0.5);
        ctx.lineWidth = selected ? 2 : 1.5;
        ctx.stroke();
      }
    }

    /* waypoints, numbered in travel order */
    waypoints.forEach((w, i) => {
      const { sx, sy } = proj.toScreen(w.position[0], w.position[2]);
      const selected = w.id === selectedId;
      ctx.beginPath();
      ctx.arc(sx, sy, selected ? MARKER_R_SELECTED : MARKER_R, 0, Math.PI * 2);
      ctx.fillStyle = selected ? t.markerSelected : t.markerFill;
      ctx.fill();
      ctx.strokeStyle = selected ? t.markerInk : t.marker;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = selected ? t.markerInkInverse : t.markerInk;
      ctx.font = `600 ${MARKER_FONT_PX}px ${CANVAS_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), sx, sy + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    });

    /* comment pins */
    for (const c of comments) {
      const { sx, sy } = proj.toScreen(c.position[0], c.position[2]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 5, sy - 10);
      ctx.lineTo(sx + 5, sy - 10);
      ctx.closePath();
      ctx.fillStyle = t.mapAim;
      ctx.fill();
      // A dark keyline, so a pin dropped on a light stretch of floor keeps its
      // silhouette instead of dissolving into it.
      ctx.strokeStyle = alpha(t.mapKeyline, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* live camera: one chevron, tip forward, tail bowed out behind it */
    if (camera) {
      const { sx, sy } = proj.toScreen(camera.position[0], camera.position[2]);
      const heading = proj.toAngle(
        Math.atan2(camera.lookAt[2] - camera.position[2], camera.lookAt[0] - camera.position[0]),
      );

      /* Drawn last, and as ONE solid glyph. A dot with a separate stem and
         arrowhead made the reader assemble three marks into a single answer,
         and at map scale the stem was long enough to be mistaken for a route.
         Position and facing are one question, so they get one shape.

         A canvas transform is safe here where it is not for the plan: this is
         decoration, so nothing has to run the same maths backwards to hit-test
         it or to turn a click back into world coordinates. */
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(heading);
      ctx.beginPath();
      ctx.moveTo(CAMERA_TIP, 0);
      ctx.lineTo(-CAMERA_TAIL, CAMERA_HALF_WIDTH);
      // Bowed away from the tip rather than cut straight across. A flat base
      // makes an equilateral triangle, which is already the comment pin's
      // shape; the swelled tail is what says "this end is the back".
      ctx.quadraticCurveTo(
        -CAMERA_TAIL - CAMERA_BULGE * 2, 0,
        -CAMERA_TAIL, -CAMERA_HALF_WIDTH,
      );
      ctx.closePath();

      // Halo first, stroked wide: half the line lands outside the fill, which
      // is what holds the white edge wherever the marker happens to be sitting
      // - over the dark plan, or off it and onto the bright render behind.
      ctx.lineJoin = 'round';
      ctx.strokeStyle = alpha(t.mapKeyline, 0.6);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = t.mapCamera;
      ctx.fill();
      ctx.restore();
    }
  }, [
    grid, plan, waypoints, selectedId, polyline, camera, comments, shotPreview,
    height,
  ]);

  /* The settle frame calls through this ref rather than closing over `draw`,
     so a frame booked by one render runs the newest draw rather than a stale
     one. It was declared and never assigned, which left every unconverged
     swing calling an empty function: the plan stopped turning the instant the
     camera did and parked at whatever angle the last prop change reached. */
  useEffect(() => {
    drawRef.current = draw;
    draw();
    return () => {
      if (settleRef.current === null) return;
      cancelAnimationFrame(settleRef.current);
      settleRef.current = null;
    };
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  const endGesture = useCallback((pointerId: number) => {
    gestureRef.current = null;
    setDragging(false);
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }, []);

  /**
   * Is this world point on the drawn plan?
   *
   * The canvas is a rectangle and the plan inside it is not - on a long narrow
   * room most of the panel is blank margin. Testing a click against the canvas
   * made all of that margin behave like floor: a click far outside the
   * building dropped a waypoint, because the snap in the page then dragged it
   * to the nearest reachable cell, which could be metres away and in a room
   * the user was not pointing at.
   *
   * One cell of tolerance, so clicking the very edge of a wall still counts.
   * Anything further out is not a near miss, it is a click on the background.
   */
  const onMap = useCallback(
    (x: number, z: number): boolean => {
      const shown = plan?.shown;
      if (!grid || !shown) return false;
      const { col, row } = worldToCell(grid, x, z);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = col + dc;
          const r = row + dr;
          if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
          if (shown[cellIndex(grid, c, r)]) return true;
        }
      }
      return false;
    },
    [grid, plan],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const proj = projRef.current;
      const canvas = canvasRef.current;
      if (!proj || !canvas || event.button !== 0) return;
      const { sx, sy } = localPoint(canvas, event);

      // Pins and waypoints take precedence over dropping a new one.
      const comment = hitTest(
        comments, (c) => proj.toScreen(c.position[0], c.position[2]), sx, sy, COMMENT_HIT_R,
      );
      const waypoint = comment
        ? null
        : hitTest(
            waypoints, (w) => proj.toScreen(w.position[0], w.position[2]), sx, sy, MARKER_HIT_R,
          );

      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        dragId: waypoint && onWaypointDrag ? waypoint.id : null,
        waypointId: waypoint?.id ?? null,
        commentId: comment?.id ?? null,
      };
      // Keep the gesture even if the pointer leaves the canvas mid-drag.
      canvas.setPointerCapture(event.pointerId);
      // Otherwise the press starts a text selection instead of a drag.
      event.preventDefault();
    },
    [comments, waypoints, onWaypointDrag],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const proj = projRef.current;
      const canvas = canvasRef.current;
      if (!proj || !canvas) return;
      const { sx, sy } = localPoint(canvas, event);
      const gesture = gestureRef.current;

      if (!gesture) {
        // Hovering: say that markers can be picked up before anyone tries.
        const over =
          onWaypointDrag != null &&
          hitTest(
            waypoints, (w) => proj.toScreen(w.position[0], w.position[2]), sx, sy, MARKER_HIT_R,
          ) != null;
        setOverMarker(over);
        const at = proj.toWorld(sx, sy);
        setOverMap(onMap(at.x, at.z));
        return;
      }
      if (gesture.pointerId !== event.pointerId) return;

      if (
        !gesture.dragging &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > CLICK_SLOP_PX
      ) {
        gesture.dragging = true;
        if (gesture.dragId) setDragging(true);
      }
      if (!gesture.dragging || !gesture.dragId) return;

      const { x, z } = proj.toWorld(sx, sy);
      onWaypointDrag?.(gesture.dragId, x, z);
    },
    [waypoints, onWaypointDrag, onMap],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const proj = projRef.current;
      const canvas = canvasRef.current;
      const wasDrag = gesture.dragging;
      endGesture(event.pointerId);

      // A drag is a drag whether or not it moved a marker: releasing one over
      // empty floor must not also drop a waypoint there.
      if (wasDrag || !proj || !canvas) return;

      if (gesture.commentId) {
        onCommentPick?.(gesture.commentId);
        return;
      }
      if (gesture.waypointId) {
        onWaypointPick?.(gesture.waypointId);
        return;
      }
      const { sx, sy } = localPoint(canvas, event);
      const { x, z } = proj.toWorld(sx, sy);
      if (!onMap(x, z)) return;
      onPick?.(x, z);
    },
    [endGesture, onPick, onWaypointPick, onCommentPick, onMap],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (gestureRef.current?.pointerId !== event.pointerId) return;
      endGesture(event.pointerId);
    },
    [endGesture],
  );

  const cursor = dragging
    ? 'grabbing'
    : overMarker
      ? 'grab'
      : onPick && overMap
        ? 'crosshair'
        : 'default';

  return (
    <div className="minimap">
      {(title || hint) && (
        <div className="minimap__head">
          {title ? <span className="minimap__title">{title}</span> : <span />}
          {hint ? <span>{hint}</span> : null}
        </div>
      )}
      <div className="minimap__frame" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="minimap__canvas"
          /* The map is a drawing of the room, so it is announced as one. Its
             pointer gestures are a shortcut, not the only route: selecting a
             waypoint and jumping to a comment are both buttons in the sidebar
             lists. Dropping a NEW waypoint is map- or viewport-only, which is a
             real gap and wants a control of its own rather than a label. */
          role="img"
          aria-label={describe(grid != null, waypoints.length, comments.length)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={() => {
            setOverMarker(false);
            setOverMap(false);
          }}
          style={{ cursor }}
        />
      </div>
    </div>
  );
}

/** What the map currently shows, for anything that cannot look at it. */
function describe(hasGrid: boolean, waypoints: number, comments: number): string {
  if (!hasGrid) return 'Top-down map of the capture. Waiting for the collider to load.';
  const parts = [`${waypoints} waypoint${waypoints === 1 ? '' : 's'}`];
  if (comments > 0) parts.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  return `Top-down map of the capture, showing ${parts.join(' and ')}.`;
}
