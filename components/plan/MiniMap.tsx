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
import { type WalkGrid } from '@/lib/path';
import { CLICK_SLOP_PX } from '@/components/scene/pointer';
import { buildPlanLayer, DEFAULT_PLAN_COLOURS, strokeSegments } from './blueprint';

export type MiniMapProps = {
  grid: WalkGrid | null;
  waypoints?: readonly Waypoint[];
  selectedId?: string | null;
  /** Generated route, drawn as a line. */
  polyline?: readonly Vec3[];
  /** Live camera pose - draws a dot with a facing arrow. */
  camera?: { position: Vec3; lookAt: Vec3 } | null;
  comments?: readonly Comment[];
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
  /** Shown top-left inside the map. */
  title?: string;
  hint?: string;
};

/** Shared default, so a screen that passes no preview does not hand `draw` a
 *  fresh array - and a fresh dependency - on every render. */
const NO_POINTS: readonly Vec3[] = [];

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
  scale: number;
  offsetX: number;
  offsetY: number;
};

function projectionFor(
  box: { minX: number; minZ: number; maxX: number; maxZ: number },
  width: number,
  height: number,
): Projection {
  const pad = 8;
  const w = box.maxX - box.minX;
  const h = box.maxZ - box.minZ;
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  const offsetX = (width - w * scale) / 2;
  const offsetY = (height - h * scale) / 2;
  return {
    scale, offsetX, offsetY,
    toScreen(x, z) {
      return {
        sx: offsetX + (x - box.minX) * scale,
        sy: offsetY + (z - box.minZ) * scale,
      };
    },
    toWorld(sx, sy) {
      return {
        x: box.minX + (sx - offsetX) / scale,
        z: box.minZ + (sy - offsetY) / scale,
      };
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
  shotPreview = NO_POINTS,
  onPick,
  onWaypointPick,
  onCommentPick,
  onWaypointDrag,
  height = 240,
  title,
  hint,
}: MiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const projRef = useRef<Projection | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [overMarker, setOverMarker] = useState(false);
  const [dragging, setDragging] = useState(false);

  const plan = useMemo(() => (grid ? buildPlanLayer(grid) : null), [grid]);

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

    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, width, height);

    if (!grid) {
      ctx.fillStyle = '#98a2b0';
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('waiting for collider…', 12, height / 2);
      return;
    }

    const proj = projectionFor(plan?.extent ?? {
      minX: grid.bounds.min.x, minZ: grid.bounds.min.z,
      maxX: grid.bounds.max.x, maxZ: grid.bounds.max.z,
    }, width, height);
    projRef.current = proj;

    if (plan?.fill) {
      // Nearest-neighbour: smoothing bleeds the floor fill out past the wall
      // line and the two stop agreeing about where the edge is.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        plan.fill, proj.offsetX, proj.offsetY,
        (plan.extent.maxX - plan.extent.minX) * proj.scale,
        (plan.extent.maxZ - plan.extent.minZ) * proj.scale,
      );
    }
    if (plan) {
      // Outlines last, so the line work sits on top of the fills. This is what
      // makes the plan read as rooms and hallways rather than as a field of
      // coloured cells.
      strokeSegments(ctx, plan.wallOutline, proj, DEFAULT_PLAN_COLOURS.wallOutline, 1);
      strokeSegments(ctx, plan.openOutline, proj, DEFAULT_PLAN_COLOURS.outline, 1.25);
    }

    /* the generated route */
    if (polyline.length > 1) {
      ctx.strokeStyle = '#6ea8fe';
      ctx.lineWidth = 2;
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
      ctx.strokeStyle = '#ffb454';
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

    /* waypoints, numbered in travel order */
    waypoints.forEach((w, i) => {
      const { sx, sy } = proj.toScreen(w.position[0], w.position[2]);
      const selected = w.id === selectedId;
      ctx.beginPath();
      ctx.arc(sx, sy, selected ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#6ea8fe' : '#1d222a';
      ctx.fill();
      ctx.strokeStyle = selected ? '#dce9ff' : '#6ea8fe';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = selected ? '#0d0f12' : '#e8eaed';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
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
      ctx.lineTo(sx - 5, sy - 9);
      ctx.lineTo(sx + 5, sy - 9);
      ctx.closePath();
      ctx.fillStyle = '#ffb454';
      ctx.fill();
    }

    /* live camera: dot plus facing arrow */
    if (camera) {
      const { sx, sy } = proj.toScreen(camera.position[0], camera.position[2]);
      const dx = camera.lookAt[0] - camera.position[0];
      const dz = camera.lookAt[2] - camera.position[2];
      const len = Math.hypot(dx, dz) || 1;
      const ax = (dx / len) * 16;
      const az = (dz / len) * 16;

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + ax, sy + az);
      ctx.stroke();

      // arrow head
      const angle = Math.atan2(az, ax);
      ctx.beginPath();
      ctx.moveTo(sx + ax, sy + az);
      ctx.lineTo(sx + ax - 6 * Math.cos(angle - 0.4), sy + az - 6 * Math.sin(angle - 0.4));
      ctx.lineTo(sx + ax - 6 * Math.cos(angle + 0.4), sy + az - 6 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0d0f12';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (title) {
      ctx.fillStyle = 'rgba(232,234,237,0.75)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(title, 8, 14);
    }
    if (hint) {
      ctx.fillStyle = 'rgba(152,162,176,0.75)';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(hint, 8, height - 8);
    }
  }, [
    grid, plan, waypoints, selectedId, polyline, camera, comments, shotPreview,
    height, title, hint,
  ]);

  useEffect(() => {
    draw();
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

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const proj = projRef.current;
      const canvas = canvasRef.current;
      if (!proj || !canvas || event.button !== 0) return;
      const { sx, sy } = localPoint(canvas, event);

      // Pins and waypoints take precedence over dropping a new one.
      const comment = hitTest(comments, (c) => proj.toScreen(c.position[0], c.position[2]), sx, sy, 9);
      const waypoint = comment
        ? null
        : hitTest(waypoints, (w) => proj.toScreen(w.position[0], w.position[2]), sx, sy, 10);

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
          hitTest(waypoints, (w) => proj.toScreen(w.position[0], w.position[2]), sx, sy, 10) != null;
        setOverMarker(over);
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
    [waypoints, onWaypointDrag],
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
      onPick?.(x, z);
    },
    [endGesture, onPick, onWaypointPick, onCommentPick],
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
      : onPick
        ? 'crosshair'
        : 'default';

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setOverMarker(false)}
        style={{
          display: 'block',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--line)',
          cursor,
          // A touch drag has to move the marker, not scroll the page.
          touchAction: 'none',
        }}
      />
    </div>
  );
}
