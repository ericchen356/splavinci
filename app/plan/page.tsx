'use client';

/**
 * The dual-view placement screen: a full 3D viewport with a mini-map in the
 * corner.
 *
 * Both views are projections of ONE waypoint list in the plan store. A click in
 * either drops into the same array and both re-render from it, so they cannot
 * disagree - there is no sync step because there is nothing to sync.
 *
 * Pathfinding is not implemented here. This screen collects intent and calls
 * into lib/path, then draws whatever comes back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import Link from 'next/link';
import {
  CameraPresetDriver,
  CameraRig,
  CameraTracker,
  CapturePicker,
  RoomScene,
  derivePresets,
  isDrag,
  type CameraMode,
  type CameraPose,
} from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { PlanOverlay } from '@/components/plan/PlanOverlay';
import { WaypointPanel } from '@/components/plan/WaypointPanel';
import { useRoomAssets } from '@/lib/scene';
import { getWalkGrid } from '@/lib/path';
import { usePlanStore } from '@/lib/plan/planStore';
import { PATH_STYLES, type PathStyle, type Vec3 } from '@/lib/types';

const STYLE_BLURB: Record<PathStyle, string> = {
  cozy: 'slow, lingering',
  realEstate: 'brisk and even',
  cinematic: 'slowest, biggest moves',
  quick: 'fast tour, short shots',
};

export default function PlanPage() {
  const assets = useRoomAssets();
  const {
    waypoints, selectedId, settings, path, generating, dirty,
    addWaypoint, updateWaypoint, removeWaypoint, reorderWaypoint,
    clearWaypoints, select, setStyle, generate,
  } = usePlanStore();

  const [mode, setMode] = useState<CameraMode>('orbit');
  const [presetId, setPresetId] = useState('interior');
  const [presetNonce, setPresetNonce] = useState(0);
  const [pose, setPose] = useState<CameraPose | null>(null);

  const grid = useMemo(
    () => (assets.colliderData ? getWalkGrid(assets.colliderData) : null),
    [assets.colliderData],
  );
  const selected = waypoints.find((w) => w.id === selectedId) ?? null;
  const selectedIndex = waypoints.findIndex((w) => w.id === selectedId);

  // Framed from the collider's own extents: values tuned to the sample flat
  // bury the camera in the terrain of a 30 x 37 m outdoor capture.
  const presets = useMemo(
    () => derivePresets(assets.roomBounds, assets.floor.baseY),
    [assets.roomBounds, assets.floor],
  );
  const preset = presets.find((p) => p.id === presetId) ?? presets[0];

  // The <Canvas> camera prop is read once, at mount, while the collider is
  // still loading - so re-frame when it lands or the capture changes.
  useEffect(() => {
    if (assets.roomBounds) setPresetNonce((n) => n + 1);
  }, [assets.roomBounds, assets.assetSetId]);

  // A 3 m/s walk suits a flat; crossing a 37 m capture at it does not.
  const flySpeed = useMemo(() => {
    const b = assets.roomBounds;
    if (!b) return 3.2;
    return Math.max(3.2, Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.15);
  }, [assets.roomBounds]);

  /* Both entry points funnel into the same action. The only difference is where
     y comes from: a 3D click already has a surface, a mini-map click does not. */
  const dropAt3D = useCallback(
    (point: Vec3, event: ThreeEvent<MouseEvent>) => {
      // Looking around in fly mode - or orbiting - would otherwise drop a
      // waypoint wherever the drag happened to end.
      if (isDrag(event)) return;
      addWaypoint(point);
    },
    [addWaypoint],
  );

  const dropAtMap = useCallback(
    (x: number, z: number) => {
      addWaypoint([x, assets.floorYAtOr(x, z), z]);
    },
    [addWaypoint, assets],
  );

  const onGenerate = useCallback(() => {
    generate(assets.colliderData);
  }, [generate, assets.colliderData]);

  const errors = path?.warnings.filter((w) => w.severity === 'error') ?? [];
  const notices = path?.warnings.filter((w) => w.severity !== 'error') ?? [];

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* ---------------- 3D viewport ---------------- */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <Canvas camera={{ position: preset.position, fov: 55, near: 0.05, far: 2000 }}>
          <CameraRig mode={mode} target={preset.target} moveSpeed={flySpeed} />
          <CameraPresetDriver preset={preset} nonce={presetNonce} />
          <CameraTracker onChange={setPose} />
          <RoomScene onFloorClick={dropAt3D}>
            <PlanOverlay
              waypoints={waypoints}
              selectedId={selectedId}
              polyline={path?.polyline ?? []}
              onSelect={select}
            />
          </RoomScene>
        </Canvas>

        {/* mini-map, in the corner, over the viewport */}
        <div style={{ position: 'absolute', left: 12, bottom: 12, width: 300 }}>
          <MiniMap
            grid={grid}
            waypoints={waypoints}
            selectedId={selectedId}
            polyline={path?.polyline ?? []}
            camera={pose}
            onPick={dropAtMap}
            onWaypointPick={select}
            height={230}
            title="Top-down"
            hint="click to place · click a marker to edit"
          />
        </div>

        {!assets.settled && (
          <div style={overlayBadge}>
            Loading room… {Math.round(assets.progress * 100)}%
          </div>
        )}
        {assets.settled && !assets.colliderData && (
          <div style={{ ...overlayBadge, color: 'var(--danger)' }}>
            No collider loaded — placement and pathfinding are unavailable.
          </div>
        )}
      </div>

      {/* ---------------- sidebar ---------------- */}
      <aside
        style={{
          width: 340, flex: '0 0 340px', borderLeft: '1px solid var(--line)',
          background: 'var(--bg)', overflowY: 'auto', padding: 14,
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={sectionLabel}>Capture</div>
          <CapturePicker />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={sectionLabel}>Camera</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {CAMERA_MODES.map((m) => (
              <button
                key={m.value}
                className={mode === m.value ? 'primary' : undefined}
                onClick={() => setMode(m.value)}
                style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {presets.map((p) => (
              <button
                key={p.id}
                className={p.id === preset.id ? 'primary' : undefined}
                onClick={() => { setPresetId(p.id); setPresetNonce((n) => n + 1); }}
                style={{ fontSize: 12, padding: '4px 8px' }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p style={{ margin: '7px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
            {mode === 'orbit'
              ? 'Drag to orbit · scroll to dolly · right-drag to pan.'
              : 'Drag to look · WASD to move · Q/E down/up · Shift to sprint.'}
            {' '}Click the floor without dragging to drop a waypoint.
          </p>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={sectionLabel}>Style</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {PATH_STYLES.map((s) => (
              <button
                key={s}
                className={settings.style === s ? 'primary' : undefined}
                onClick={() => setStyle(s)}
                style={{ textAlign: 'left', padding: '7px 9px' }}
                title={STYLE_BLURB[s]}
              >
                <div style={{ fontSize: 12 }}>{s}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>{STYLE_BLURB[s]}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button
            className="primary"
            style={{ flex: 1 }}
            disabled={generating || waypoints.length < 1 || !assets.colliderData}
            onClick={onGenerate}
          >
            {generating ? 'Generating…' : 'Generate path'}
          </button>
          <button onClick={clearWaypoints} disabled={waypoints.length === 0}>Clear</button>
        </div>

        {path && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 14 }}>
            {path.frames.length} frames · {path.duration.toFixed(1)}s ·{' '}
            {path.stats.recomputedSegments} rebuilt / {path.stats.reusedSegments} reused ·{' '}
            {path.stats.generateMs}ms
            {dirty && <span style={{ color: 'var(--warn)' }}> · edited since generating</span>}
            <div style={{ marginTop: 6 }}>
              <Link href="/review">Open in review →</Link>
            </div>
          </div>
        )}

        {errors.map((w, i) => (
          <div key={`e${i}`} style={{ ...noticeBox, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
            {w.message}
          </div>
        ))}
        {notices.map((w, i) => (
          <div key={`n${i}`} style={{ ...noticeBox, borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            {w.message}
          </div>
        ))}

        {selected ? (
          <WaypointPanel
            waypoint={selected}
            index={selectedIndex}
            total={waypoints.length}
            grid={grid}
            style={settings.style}
            onChange={(patch) => updateWaypoint(selected.id, patch)}
            onRemove={() => removeWaypoint(selected.id)}
            onReorder={(d) => reorderWaypoint(selected.id, d)}
            onClose={() => select(null)}
          />
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <div style={sectionLabel}>Waypoints ({waypoints.length})</div>
            {waypoints.length === 0
              ? 'Click the floor in 3D, or anywhere on the mini-map, to drop a waypoint.'
              : 'Select a waypoint to set its shot.'}
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
              {waypoints.map((w, i) => {
                const shot = path?.shots.find((s) => s.waypointId === w.id);
                return (
                  <li key={w.id}>
                    <button
                      onClick={() => select(w.id)}
                      style={{ width: '100%', textAlign: 'left', marginBottom: 4, padding: '6px 9px' }}
                    >
                      <strong>{i + 1}.</strong>{' '}
                      {shot ? `${shot.shotType} · ${shot.duration.toFixed(1)}s` : 'not generated'}
                      <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                        {' '}({w.position[0].toFixed(1)}, {w.position[2].toFixed(1)})
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

const CAMERA_MODES: readonly { value: CameraMode; label: string }[] = [
  { value: 'orbit', label: 'Orbit' },
  { value: 'fly', label: 'Fly' },
];

const sectionLabel: React.CSSProperties = {
  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--muted)', marginBottom: 6,
};

const noticeBox: React.CSSProperties = {
  border: '1px solid', borderRadius: 6, padding: '7px 9px',
  fontSize: 11, marginBottom: 6, lineHeight: 1.45,
};

const overlayBadge: React.CSSProperties = {
  position: 'absolute', top: 12, left: 12,
  background: 'var(--panel)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius)', padding: '6px 10px', fontSize: 12,
};
