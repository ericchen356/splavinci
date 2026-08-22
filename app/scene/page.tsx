'use client';

/**
 * /scene — load the room and look around it.
 *
 * The <Canvas> and the camera rig live HERE, not inside <RoomScene>, so /plan
 * and /review can mount the same room under a camera rig of their own.
 */

import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { RoomScene } from '@/components/scene/RoomScene';
import {
  CameraRig,
  CameraPresetDriver,
  CAMERA_PRESETS,
  type CameraMode,
  type CameraPreset,
} from '@/components/scene/CameraRig';
import { AssetStatusPanel } from '@/components/scene/AssetStatusPanel';
import { useRoomAssets } from '@/lib/scene/useRoomAssets';
import type { Vec3 } from '@/lib/types';

const INITIAL_PRESET = CAMERA_PRESETS[0];

export default function ScenePage() {
  const assets = useRoomAssets();

  const [mode, setMode] = useState<CameraMode>('orbit');
  const [preset, setPreset] = useState<CameraPreset>(INITIAL_PRESET);
  const [presetNonce, setPresetNonce] = useState(0);
  const [showObjects, setShowObjects] = useState(true);
  const [showSplat, setShowSplat] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ point: Vec3; floorY: number | null } | null>(null);

  const orbitTarget = preset.target;

  const highlighted = useMemo(
    () => [hovered, selected].filter((x): x is string => Boolean(x)),
    [hovered, selected],
  );

  const applyPreset = (next: CameraPreset) => {
    setPreset(next);
    setPresetNonce((n) => n + 1);
  };

  const selectedObject = assets.getObject(selected);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <Canvas
        // Spark explicitly wants antialias off: MSAA does nothing useful for
        // Gaussian splats and costs a lot of fill rate.
        gl={{ antialias: false }}
        dpr={[1, 2]}
        camera={{ position: INITIAL_PRESET.position, fov: 60, near: 0.05, far: 300 }}
        style={{ background: 'var(--bg)' }}
      >
        <CameraRig mode={mode} target={orbitTarget} />
        <CameraPresetDriver preset={preset} nonce={presetNonce} />

        <RoomScene
          showSplat={showSplat}
          showObjects={showObjects}
          interactiveObjects
          highlightedObjectIds={highlighted}
          onObjectClick={(object) =>
            setSelected((current) => (current === object.spec.id ? null : object.spec.id))
          }
          onObjectHover={(object) => setHovered(object ? object.spec.id : null)}
          onFloorClick={(point) =>
            setProbe({ point, floorY: assets.floorYAt(point[0], point[2]) })
          }
        />
      </Canvas>

      {/* ------------------------------- overlays ------------------------------ */}

      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'grid',
          gap: 10,
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <AssetStatusPanel assets={assets} />
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          width: 244,
          display: 'grid',
          gap: 10,
        }}
      >
        <Panel title="Camera">
          <SegmentedControl
            value={mode}
            options={[
              { value: 'orbit', label: 'Orbit' },
              { value: 'fly', label: 'Fly' },
            ]}
            onChange={(next) => setMode(next as CameraMode)}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {CAMERA_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === preset.id ? 'primary' : undefined}
                style={{ fontSize: 12, padding: '4px 8px' }}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 11, lineHeight: 1.45 }}>
            {mode === 'orbit'
              ? 'Drag to orbit · scroll to dolly · right-drag to pan.'
              : 'Drag to look · WASD to move · Q/E down/up · Shift to sprint.'}
          </p>
        </Panel>

        <Panel title="Layers">
          <Checkbox label="Splat cloud" checked={showSplat} onChange={setShowSplat} />
          <Checkbox label="Object meshes" checked={showObjects} onChange={setShowObjects} />
          <Checkbox
            label="Collider wireframe"
            checked={assets.showCollider}
            onChange={assets.setShowCollider}
          />
        </Panel>

        <Panel title={`Objects (${assets.loadedObjects.length})`}>
          <div style={{ maxHeight: 240, overflowY: 'auto', margin: '0 -4px' }}>
            {assets.loadedObjects.map((object) => {
              const active = object.spec.id === selected;
              return (
                <button
                  key={object.spec.id}
                  type="button"
                  onMouseEnter={() => setHovered(object.spec.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => setSelected(active ? null : object.spec.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 12,
                    color: active ? 'var(--text)' : 'var(--muted)',
                  }}
                >
                  {object.spec.label}
                </button>
              );
            })}
            {assets.loadedObjects.length === 0 ? (
              <div style={{ padding: '4px 8px', color: 'var(--muted)', fontSize: 12 }}>
                {assets.objects.phase === 'failed' ? 'Failed to load.' : 'Loading…'}
              </div>
            ) : null}
          </div>
        </Panel>

        {selectedObject ? (
          <Panel title={selectedObject.spec.label}>
            <Row k="id" v={selectedObject.spec.id} />
            <Row k="centre" v={fmtVec(selectedObject.center)} />
            <Row k="size" v={fmtVec(selectedObject.size)} />
            <Row k="radius" v={selectedObject.radius.toFixed(2)} />
          </Panel>
        ) : null}

        <Panel title="Floor probe">
          {probe ? (
            <>
              <Row k="hit" v={fmtVec(probe.point)} />
              <Row
                k="floorYAt"
                v={probe.floorY === null ? 'no floor' : probe.floorY.toFixed(3)}
              />
            </>
          ) : (
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11, lineHeight: 1.45 }}>
              Click the floor to sample it. The same lookup —{' '}
              <code style={{ color: 'var(--accent)' }}>floorYAt(x, z)</code> — is what the plan
              screen uses to drop mini-map clicks onto the floor.
            </p>
          )}
          {assets.colliderData ? (
            <Row
              k="bounds"
              v={`x ${fmtRange(assets.colliderData.bounds.min.x, assets.colliderData.bounds.max.x)} · y ${fmtRange(
                assets.colliderData.bounds.min.y,
                assets.colliderData.bounds.max.y,
              )} · z ${fmtRange(assets.colliderData.bounds.min.z, assets.colliderData.bounds.max.z)}`}
            />
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------ small UI bits ------------------------------ */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'color-mix(in srgb, var(--panel) 88%, transparent)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: '10px 12px',
        backdropFilter: 'blur(6px)',
      }}
    >
      <h2
        style={{
          margin: '0 0 8px',
          fontSize: 11,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'primary' : undefined}
          style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Checkbox({
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
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        padding: '3px 0',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--accent)', width: 'auto' }}
      />
      <span style={{ color: checked ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
      <span style={{ color: 'var(--muted)', width: 58, flex: '0 0 auto' }}>{k}</span>
      <span style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  );
}

function fmtVec(v: Vec3): string {
  return `${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)}`;
}

function fmtRange(a: number, b: number): string {
  return `${a.toFixed(1)}–${b.toFixed(1)}`;
}
