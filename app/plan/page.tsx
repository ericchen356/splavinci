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
  CAMERA_BODY_RADIUS,
  CameraPresetDriver,
  CameraRig,
  CameraTracker,
  CapturePicker,
  RoomScene,
  derivePresets,
  isDrag,
  type CameraPose,
} from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { PlanOverlay } from '@/components/plan/PlanOverlay';
import { WaypointPanel } from '@/components/plan/WaypointPanel';
import { shotPreviewPoints } from '@/components/plan/shotPreview';
import { useRoomAssets } from '@/lib/scene';
import {
  cellIndex,
  cellToWorld,
  findNearestCell,
  getWalkGrid,
  reachableMask,
  resolveCameraRadius,
  worldToCell,
} from '@/lib/path';
import { usePlanStore } from '@/lib/plan/planStore';
import { PATH_STYLES, type PathStyle, type Vec3 } from '@/lib/types';

const STYLE_BLURB: Record<PathStyle, string> = {
  cozy: 'slow, lingering',
  realEstate: 'brisk and even',
  cinematic: 'slowest, biggest moves',
  quick: 'fast tour, short shots',
};

export default function PlanPage() {
  const [showSplat, setShowSplat] = useState(true);
  const assets = useRoomAssets();
  const {
    waypoints, selectedId, settings, path, generating, generateError, dirty,
    addWaypoint, moveWaypoint, updateWaypoint, removeWaypoint, reorderWaypoint,
    clearWaypoints, select, setStyle, generate,
  } = usePlanStore();

  const [presetId, setPresetId] = useState('interior');
  const [presetNonce, setPresetNonce] = useState(0);
  const [pose, setPose] = useState<CameraPose | null>(null);

  const grid = useMemo(
    () => (assets.colliderData ? getWalkGrid(assets.colliderData) : null),
    [assets.colliderData],
  );
  const selected = waypoints.find((w) => w.id === selectedId) ?? null;
  const selectedIndex = waypoints.findIndex((w) => w.id === selectedId);

  // Framed from the capture's own walkable space: values tuned to the sample
  // flat bury the camera in the terrain of a 30 x 37 m outdoor capture, and the
  // collider's raw extents are mostly empty margin around the real content.
  const presets = useMemo(
    () => derivePresets(assets.roomBounds, assets.floor.baseY, grid),
    [assets.roomBounds, assets.floor, grid],
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

  /* The camera's effective clearance, and the space it can actually reach at
     that clearance. Both the map and waypoint placement need it: a waypoint
     dropped in a pocket the camera cannot enter is not a plan, it is an error
     message waiting to happen. */
  const camera = useMemo(() => {
    if (!grid) return null;
    const resolved = resolveCameraRadius(grid, CAMERA_BODY_RADIUS);
    return { ...resolved, reach: reachableMask(grid, resolved.radius) };
  }, [grid]);

  /* Pull a point into reachable space rather than refusing the click.
     Refusing gives the user nothing to act on - the gap that cut the pocket off
     is often a few centimetres and invisible at map scale - whereas landing on
     the nearest spot the camera can occupy is almost always what was meant. */
  const snapToReachable = useCallback(
    (x: number, z: number): { x: number; z: number; moved: boolean } => {
      if (!grid || !camera) return { x, z, moved: false };
      const { col, row } = worldToCell(grid, x, z);
      if (camera.reach.mask[cellIndex(grid, col, row)]) return { x, z, moved: false };
      const near = findNearestCell(grid, col, row, (c, r) =>
        camera.reach.mask[cellIndex(grid, c, r)] === 1);
      if (!near) return { x, z, moved: false };
      const w = cellToWorld(grid, near.col, near.row);
      return { x: w.x, z: w.z, moved: true };
    },
    [grid, camera],
  );

  /* Both entry points funnel into the same action. The only difference is where
     y comes from: a 3D click already has a surface, a mini-map click does not. */
  const dropAt3D = useCallback(
    (point: Vec3, event: ThreeEvent<MouseEvent>) => {
      // Looking around would otherwise drop a waypoint wherever the drag
      // happened to end.
      if (isDrag(event)) return;
      const snapped = snapToReachable(point[0], point[2]);
      addWaypoint([snapped.x, assets.floorYAtOr(snapped.x, snapped.z), snapped.z]);
    },
    [addWaypoint, assets, snapToReachable],
  );

  const dropAtMap = useCallback(
    (x: number, z: number) => {
      const snapped = snapToReachable(x, z);
      addWaypoint([snapped.x, assets.floorYAtOr(snapped.x, snapped.z), snapped.z]);
    },
    [addWaypoint, assets, snapToReachable],
  );

  /* Dragging a marker keeps its id, and with it its mode, duration, emphasis
     and place in the running order - all of which delete-and-replace threw
     away. moveWaypoint pins it, so the generator rebuilds the two legs either
     side and serves the rest of the table from cache. */
  const dragOnMap = useCallback(
    (id: string, x: number, z: number) => {
      moveWaypoint(id, [x, assets.floorYAtOr(x, z), z]);
    },
    [moveWaypoint, assets],
  );

  const onGenerate = useCallback(() => {
    void generate(assets.colliderData);
  }, [generate, assets.colliderData]);

  /* The selected waypoint's shot, resolved and sampled without generating, so
     the emphasis slider has something to move. Cheap enough to redo per tick:
     no A*, no curve, 24 samples. */
  const shotPreview = useMemo(
    () => (selectedIndex >= 0 ? shotPreviewPoints(waypoints, selectedIndex, grid, settings.style) : []),
    [waypoints, selectedIndex, grid, settings.style],
  );

  const errors = path?.warnings.filter((w) => w.severity === 'error') ?? [];
  const notices = path?.warnings.filter((w) => w.severity !== 'error') ?? [];

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* ---------------- 3D viewport ---------------- */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <Canvas camera={{ position: preset.position, fov: 55, near: 0.05, far: 2000 }}>
          <CameraRig moveSpeed={flySpeed} />
          <CameraPresetDriver preset={preset} nonce={presetNonce} />
          <CameraTracker onChange={setPose} />
          <RoomScene onFloorClick={dropAt3D} showSplat={showSplat}>
            <PlanOverlay
              waypoints={waypoints}
              selectedId={selectedId}
              polyline={path?.polyline ?? []}
              shotPreview={shotPreview}
              onSelect={select}
            />
          </RoomScene>
        </Canvas>

        {/* mini-map, in the corner, over the viewport */}
        <div style={{ position: 'absolute', left: 12, bottom: 12, width: 300 }}>
          <MiniMap
            grid={grid}
            cameraRadius={camera?.radius}
            waypoints={waypoints}
            selectedId={selectedId}
            polyline={path?.polyline ?? []}
            shotPreview={shotPreview}
            camera={pose}
            onPick={dropAtMap}
            onWaypointPick={select}
            onWaypointDrag={dragOnMap}
            height={230}
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
          <div style={sectionLabel}>Layers</div>
          <LayerToggle label="Splat cloud" checked={showSplat} onChange={setShowSplat} />
          <LayerToggle
            label="Collider wireframe"
            checked={assets.showCollider}
            onChange={assets.setShowCollider}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={sectionLabel}>Camera</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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

        {generateError && (
          <div style={{ ...noticeBox, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
            Generating failed: {generateError}
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

        {/* Panel AND list. The list used to be the else-branch of the panel,
            and placing a waypoint selects it, so the running order was hidden
            for the whole time anyone was building one. */}
        {selected && (
          <div style={{ marginBottom: 14 }}>
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
          </div>
        )}

        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <div style={sectionLabel}>Waypoints ({waypoints.length})</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
            {waypoints.map((w, i) => {
              const shot = path?.shots.find((s) => s.waypointId === w.id);
              return (
                <li key={w.id}>
                  <button
                    className={w.id === selectedId ? 'primary' : undefined}
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
      </aside>
    </div>
  );
}

function LayerToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, padding: '3px 0', cursor: 'pointer',
      }}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

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
