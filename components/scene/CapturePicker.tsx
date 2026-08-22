'use client';

/**
 * Switch between captures.
 *
 * Changing capture also clears the plan: waypoints are world coordinates in the
 * old room, and carrying them into a different one would place them at
 * meaningless spots (or inside walls) rather than obviously failing.
 */

import { ASSET_SETS } from '@/lib/assets';
import { useRoomAssets } from '@/lib/scene';
import { usePlanStore } from '@/lib/plan/planStore';

export function CapturePicker() {
  const assets = useRoomAssets();
  const clearWaypoints = usePlanStore((s) => s.clearWaypoints);
  const waypointCount = usePlanStore((s) => s.waypoints.length);

  const sets = Object.values(ASSET_SETS);
  const active = assets.assetSet;

  return (
    <div>
      <div style={{ display: 'grid', gap: 4 }}>
        {sets.map((set) => (
          <button
            key={set.id}
            className={set.id === active.id ? 'primary' : undefined}
            onClick={() => {
              if (set.id === active.id) return;
              clearWaypoints();
              assets.switchAssetSet(set.id);
            }}
            style={{ textAlign: 'left', padding: '7px 9px' }}
          >
            <div style={{ fontSize: 12 }}>{set.label}</div>
            <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.35 }}>
              {set.approxSplats ? `${(set.approxSplats / 1e6).toFixed(2)}M splats · ` : ''}
              {set.description}
            </div>
          </button>
        ))}
      </div>
      {waypointCount > 0 && (
        <div style={{ fontSize: 10, color: 'var(--warn)', marginTop: 6 }}>
          Switching clears {waypointCount} waypoint{waypointCount === 1 ? '' : 's'}.
        </div>
      )}
    </div>
  );
}
