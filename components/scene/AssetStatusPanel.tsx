'use client';

/**
 * Honest per-asset loading state. HTML overlay, not scene content — mount it
 * next to the <Canvas>, not inside it.
 */

import type { CSSProperties } from 'react';
import type { AssetPhase } from '@/lib/scene/assetTypes';
import type { RoomAssets } from '@/lib/scene/useRoomAssets';

export type AssetStatusPanelProps = {
  assets: RoomAssets;
  /** Collapse to a single line once everything has settled. Default true. */
  autoCollapse?: boolean;
  style?: CSSProperties;
};

const PHASE_COLOR: Record<AssetPhase, string> = {
  idle: 'var(--muted)',
  loading: 'var(--warn)',
  loaded: 'var(--accent)',
  failed: 'var(--danger)',
};

const PHASE_GLYPH: Record<AssetPhase, string> = {
  idle: '·',
  loading: '◐',
  loaded: '●',
  failed: '✕',
};

function pct(progress: number): string {
  if (progress < 0) return '…';
  return `${Math.round(progress * 100)}%`;
}

function fileName(url: string | null): string {
  if (!url) return '—';
  return url.slice(url.lastIndexOf('/') + 1);
}

export function AssetStatusPanel({ assets, autoCollapse = true, style }: AssetStatusPanelProps) {
  const { splat, collider } = assets;

  const rows: { key: string; label: string; phase: AssetPhase; detail: string }[] = [
    {
      key: 'splat',
      label: 'Splat',
      phase: splat.phase,
      detail:
        splat.phase === 'loaded'
          ? `${fileName(splat.url)} · ${splat.splatCount?.toLocaleString() ?? '?'} splats`
          : splat.phase === 'loading'
            ? splat.url
              ? `${fileName(splat.url)} · ${pct(splat.progress)}`
              : 'resolving source…'
            : splat.phase === 'failed'
              ? (splat.error ?? 'failed')
              : 'queued',
    },
    {
      key: 'collider',
      label: 'Collider',
      phase: collider.phase,
      detail:
        collider.phase === 'loaded' && collider.data
          ? `${collider.data.meshes.length} meshes · ${collider.data.triangleCount} tris`
          : collider.phase === 'loading'
            ? pct(collider.progress)
            : collider.phase === 'failed'
              ? (collider.error ?? 'failed')
              : 'queued',
    },
  ];

  const collapsed = autoCollapse && assets.settled && !assets.hasFailure;

  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: collapsed ? '6px 10px' : '10px 12px',
        minWidth: collapsed ? undefined : 260,
        backdropFilter: 'blur(6px)',
        fontSize: 12,
        ...style,
      }}
    >
      {collapsed ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          <span style={{ color: PHASE_COLOR.loaded }}>●</span>
          <span style={{ color: 'var(--muted)' }}>
            Room loaded · {fileName(splat.url)}
            {collider.data ? ` · ${collider.data.triangleCount} collider tris` : ''}
          </span>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Assets
            </strong>
            <span style={{ color: 'var(--muted)' }}>{pct(assets.progress)}</span>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((row) => (
              <div key={row.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: PHASE_COLOR[row.phase], width: 12 }}>
                  {PHASE_GLYPH[row.phase]}
                </span>
                <span style={{ width: 62, color: 'var(--ink)' }}>{row.label}</span>
                <span
                  style={{
                    color: row.phase === 'failed' ? 'var(--danger)' : 'var(--muted)',
                    flex: 1,
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {row.detail}
                </span>
              </div>
            ))}
          </div>

          {splat.usedFallback && splat.phase !== 'failed' ? (
            <div style={{ marginTop: 8, color: 'var(--warn)', lineHeight: 1.4 }}>
              room.spz not found — using the room.ply stand-in. Drop a real capture at
              public/sample-room/room.spz and it will be preferred automatically.
            </div>
          ) : null}

          {assets.hasFailure ? (
            <button
              type="button"
              onClick={assets.reload}
              style={{ marginTop: 10, width: '100%', fontSize: 12 }}
            >
              Retry
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
