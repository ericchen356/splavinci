'use client';

/**
 * The per-waypoint technique panel.
 *
 * Auto and Manual are a toggle, not two ends of a slider. Under a blend the
 * duration you typed was not the duration you got, and shot type snapped at
 * the midpoint of a control that looked continuous. Here the panel shows
 * exactly one resolved shot and it is exactly what the camera will do.
 *
 * Manual parameters are not rendered at all in auto mode rather than shown
 * disabled: a greyed-out control still implies the value matters, and in auto
 * mode it does not. Switching to Manual seeds them from whatever auto just
 * resolved, so control is taken over the shot on screen rather than a default.
 *
 * Move size applies in both modes, because scaling a shot is a matter of
 * degree even when you are happy to let the system pick the shot.
 *
 * Screen-agnostic on purpose: the review screen reopens this same panel from
 * its technique label.
 */

import { AimDial } from './AimDial';
import {
  EMPHASIS_RANGE,
  SHOT_TYPES,
  type PathStyle,
  type ShotType,
  type Waypoint,
} from '@/lib/types';
import { resolveShot, type WalkGrid } from '@/lib/path';

export type WaypointPanelProps = {
  waypoint: Waypoint;
  index: number;
  total: number;
  /** The walk grid the auto end reads the walls from. Null before it loads. */
  grid: WalkGrid | null;
  style: PathStyle;
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

export function WaypointPanel({
  waypoint, index, total, grid, style,
  onChange, onRemove, onReorder, onClose, footer,
}: WaypointPanelProps) {
  const intent = resolveShot(waypoint, grid, style);
  const manual = waypoint.mode === 'manual';
  // Only these swing; the rest just need a direction, so the dial drops its
  // second handle rather than offering an arc that would do nothing.
  const sweeps = intent.shotType === 'pan' || intent.shotType === 'orbit';

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
                shotType: intent.shotType,
                duration: Number(intent.duration.toFixed(1)),
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
        <div title={intent.reason}>
          <strong style={{ color: 'var(--accent)' }}>{intent.shotType}</strong>
          <span style={{ color: 'var(--muted)' }}> for </span>
          <strong>{intent.duration.toFixed(1)}s</strong>
        </div>

      </div>

      {/* ---- manual parameters, shown only when they apply ---- */}
      {manual && (
        <>
          <div style={row}>
            <div style={labelStyle}>
              <span>Type</span>
              <span style={{ fontSize: 10 }}>auto would pick {intent.autoShotType}</span>
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
          <span style={{ fontSize: 10 }}>{intent.aimExplicit ? 'set by you' : 'auto'}</span>
        </div>
        <AimDial
          aim={intent.aim}
          sweeps={sweeps}
          explicit={intent.aimExplicit}
          onChange={(aim) => onChange({ aim })}
          onReset={() => onChange({ aim: null })}
        />
      </div>

      {/* ---- emphasis: meaningful in both modes ---- */}
      <div style={row}>
        <div style={labelStyle}>
          <span title="How far the camera travels during the shot: the sweep of an orbit, the reach of a push-in.">
            Move size
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

      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
        at ({waypoint.position[0].toFixed(2)}, {waypoint.position[2].toFixed(2)})
        {grid ? ` · ${intent.wallDistance.toFixed(1)} m from the nearest wall` : ''}
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
