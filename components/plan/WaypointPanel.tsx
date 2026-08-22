'use client';

/**
 * The per-waypoint technique panel.
 *
 * The controlSpectrum slider is the spine of it. At the Auto end the shot type
 * and duration controls are disabled, because at that end they genuinely have
 * no effect - the generator infers both. Showing them live but inert would
 * imply the user's pick matters when it does not, so they grey out and the
 * panel says what auto chose and why instead.
 *
 * Everything is recomputed live through resolveShot as the slider moves, so the
 * blend is visible before committing to a regenerate.
 *
 * Screen-agnostic on purpose: the review screen reopens this same panel from
 * its technique label.
 */

import { SHOT_TYPES, type PathStyle, type ShotType, type Waypoint } from '@/lib/types';
import { resolveShot, type ShotObject } from '@/lib/path';

export type WaypointPanelProps = {
  waypoint: Waypoint;
  index: number;
  total: number;
  objects: readonly ShotObject[];
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
  waypoint, index, total, objects, style,
  onChange, onRemove, onReorder, onClose, footer,
}: WaypointPanelProps) {
  const intent = resolveShot(waypoint, objects, style);
  const spectrum = waypoint.controlSpectrum;
  // Past the Auto end: the manual controls start doing something.
  const manualActive = spectrum > 0;

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

      {/* ---- the spectrum ---- */}
      <div style={row}>
        <div style={labelStyle}>
          <span>Control</span>
          <span style={{ color: 'var(--text)' }}>
            {spectrum <= 0 ? 'Auto' : spectrum >= 1 ? 'Manual' : `${Math.round(spectrum * 100)}% manual`}
          </span>
        </div>
        <input
          type="range" min={0} max={1} step={0.01} value={spectrum}
          onChange={(e) => onChange({ controlSpectrum: Number(e.target.value) })}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)' }}>
          <span>Auto</span><span>Manual</span>
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
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--muted)' }}>Resolves to </span>
          <strong style={{ color: 'var(--accent)' }}>{intent.shotType}</strong>
          <span style={{ color: 'var(--muted)' }}> for </span>
          <strong>{intent.duration.toFixed(1)}s</strong>
          <span style={{ color: 'var(--muted)' }}> at {Math.round(intent.intensity * 100)}% intensity</span>
        </div>
        <div style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{intent.reason}</div>
      </div>

      {/* ---- manual controls ---- */}
      <div style={{ ...row, opacity: manualActive ? 1 : 0.45 }}>
        <div style={labelStyle}>
          <span>Shot type</span>
          {!manualActive && <span style={{ fontSize: 10 }}>move off Auto to use</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          {SHOT_TYPES.map((s: ShotType) => (
            <button
              key={s}
              disabled={!manualActive}
              onClick={() => onChange({ shotType: s })}
              className={waypoint.shotType === s ? 'primary' : undefined}
              style={{ padding: '5px 4px', fontSize: 11 }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...row, opacity: manualActive ? 1 : 0.45 }}>
        <div style={labelStyle}>
          <span>Duration</span>
          <span style={{ color: 'var(--text)' }}>{waypoint.duration.toFixed(1)}s</span>
        </div>
        <input
          type="range" min={0.5} max={15} step={0.1}
          value={waypoint.duration}
          disabled={!manualActive}
          onChange={(e) => onChange({ duration: Number(e.target.value) })}
        />
      </div>

      {/* ---- framing target ---- */}
      <div style={row}>
        <div style={labelStyle}><span>Framing</span></div>
        <select
          value={waypoint.targetObjectId ?? ''}
          onChange={(e) => onChange({ targetObjectId: e.target.value || null })}
        >
          <option value="">
            Auto{intent.targetObjectId ? ` — nearest is ${intent.targetObjectId}` : ' — nothing nearby'}
          </option>
          {objects.map((o) => (
            <option key={o.id} value={o.id}>{o.label ?? o.id}</option>
          ))}
        </select>
      </div>

      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
        at ({waypoint.position[0].toFixed(2)}, {waypoint.position[2].toFixed(2)})
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
