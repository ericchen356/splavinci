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
 *
 * The handles are draggable AND focusable. Dragging is the fast way to set an
 * angle and keyboard is the only way for anyone not using a pointer, so each
 * handle is a slider in its own right: arrow keys nudge by a degree, shift by
 * ten, and the value is announced in degrees rather than as radians nobody
 * asked about.
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
const DEG = Math.PI / 180;

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

/** Bearing in whole degrees, 0-359, for a readout or a label. */
function degrees(radians: number): number {
  return Math.round(((radians * 180) / Math.PI + 360) % 360);
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

  /* Keyboard is the same two edits the pointer makes, in one-degree steps.
     Home resets the handle it is on, which is the keyboard equivalent of the
     Auto button beside the dial. */
  const onHandleKey = (handle: 'from' | 'to') => (e: React.KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const delta = step * (e.shiftKey ? 10 : 1) * DEG;
    if (handle === 'from') onChange({ from: aim.from + delta, sweep: aim.sweep });
    else onChange({ from: aim.from, sweep: aim.sweep + delta });
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
    <div className="dial">
      <svg
        ref={ref}
        className="dial__svg"
        width={size}
        height={size}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-hidden="true"
      >
        <circle cx={cx} cy={cy} r={radius} fill="var(--surface-sunk)" stroke="var(--line-strong)" />
        {sweeps && <path d={wedge} fill="var(--accent)" fillOpacity={0.28} stroke="none" />}
        <line x1={cx} y1={cy} x2={a.x} y2={a.y} stroke="var(--accent)" strokeWidth={2} />
        {sweeps && (
          <line x1={cx} y1={cy} x2={b.x} y2={b.y} stroke="var(--accent)" strokeWidth={2} />
        )}
        <circle cx={cx} cy={cy} r={3} fill="var(--ink)" />
        <circle
          className="dial__handle"
          cx={a.x}
          cy={a.y}
          r={8}
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth={2}
          tabIndex={0}
          role="slider"
          aria-label={sweeps ? 'Sweep start bearing' : 'Facing bearing'}
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={degrees(from)}
          aria-valuetext={`${degrees(from)} degrees`}
          onPointerDown={onPointerDown('from')}
          onKeyDown={onHandleKey('from')}
        />
        {sweeps && (
          <circle
            className="dial__handle"
            cx={b.x}
            cy={b.y}
            r={8}
            fill="var(--surface)"
            stroke="var(--accent)"
            strokeWidth={2}
            tabIndex={0}
            role="slider"
            aria-label="Sweep end bearing"
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={degrees(to)}
            aria-valuetext={`${degrees(to)} degrees, a ${Math.round(
              (aim.sweep * 180) / Math.PI,
            )} degree arc`}
            onPointerDown={onPointerDown('to')}
            onKeyDown={onHandleKey('to')}
          />
        )}
      </svg>

      <div className="dial__readout">
        <div className="num">
          <span className="strong-ink">{degrees(from)}°</span>
          {sweeps && (
            <>
              {' → '}
              <span className="strong-ink">{degrees(to)}°</span>
            </>
          )}
        </div>
        {sweeps && <div className="num">{Math.round((aim.sweep * 180) / Math.PI)}° arc</div>}
        <button
          type="button"
          className="btn btn--sm"
          onClick={onReset}
          disabled={!explicit}
          title="Go back to the bearing the generator infers from the room."
        >
          Auto
        </button>
      </div>
    </div>
  );
}
