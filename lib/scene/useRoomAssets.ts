'use client';

/**
 * The loader hook every screen calls.
 *
 *   const room = useRoomAssets();
 *
 * Mounting it kicks off the (idempotent, module-singleton) load, so /plan and
 * /review get the already-parsed room for free after /scene has visited it.
 * The returned object is stable per state change — safe in dependency arrays.
 */

import { useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import type { SceneObject, Vec3 } from '@/lib/types';
import type { AssetSet } from '@/lib/assets';
import type { ColliderData } from './collider';
import type {
  ColliderState,
  LoadedObject,
  ObjectsState,
  SplatState,
} from './assetTypes';
import type { FloorSampler } from './floor';
import { useRoomStore } from './roomStore';

export type RoomAssets = {
  /* --- which capture is loaded --- */
  assetSetId: string;
  assetSet: AssetSet;
  switchAssetSet(id: string): void;

  /* --- raw per-asset state, for honest status UI --- */
  splat: SplatState;
  collider: ColliderState;
  objects: ObjectsState;

  /* --- the useful parsed payloads --- */
  /** Parsed collider: meshes, world-space triangle soup, bounds. Null until loaded. */
  colliderData: ColliderData | null;
  /** objects.json verbatim (available before the meshes finish downloading). */
  manifest: SceneObject[];
  /** Manifest entries whose mesh parsed, with bounds/centre/radius. */
  loadedObjects: LoadedObject[];
  /** Lookup by SceneObject.id. */
  getObject(id: string | null | undefined): LoadedObject | null;

  /* --- floor queries --- */
  /** Always present; `floor.ready` is false until the collider lands. */
  floor: FloorSampler;
  /** Shorthand for `floor.floorYAt`. Null when nothing is underfoot. */
  floorYAt(x: number, z: number): number | null;
  /** Shorthand for `floor.floorYAtOr` — never null. */
  floorYAtOr(x: number, z: number, fallbackY?: number): number;

  /* --- convenience --- */
  /** Collider AABB (room extents), or null before the collider loads. */
  roomBounds: THREE.Box3 | null;
  /** Room centre at floor level; a sensible default orbit target. */
  roomCenter: Vec3 | null;
  /** Every asset finished successfully. */
  ready: boolean;
  /** Every asset finished, successfully or not — the point to stop spinning. */
  settled: boolean;
  /** At least one asset failed. */
  hasFailure: boolean;
  /** 0..1 overall, for a single progress bar. */
  progress: number;

  /* --- collider debug toggle (shared across screens) --- */
  showCollider: boolean;
  setShowCollider(value: boolean): void;
  toggleCollider(): void;

  /** Throw everything away and load again. */
  reload(): void;
};

function isSettled(phase: string): boolean {
  return phase === 'loaded' || phase === 'failed';
}

export function useRoomAssets(): RoomAssets {
  const assetSetId = useRoomStore((s) => s.assetSetId);
  const assetSet = useRoomStore((s) => s.assetSet);
  const switchAssetSet = useRoomStore((s) => s.switchAssetSet);
  const splat = useRoomStore((s) => s.splat);
  const collider = useRoomStore((s) => s.collider);
  const objects = useRoomStore((s) => s.objects);
  const floor = useRoomStore((s) => s.floor);
  const showCollider = useRoomStore((s) => s.showCollider);
  const loadRoom = useRoomStore((s) => s.loadRoom);
  const reloadRoom = useRoomStore((s) => s.reloadRoom);
  const setShowColliderRaw = useRoomStore((s) => s.setShowCollider);
  const toggleCollider = useRoomStore((s) => s.toggleCollider);

  useEffect(() => {
    void loadRoom();
  }, [loadRoom]);

  return useMemo<RoomAssets>(() => {
    const bounds = collider.data?.bounds ?? null;
    const center: Vec3 | null = bounds
      ? [(bounds.min.x + bounds.max.x) / 2, floor.baseY, (bounds.min.z + bounds.max.z) / 2]
      : null;

    const phases = [splat.phase, collider.phase, objects.phase];
    const progress = [splat, collider, objects]
      .map((a) => (a.phase === 'loaded' ? 1 : a.progress < 0 ? 0.5 : Math.max(0, a.progress)))
      .reduce((a, b) => a + b, 0) / 3;

    return {
      assetSetId,
      assetSet,
      switchAssetSet: (id: string) => void switchAssetSet(id),

      splat,
      collider,
      objects,
      colliderData: collider.data,
      manifest: objects.manifest,
      loadedObjects: objects.loaded,
      getObject: (id) => (id ? (objects.byId[id] ?? null) : null),

      floor,
      floorYAt: (x, z) => floor.floorYAt(x, z),
      floorYAtOr: (x, z, fallbackY) => floor.floorYAtOr(x, z, fallbackY),

      roomBounds: bounds,
      roomCenter: center,
      ready: phases.every((p) => p === 'loaded'),
      settled: phases.every(isSettled),
      hasFailure: phases.some((p) => p === 'failed'),
      progress,

      showCollider,
      setShowCollider: (value) => setShowColliderRaw(value, true),
      toggleCollider,
      reload: () => void reloadRoom(),
    };
  }, [
    assetSetId,
    assetSet,
    switchAssetSet,
    splat,
    collider,
    objects,
    floor,
    showCollider,
    setShowColliderRaw,
    toggleCollider,
    reloadRoom,
  ]);
}
