'use client';

/**
 * Switch between captures.
 *
 * Changing capture also clears the plan: waypoints are world coordinates in the
 * old room, and carrying them into a different one would place them at
 * meaningless spots (or inside walls) rather than obviously failing.
 *
 * Which makes this the most destructive control on the screen sitting behind
 * its most exploratory click - "what is Hobbiton?" used to delete the plan
 * outright, with a 10px line of small print as the only warning. So the switch
 * is now two steps, and the second step throws away the whole plan rather than
 * half of it: comments are anchored to the same dead coordinates as the
 * waypoints and have to go with them.
 */

import { useEffect, useState } from 'react';
import { ASSET_SETS, type AssetSet } from '@/lib/assets';
import { useRoomAssets } from '@/lib/scene';
import { usePlanStore } from '@/lib/plan/planStore';

/** Module scope: ASSET_SETS is a constant, and a fresh array every render
 *  would restart the availability probe on every render. */
const SETS: readonly AssetSet[] = Object.values(ASSET_SETS);

type Availability = 'unknown' | 'present' | 'missing';

/** Memoised per capture: whether the files are there is a page-load fact. */
const probes = new Map<string, Promise<Availability>>();

/**
 * Is this capture actually on disk?
 *
 * Some captures are derived from local source data and are gitignored, so on a
 * fresh clone their URLs 404 - and switching into one lands you in an empty
 * room with your plan already discarded. One HEAD on the collider settles it:
 * it is the asset placement and pathfinding cannot work without, and it sits in
 * the same directory as the splat, so one request covers the capture.
 *
 * Only an outright 404 counts as missing. Anything else - offline, a proxy that
 * dislikes HEAD - is unknown, and unknown stays clickable, because hiding a
 * capture that is really there is a worse failure than the one being prevented.
 */
function probeCapture(set: AssetSet): Promise<Availability> {
  let probe = probes.get(set.id);
  if (!probe) {
    probe = fetch(set.collider, { method: 'HEAD' })
      .then<Availability>((res) =>
        res.ok ? 'present' : res.status === 404 ? 'missing' : 'unknown',
      )
      .catch<Availability>(() => 'unknown');
    probes.set(set.id, probe);
  }
  return probe;
}

export function CapturePicker() {
  const assets = useRoomAssets();
  const resetPlan = usePlanStore((s) => s.resetPlan);
  const waypointCount = usePlanStore((s) => s.waypoints.length);
  const commentCount = usePlanStore((s) => s.comments.length);

  const [availability, setAvailability] = useState<Record<string, Availability>>({});
  /** The capture the user has asked for but not yet confirmed. */
  const [pendingId, setPendingId] = useState<string | null>(null);

  const active = assets.assetSet;
  const pending = pendingId ? (ASSET_SETS[pendingId] ?? null) : null;
  const atRisk = waypointCount + commentCount > 0;

  useEffect(() => {
    let live = true;
    for (const set of SETS) {
      void probeCapture(set).then((state) => {
        if (!live) return;
        setAvailability((prev) => (prev[set.id] === state ? prev : { ...prev, [set.id]: state }));
      });
    }
    return () => {
      live = false;
    };
  }, []);

  const applySwitch = (id: string) => {
    setPendingId(null);
    resetPlan();
    assets.switchAssetSet(id);
  };

  const requestSwitch = (id: string) => {
    if (id === active.id) return;
    if (availability[id] === 'missing') return;
    // Nothing to lose, nothing to ask about.
    if (!atRisk) {
      applySwitch(id);
      return;
    }
    setPendingId(id);
  };

  return (
    <div>
      <div style={{ display: 'grid', gap: 4 }}>
        {SETS.map((set) => {
          const missing = availability[set.id] === 'missing';
          const isActive = set.id === active.id;
          return (
            <button
              key={set.id}
              className={isActive ? 'primary' : undefined}
              disabled={missing}
              onClick={() => requestSwitch(set.id)}
              title={missing ? `${set.collider} is not on this machine` : undefined}
              style={{
                textAlign: 'left',
                padding: '7px 9px',
                borderColor: set.id === pendingId ? 'var(--warn)' : undefined,
              }}
            >
              <div style={{ fontSize: 12 }}>{set.label}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.35 }}>
                {missing ? (
                  <span style={{ color: 'var(--warn)' }}>
                    assets not found — this capture is not in the repo
                  </span>
                ) : (
                  <>
                    {set.approxSplats ? `${(set.approxSplats / 1e6).toFixed(2)}M splats · ` : ''}
                    {set.description}
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {pending && (
        <div
          style={{
            marginTop: 8,
            border: '1px solid var(--warn)',
            borderRadius: 'var(--radius)',
            background: 'var(--panel)',
            padding: '8px 10px',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--warn)', lineHeight: 1.45, marginBottom: 8 }}>
            Switch to {pending.label}? This deletes {describeLosses(waypointCount, commentCount)}{' '}
            — they are positions in {active.label} and mean nothing in another capture. There is no
            undo.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => applySwitch(pending.id)}
              style={{ flex: 1, fontSize: 12, color: 'var(--danger)' }}
            >
              Discard and switch
            </button>
            <button
              className="primary"
              onClick={() => setPendingId(null)}
              style={{ flex: 1, fontSize: 12 }}
            >
              Keep my plan
            </button>
          </div>
        </div>
      )}

      {active.qualities && active.qualities.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>
            Splat density
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {active.qualities.map((q) => (
              <button
                key={q.id}
                className={q.id === assets.qualityId ? 'primary' : undefined}
                onClick={() => assets.switchQuality(q.id)}
                title={`${(q.approxSplats / 1e6).toFixed(0)}M splats · ` +
                       `${(q.approxBytes / 1e6).toFixed(0)} MB` +
                       (q.note ? ` · ${q.note}` : '')}
                style={{ flex: 1, padding: '4px 6px', fontSize: 11 }}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, lineHeight: 1.35 }}>
            {(() => {
              const q = active.qualities.find((x) => x.id === assets.qualityId);
              if (!q) return null;
              return `${(q.approxSplats / 1e6).toFixed(0)}M splats · ` +
                     `${(q.approxBytes / 1e6).toFixed(0)} MB` + (q.note ? ` · ${q.note}` : '');
            })()}
          </div>
        </div>
      )}

      {atRisk && !pending && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6, lineHeight: 1.35 }}>
          Switching capture discards {describeLosses(waypointCount, commentCount)}. You will be
          asked first.
        </div>
      )}
    </div>
  );
}

function describeLosses(waypoints: number, comments: number): string {
  const parts: string[] = [];
  if (waypoints > 0) parts.push(`${waypoints} waypoint${waypoints === 1 ? '' : 's'}`);
  if (comments > 0) parts.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  return parts.join(' and ');
}
