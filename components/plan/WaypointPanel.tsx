'use client';

/**
 * The per-waypoint technique panel.
 *
 * Auto and Manual are a toggle, not two ends of a slider. Under a blend the
 * duration you typed was not the duration you got, and shot type snapped at
 * the midpoint of a control that looked continuous. Here the panel shows
 * exactly one resolved shot.
 *
 * Manual parameters are not rendered at all in auto mode rather than shown
 * disabled: a greyed-out control still implies the value matters, and in auto
 * mode it does not. Switching to Manual seeds them from whatever auto just
 * resolved, so control is taken over the shot on screen rather than a default.
 *
 * The amplitude slider applies in both modes, because scaling a shot is a
 * matter of degree even when you are happy to let the system pick the shot -
 * but what it scales is named per shot, and shots it does nothing for do not
 * show it. See MAGNITUDE.
 *
 * WHAT THE RESOLVED SHOT LINE IS ALLOWED TO CLAIM
 * `resolveShot` runs before the generator measures the shot against the walls,
 * so on its own it is a proposal, not a report: `fitShotToRoom` may shrink the
 * move, or - where even a motionless camera clips - hold instead. Rendering
 * that proposal as fact is what let the panel promise an orbit the camera never
 * performed. So the generated shot wins whenever one exists, the proposal is
 * labelled as a preview when it does not, and a shot the walls changed says so.
 *
 * The SHAPE of the controls below that line follows the generated shot too -
 * which handles the dial has, which quantity the slider names - because those
 * describe the shot that will actually be performed. Their VALUES stay on the
 * live resolution and on the waypoint itself: a dial reporting a path generated
 * before the current edit would not respond to being dragged.
 *
 * Screen-agnostic on purpose: the review screen reopens this same panel from
 * its technique label, and both screens hand the generated shot in rather than
 * having the panel reach into a store.
 */

import { AimDial } from './AimDial';
import {
  EMPHASIS_RANGE,
  SHOT_TYPES,
  type PathStyle,
  type ShotType,
  type Waypoint,
} from '@/lib/types';
import {
  resolveShot,
  type PathResult,
  type PathWarning,
  type ShotIntent,
  type WalkGrid,
} from '@/lib/path';

export type WaypointPanelProps = {
  waypoint: Waypoint;
  index: number;
  total: number;
  /** The walk grid the auto end reads the walls from. Null before it loads. */
  grid: WalkGrid | null;
  style: PathStyle;
  /**
   * The shot the generator actually emitted for this waypoint, post wall
   * validation. Null when no current path covers it, which falls the resolved
   * line back to a live preview - the best answer available at that point, and
   * marked as such rather than passed off as the generated one.
   */
  generated?: ShotIntent | null;
  /** The `shot-clipped` warning naming this waypoint, if the walls changed it. */
  clipped?: PathWarning | null;
  onChange: (patch: Partial<Omit<Waypoint, 'id'>>) => void;
  onRemove?: () => void;
  onReorder?: (delta: number) => void;
  onClose?: () => void;
  /** Extra controls (the review screen adds a "jump to this shot" button). */
  footer?: React.ReactNode;
};

const row: React.CSSProperties = { marginBottom: 14 };
const labelStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
  fontSize: 12, color: 'var(--muted)', marginBottom: 6,
};

/**
 * What emphasis scales, per shot - because it is not one quantity.
 *
 * The slider drives a single number, but that number lands on an orbit's
 * radius, a rise's height and a dolly's length, and the one label they shared
 * ("Move size") could only describe them by listing them. Naming the quantity
 * per shot is the whole point of the table; keeping it a table rather than a
 * run of conditionals in the JSX is what keeps the seven answers in one place.
 *
 * Pan and hold hide it rather than grey it out, for the reason the manual
 * controls are hidden in auto mode: a disabled control still implies its value
 * matters. A pan's amplitude is its arc, which the dial above already owns, and
 * a hold has no amplitude at all - measured inert at every setting.
 */
const MAGNITUDE: Record<ShotType, { showMagnitude: boolean; label: string }> = {
  orbit: { showMagnitude: true, label: 'Radius' },
  'push-in': { showMagnitude: true, label: 'Distance' },
  'pull-back': { showMagnitude: true, label: 'Distance' },
  rise: { showMagnitude: true, label: 'Height' },
  'dolly-through': { showMagnitude: true, label: 'Length' },
  pan: { showMagnitude: false, label: '' },
  hold: { showMagnitude: false, label: '' },
};

export function WaypointPanel({
  waypoint, index, total, grid, style, generated, clipped,
  onChange, onRemove, onReorder, onClose, footer,
}: WaypointPanelProps) {
  // The waypoint as it stands right now. Every control edits this.
  const preview = resolveShot(waypoint, grid, style);
  const shown = generated ?? preview;
  // What was asked for before the walls had their say: a manual waypoint names
  // its own shot, auto's ask is the type it inferred. Both survive the fit, so
  // this stays readable off the generated intent itself.
  const askedFor: ShotType | null = generated
    ? generated.source === 'manual' ? waypoint.shotType : generated.autoShotType
    : null;
  const replaced = generated != null && askedFor != null && generated.shotType !== askedFor;
  const manual = waypoint.mode === 'manual';
  // Only these swing; the rest just need a direction, so the dial drops its
  // second handle rather than offering an arc that would do nothing.
  const sweeps = shown.shotType === 'pan' || shown.shotType === 'orbit';
  const magnitude = MAGNITUDE[shown.shotType];

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <strong style={{ fontSize: 13 }}>Waypoint {index + 1}</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>of {total}</span>
        <div style={{ flex: 1 }} />
        {onReorder && (
          <>
            <button title="Move earlier" disabled={index === 0} onClick={() => onReorder(-1)}
                    style={{ padding: '2px 8px' }}>↑</button>
            <button title="Move later" disabled={index === total - 1} onClick={() => onReorder(1)}
                    style={{ padding: '2px 8px' }}>↓</button>
          </>
        )}
        {onClose && <button onClick={onClose} style={{ padding: '2px 8px' }}>✕</button>}
      </div>

      {/* ---- who decides ---- */}
      <div style={row}>
        <div style={labelStyle}><span>Shot</span></div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={!manual ? 'primary' : undefined}
            onClick={() => onChange({ mode: 'auto' })}
            style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
          >
            Auto
          </button>
          <button
            className={manual ? 'primary' : undefined}
            // Seed the manual values from what auto just chose, so switching
            // starts from the shot on screen instead of a stale default.
            onClick={() =>
              onChange({
                mode: 'manual',
                shotType: preview.shotType,
                duration: Number(preview.duration.toFixed(1)),
              })
            }
            style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
          >
            Manual
          </button>
        </div>
      </div>

      {/* ---- what will actually happen ---- */}
      <div
        style={{
          ...row,
          background: 'var(--panel-2)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '8px 10px',
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div title={shown.reason} style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ color: 'var(--accent)' }}>{shown.shotType}</strong>
            <span style={{ color: 'var(--muted)' }}> for </span>
            <strong>{shown.duration.toFixed(1)}s</strong>
          </div>
          <span
            style={{ fontSize: 10, color: 'var(--muted)', flex: '0 0 auto' }}
            title={
              generated
                ? 'From the generated path — measured against the walls.'
                : 'Not in a generated path yet — generate to find out what the camera can actually do here.'
            }
          >
            {generated ? 'generated' : 'preview'}
          </span>
        </div>

        {generated && clipped && (
          <div
            style={{ marginTop: 5, fontSize: 11, color: 'var(--warn)' }}
            title={clipped.message}
          >
            {replaced
              ? `${askedFor} clips a wall — ${shown.shotType} instead`
              : 'tightened to clear the walls'}
          </div>
        )}
      </div>

      {/* ---- manual parameters, shown only when they apply ---- */}
      {manual && (
        <>
          <div style={row}>
            <div style={labelStyle}>
              <span>Type</span>
              <span style={{ fontSize: 10 }}>auto would pick {preview.autoShotType}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
              {SHOT_TYPES.map((shot: ShotType) => (
                <button
                  key={shot}
                  onClick={() => onChange({ shotType: shot })}
                  className={waypoint.shotType === shot ? 'primary' : undefined}
                  style={{ padding: '5px 4px', fontSize: 11 }}
                >
                  {shot}
                </button>
              ))}
            </div>
          </div>

          <div style={row}>
            <div style={labelStyle}>
              <span>Duration</span>
              <span style={{ color: 'var(--text)' }}>{waypoint.duration.toFixed(1)}s</span>
            </div>
            <input
              type="range" min={0.5} max={15} step={0.1}
              value={waypoint.duration}
              onChange={(e) => onChange({ duration: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {/* ---- where the shot points ---- */}
      <div style={row}>
        <div style={labelStyle}>
          <span>{sweeps ? 'Sweep' : 'Facing'}</span>
          <span style={{ fontSize: 10 }}>{preview.aimExplicit ? 'set by you' : 'auto'}</span>
        </div>
        <AimDial
          aim={preview.aim}
          sweeps={sweeps}
          explicit={preview.aimExplicit}
          onChange={(aim) => onChange({ aim })}
          onReset={() => onChange({ aim: null })}
        />
      </div>

      {/* ---- amplitude, named for what this shot actually scales ---- */}
      {magnitude.showMagnitude && (
        <div style={row}>
          <div style={labelStyle}>
            <span title={`${magnitude.label} of this ${shown.shotType}, as a share of the style's own.`}>
              {magnitude.label}
            </span>
            <span style={{ color: 'var(--text)' }}>
              {Math.round(waypoint.emphasis * 100)}%
              {Math.abs(waypoint.emphasis - 1) < 0.01 ? ' (style default)' : ''}
            </span>
          </div>
          <input
            type="range"
            min={EMPHASIS_RANGE.min}
            max={EMPHASIS_RANGE.max}
            step={EMPHASIS_RANGE.step}
            value={waypoint.emphasis}
            onChange={(e) => onChange({ emphasis: Number(e.target.value) })}
          />
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
        at ({waypoint.position[0].toFixed(2)}, {waypoint.position[2].toFixed(2)})
        {grid ? ` · ${preview.wallDistance.toFixed(1)} m from the nearest wall` : ''}
        {waypoint.pinned ? ' · edited' : ''}
      </div>

      {footer}

      {onRemove && (
        <button onClick={onRemove} style={{ width: '100%', color: 'var(--danger)' }}>
          Delete waypoint
        </button>
      )}
    </div>
  );
}

/**
 * The generator's own account of one waypoint's shot, ready for the two props
 * above. Both screens feed the panel through this, so neither has to know how
 * a clipped shot is reported.
 *
 * `current` is false once the plan has been edited since generating: the shot
 * in `path` then describes a plan that no longer exists, and reporting it as
 * what the camera will do would be the same lie in the other direction.
 */
export function generatedShotFor(
  path: PathResult | null,
  waypointId: string | null,
  current: boolean,
): { intent: ShotIntent | null; clipped: PathWarning | null } {
  if (!path || !waypointId || !current) return { intent: null, clipped: null };
  const intent = path.shots.find((s) => s.waypointId === waypointId) ?? null;
  if (!intent) return { intent: null, clipped: null };
  const clipped =
    path.warnings.find(
      (w) => w.code === 'shot-clipped' && w.waypointIds.includes(waypointId),
    ) ?? null;
  return { intent, clipped };
}
