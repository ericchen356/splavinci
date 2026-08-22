'use client';

/**
 * Where a shot points, and how far it swings, set by dragging.
 *
 * A shot aimed at a blank wall used to have no remedy but moving the waypoint,
 * because the direction was always inferred. This is a compass, not a pair of
 * number fields: the quantity is an angle in the room, and the fastest way to
 * say "sweep from there to there" is to point at both.
 *
 * Oriented to match the mini-map exactly - +x right, +z down, bearings
 * measured as atan2(dz, dx) - so an arc set here lands where the map shows it.
 */

import { useCallback, useRef } from 'react';
import type { ShotAim } from '@/lib/types';

export type AimDialProps = {
  aim: ShotAim;
  /** Whether this shot swings. A push-in only needs a direction. */
  sweeps: boolean;
  /** True when the aim came from the user rather than being inferred. */
  explicit: boolean;
  onChange: (aim: ShotAim) => void;
  onReset: () => void;
  size?: number;
};

const TAU = Math.PI * 2;

/** Shortest signed difference, so dragging past due-north does not unwind. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function polar(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

export function AimDial({ aim, sweeps, explicit, onChange, onReset, size = 132 }: AimDialProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<'from' | 'to' | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 14;

  const bearingAt = useCallback((clientX: number, clientY: number): number => {
    const svg = ref.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return Math.atan2(clientY - rect.top - cy, clientX - rect.left - cx);
  }, [cx, cy]);

  const onPointerDown = (handle: 'from' | 'to') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragging.current = handle;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const bearing = bearingAt(e.clientX, e.clientY);
    if (dragging.current === 'from') {
      // Move the whole arc: the start is the thing being pointed, and its
      // width is a separate decision the other handle owns.
      onChange({ from: bearing, sweep: aim.sweep });
    } else {
      // Track the shortest way round from the current end, so a sweep can be
      // widened past half a turn by continuing to drag rather than flipping.
      const end = aim.from + aim.sweep;
      onChange({ from: aim.from, sweep: aim.sweep + angleDelta(bearing, end) });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    dragging.current = null;
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const from = aim.from;
  const to = aim.from + aim.sweep;
  const a = polar(cx, cy, radius, from);
  const b = polar(cx, cy, radius, to);
  const largeArc = Math.abs(aim.sweep) > Math.PI ? 1 : 0;
  const sweepFlag = aim.sweep >= 0 ? 1 : 0;
  const wedge = sweeps
    ? `M ${cx} ${cy} L ${a.x} ${a.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${b.x} ${b.y} Z`
    : '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg
          ref={ref}
          width={size}
          height={size}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: 'none', flex: '0 0 auto' }}
        >
          <circle cx={cx} cy={cy} r={radius} fill="var(--panel-2)" stroke="var(--line)" />
          {sweeps && <path d={wedge} fill="rgba(110,168,254,0.28)" stroke="none" />}
          <line
            x1={cx} y1={cy} x2={a.x} y2={a.y}
            stroke="var(--accent)" strokeWidth={2}
          />
          {sweeps && (
            <line x1={cx} y1={cy} x2={b.x} y2={b.y} stroke="var(--accent)" strokeWidth={2} />
          )}
          <circle cx={cx} cy={cy} r={3} fill="var(--text)" />
          <circle
            cx={a.x} cy={a.y} r={7}
            fill="var(--accent)" stroke="var(--bg)" strokeWidth={2}
            style={{ cursor: 'grab' }}
            onPointerDown={onPointerDown('from')}
          />
          {sweeps && (
            <circle
              cx={b.x} cy={b.y} r={7}
              fill="var(--panel)" stroke="var(--accent)" strokeWidth={2}
              style={{ cursor: 'grab' }}
              onPointerDown={onPointerDown('to')}
            />
          )}
        </svg>

        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <div>
            <span style={{ color: 'var(--text)' }}>{Math.round(((from * 180) / Math.PI + 360) % 360)}°</span>
            {sweeps && (
              <>
                {' → '}
                <span style={{ color: 'var(--text)' }}>
                  {Math.round(((to * 180) / Math.PI + 360) % 360)}°
                </span>
              </>
            )}
          </div>
          {sweeps && <div>{Math.round((aim.sweep * 180) / Math.PI)}° arc</div>}
          <button
            onClick={onReset}
            disabled={!explicit}
            style={{ padding: '2px 8px', fontSize: 11, marginTop: 4 }}
          >
            Auto
          </button>
        </div>
      </div>
    </div>
  );
}
