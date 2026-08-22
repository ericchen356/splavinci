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
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Comment, Vec3, Waypoint } from '@/lib/types';
import { type WalkGrid } from '@/lib/path';
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
  /** Click on empty floor. Receives world x/z. */
  onPick?: (x: number, z: number) => void;
  onWaypointPick?: (id: string) => void;
  onCommentPick?: (id: string) => void;
  height?: number;
  /** Shown top-left inside the map. */
  title?: string;
  hint?: string;
};

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
  onPick,
  onWaypointPick,
  onCommentPick,
  height = 240,
  title,
  hint,
}: MiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const projRef = useRef<Projection | null>(null);

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
  }, [grid, plan, waypoints, selectedId, polyline, camera, comments, height, title, hint]);

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

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const proj = projRef.current;
      const canvas = canvasRef.current;
      if (!proj || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;

      // Pins and waypoints take precedence over dropping a new one.
      for (const c of comments) {
        const p = proj.toScreen(c.position[0], c.position[2]);
        if (Math.hypot(p.sx - sx, p.sy - sy) <= 9) {
          onCommentPick?.(c.id);
          return;
        }
      }
      for (const w of waypoints) {
        const p = proj.toScreen(w.position[0], w.position[2]);
        if (Math.hypot(p.sx - sx, p.sy - sy) <= 10) {
          onWaypointPick?.(w.id);
          return;
        }
      }

      const { x, z } = proj.toWorld(sx, sy);
      onPick?.(x, z);
    },
    [comments, waypoints, onPick, onWaypointPick, onCommentPick],
  );

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{
          display: 'block',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--line)',
          cursor: onPick ? 'crosshair' : 'default',
        }}
      />
    </div>
  );
}
