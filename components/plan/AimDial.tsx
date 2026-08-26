'use client';

/**
 * Where a shot points, and how far it swings, set by dragging or by typing.
 *
 * A shot aimed at a blank wall used to have no remedy but moving the waypoint,
 * because the direction was always inferred. This is a compass, not a pair of
 * number fields: the quantity is an angle in the room, and the fastest way to
 * say "sweep from there to there" is to point at both. The two fields beside it
 * are for the other half of the job - "make that exactly 90 degrees" is a thing
 * you can say in one keystroke and cannot say with a drag at all.
 *
 * Oriented to match the mini-map exactly - +x right, +z down, bearings
 * measured as atan2(dz, dx) - so an arc set here lands where the map shows it.
 *
 * The handles are draggable AND focusable. Dragging is the fast way to set an
 * angle and keyboard is the only way for anyone not using a pointer, so each
 * handle is a slider in its own right: arrow keys nudge by a degree, shift by
 * ten, and the value is announced in degrees rather than as radians nobody
 * asked about.
 *
 * WHY THE SWEEP STOPS AT A FULL TURN
 * `sweep` is signed and was unbounded, and both facts broke the drawing past
 * 360 degrees. An SVG elliptical arc cannot express more than one turn: at
 * exactly 360 the two endpoints coincide and the arc is dropped entirely (the
 * wedge vanishes), and beyond it the arc silently renders `sweep mod 360` while
 * the large-arc flag - computed from the unwrapped angle - picks the wrong one
 * of the two candidate arcs, so the fill jumps to the complement of what the
 * handles show.
 *
 * The fix is to clamp at +/-360 rather than to keep drawing past it, because
 * this control cannot depict the difference: a second turn puts both handles
 * back on bearings the first turn already used, so 370 degrees and 10 degrees
 * are the same picture and no amount of drawing makes them distinguishable.
 * A value the dial cannot show is one the user cannot check or undo by eye. The
 * camera loses nothing that reads as a bigger move either - past one revolution
 * an orbit is repeating a view it has already given, more slowly.
 *
 * A full turn does still have to draw, so it is rendered as a disc rather than
 * as an arc with coincident ends.
 */

import { useCallback, useId, useRef, useState } from 'react';
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

/** One turn either way. See the note above on why this is a clamp. */
function clampSweep(sweep: number): number {
  return sweep < -TAU ? -TAU : sweep > TAU ? TAU : sweep;
}

function polar(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

/** Bearing in degrees, 0-359.99. Unrounded: the field below rounds for display
 *  but must not round what it commits back, or reading a dial would edit it. */
function toDegrees(radians: number): number {
  return (((radians * 180) / Math.PI) % 360 + 360) % 360;
}

/** Bearing in whole degrees, for a label a screen reader reads out. */
function degrees(radians: number): number {
  return Math.round(toDegrees(radians)) % 360;
}

/* -------------------------------------------------------------------------- */
/* the typed number                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A number you can type, not only drag.
 *
 * Every quantity in the inspector had exactly one way in - a slider or a dial -
 * which is fine for "a bit longer" and useless for "4.25 seconds". This pairs
 * with the slider rather than replacing it, so the coarse gesture and the exact
 * value are both available and both edit the same number.
 *
 * IT MUST NOT FIGHT THE TYPIST. The draft the user is part-way through typing
 * is authoritative while the field has focus and the stored value is
 * authoritative the rest of the time, so a keystroke is never overwritten by a
 * re-render and a slider drag is never shadowed by a stale draft. Nothing is
 * committed per keystroke: "1" on the way to "12" would otherwise be applied,
 * clamped to the minimum and handed back, which is the classic way these
 * controls eat the second digit.
 *
 * `type=text` rather than `type=number`, deliberately: a number input reports
 * an empty string for every partially-typed value ("1.", "-") so the draft
 * cannot be read back reliably, and its spinners are 8px tall. `inputMode`
 * still asks for the numeric keypad, and the arrow keys are implemented here so
 * nothing is lost by giving them up.
 *
 * Lives in this file because the two files that need it are this one and the
 * panel that imports it; putting it here keeps the dependency one-way.
 */
export type NumberFieldProps = {
  /** Visible label, wired to the input - so it is the accessible name too. */
  label: string;
  /** Quiet aside after the label: "style default", "auto suggests pan". */
  note?: string;
  /** Long-form explanation of what the number does, on hover. */
  title?: string;
  value: number;
  min: number;
  max: number;
  /** Arrow-key increment. Shift multiplies it by ten. */
  step: number;
  /** Decimal places kept when a typed value is committed. */
  decimals?: number;
  /** Suffix shown inside the box. Decorative - the label carries the meaning. */
  unit?: string;
  /**
   * For a quantity with a period rather than two ends: a committed value wraps
   * modulo this instead of clamping, because a bearing of 370 degrees is 10,
   * not 360. Left unset, the value clamps to min..max.
   */
  wrapAt?: number;
  onCommit: (value: number) => void;
};

/** Trailing zeros dropped: a duration reads "4.2" and "5", never "5.00". */
function format(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

/** Null for anything that is not a number, including the empty field. */
function parse(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function NumberField({
  label, note, title, value, min, max, step, decimals = 2, unit, wrapAt, onCommit,
}: NumberFieldProps) {
  const id = useId();
  // Non-null only while the user is part-way through typing something.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? format(value, decimals);

  /** Bring a raw number into range and to the precision this field keeps. */
  const resolve = useCallback(
    (n: number): number => {
      const inRange = wrapAt ? ((n % wrapAt) + wrapAt) % wrapAt : Math.min(max, Math.max(min, n));
      return Number(inRange.toFixed(decimals));
    },
    [decimals, max, min, wrapAt],
  );

  /** End the edit. Nonsense reverts to the stored value rather than clearing
   *  it, and an unchanged value is not committed - every commit here marks the
   *  waypoint edited and invalidates the generated path. */
  const settle = (raw: string) => {
    setDraft(null);
    const parsed = parse(raw);
    if (parsed === null) return;
    const next = resolve(parsed);
    if (next !== Number(value.toFixed(decimals))) onCommit(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      settle(text);
      return;
    }
    if (e.key === 'Escape') {
      // Abandon the edit; the field falls back to the stored value.
      setDraft(null);
      return;
    }
    const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const base = parse(text) ?? value;
    const next = resolve(base + dir * step * (e.shiftKey ? 10 : 1));
    setDraft(format(next, decimals));
    onCommit(next);
  };

  return (
    <div className="numfield">
      <label className="numfield__label" htmlFor={id} title={title}>
        {label}
        {note && <span className="numfield__note">{note}</span>}
      </label>
      <span className="numfield__box">
        <input
          id={id}
          className="numfield__input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          // Typing over a value is the common case; selecting it saves a
          // select-all every time.
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => settle(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {unit && <span className="numfield__unit">{unit}</span>}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function AimDial({ aim, sweeps, explicit, onChange, onReset, size = 116 }: AimDialProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<'from' | 'to' | null>(null);
  /* The arc is widened by how far the POINTER has moved since the last frame,
     accumulated here, rather than by the gap between the pointer and the arc's
     end. Measuring against the end works right up until the clamp: the end
     stops at a full turn while the pointer carries on, and the moment the
     pointer passes the point opposite that stalled end, "the shortest way
     round" reverses and the arc snaps back half a turn. Following the pointer's
     own motion has no such reference point to cross. */
  const drag = useRef({ bearing: 0, sweep: 0 });

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 12;

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
    drag.current = { bearing: bearingAt(e.clientX, e.clientY), sweep: aim.sweep };
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
      // Widen by however far the pointer travelled, so an arc can be taken past
      // half a turn by carrying on round rather than flipping. Clamped as it
      // accumulates, not after: the drag then stops dead at a full turn and
      // gives way the instant it is dragged back, where holding an unclamped
      // total would ignore the first turn's worth of the return trip.
      drag.current.sweep = clampSweep(
        drag.current.sweep + angleDelta(bearing, drag.current.bearing),
      );
      drag.current.bearing = bearing;
      onChange({ from: aim.from, sweep: drag.current.sweep });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    dragging.current = null;
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  /* Keyboard is the same two edits the pointer makes, in one-degree steps (ten
     with shift). An exact angle is quicker to type than to nudge, so the fields
     beside the dial are the other half of this. */
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
    else onChange({ from: aim.from, sweep: clampSweep(aim.sweep + delta) });
  };

  const from = aim.from;
  const sweep = clampSweep(aim.sweep);
  const to = from + sweep;
  const a = polar(cx, cy, radius, from);
  const b = polar(cx, cy, radius, to);
  const arcDegrees = (sweep * 180) / Math.PI;
  // A full turn has coincident endpoints, which an SVG arc drops rather than
  // draws. Sectors up to that point are safe now that sweep cannot exceed one.
  const full = Math.abs(sweep) >= TAU - 1e-6;
  const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  const wedge = `M ${cx} ${cy} L ${a.x} ${a.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${b.x} ${b.y} Z`;

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
      >
        <circle className="dial__face" cx={cx} cy={cy} r={radius} aria-hidden="true" />
        {sweeps &&
          (full ? (
            <circle className="dial__wedge" cx={cx} cy={cy} r={radius} aria-hidden="true" />
          ) : (
            <path className="dial__wedge" d={wedge} aria-hidden="true" />
          ))}
        <line className="dial__ray" x1={cx} y1={cy} x2={a.x} y2={a.y} aria-hidden="true" />
        {sweeps && (
          <line className="dial__ray" x1={cx} y1={cy} x2={b.x} y2={b.y} aria-hidden="true" />
        )}
        <circle className="dial__hub" cx={cx} cy={cy} r={2.5} aria-hidden="true" />
        <circle
          className="dial__handle"
          cx={a.x}
          cy={a.y}
          r={7}
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
            className="dial__handle dial__handle--to"
            cx={b.x}
            cy={b.y}
            r={7}
            tabIndex={0}
            role="slider"
            aria-label="Sweep end bearing"
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={degrees(to)}
            aria-valuetext={`${degrees(to)} degrees, a ${Math.round(arcDegrees)} degree arc`}
            onPointerDown={onPointerDown('to')}
            onKeyDown={onHandleKey('to')}
          />
        )}
      </svg>

      <div className="dial__readout">
        <NumberField
          label="Facing"
          value={toDegrees(from)}
          min={0}
          max={360}
          wrapAt={360}
          step={1}
          decimals={1}
          unit="°"
          title="Bearing the shot points along, measured the way the map is drawn."
          onCommit={(deg) => onChange({ from: deg * DEG, sweep: aim.sweep })}
        />
        {sweeps && (
          <NumberField
            label="Arc"
            value={arcDegrees}
            min={-360}
            max={360}
            step={5}
            decimals={1}
            unit="°"
            title="How far it swings, and which way: negative turns anticlockwise. One full turn either way is the most the shot can show."
            onCommit={(deg) => onChange({ from: aim.from, sweep: clampSweep(deg * DEG) })}
          />
        )}
        <button
          type="button"
          className="btn btn--sm dial__auto"
          onClick={onReset}
          disabled={!explicit}
          title="Go back to the facing this waypoint was captured at."
        >
          Auto
        </button>
      </div>
    </div>
  );
}
