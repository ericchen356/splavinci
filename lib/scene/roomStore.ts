/**
 * The room asset store.
 *
 * One module-level singleton, so /scene, /plan and /review all mount the same
 * already-parsed room instead of re-downloading it on every route change.
 * Readable outside React via `useRoomStore.getState()` — the path generator
 * does that to get at the collider geometry without mounting anything.
 *
 * The store holds CANONICAL three.js objects. Clone before parenting them into
 * a scene (an Object3D can only have one parent) — the layer components in
 * components/scene do exactly that.
 */

import { create } from 'zustand';
import type { SceneObject } from '@/lib/types';
import {
  getActiveAssetSetId,
  getActiveQualityId,
  setActiveAssetSet,
  setActiveQuality,
  type AssetSet,
  getAssetSet,
} from '@/lib/assets';
import type {
  ColliderState,
  LoadedObject,
  ObjectsState,
  SplatState,
} from './assetTypes';
import { createFloorSampler, type FloorSampler } from './floor';
import {
  describeError,
  loadCollider,
  loadObjectManifest,
  loadSceneObjects,
  resolveSplatSource,
} from './loaders';

const INITIAL_SPLAT: SplatState = {
  phase: 'idle',
  progress: 0,
  error: null,
  url: null,
  kind: null,
  splatCount: null,
  usedFallback: false,
};

const INITIAL_COLLIDER: ColliderState = {
  phase: 'idle',
  progress: 0,
  error: null,
  data: null,
};

const INITIAL_OBJECTS: ObjectsState = {
  phase: 'idle',
  progress: 0,
  error: null,
  manifest: [],
  loaded: [],
  byId: {},
  total: 0,
  ready: 0,
};

export type RoomStore = {
  /** Which capture is loaded. Changing it reloads every asset. */
  assetSetId: string;
  /** The active set's full definition, including the splat placement. */
  assetSet: AssetSet;
  /** Chosen density variant for the active capture, or null if it has none. */
  qualityId: string | null;
  splat: SplatState;
  collider: ColliderState;
  objects: ObjectsState;
  /** Rebuilt whenever the collider changes; never null after the collider lands. */
  floor: FloorSampler;
  /** Debug wireframe toggle for the otherwise-invisible collider. */
  showCollider: boolean;
  /** True once the user has touched the toggle, so auto-enable stops meddling. */
  colliderToggleTouched: boolean;

  setShowCollider(value: boolean, fromUser?: boolean): void;
  toggleCollider(): void;

  /** Idempotent. Kicks off collider + manifest + object meshes exactly once. */
  loadRoom(): Promise<void>;
  /** Drop everything and load again (dev affordance / retry button). */
  reloadRoom(): Promise<void>;
  /** Switch capture and reload. No-op when already active. */
  switchAssetSet(id: string): Promise<void>;
  /** Switch density. Only the splat reloads - collider and objects are shared. */
  switchQuality(id: string): Promise<void>;

  /* Splat status is pushed in by the R3F layer, which owns the Spark objects. */
  beginSplat(): Promise<string | null>;
  setSplatProgress(fraction: number): void;
  setSplatLoaded(splatCount: number | null): void;
  setSplatFailed(message: string): void;
};

export const useRoomStore = create<RoomStore>((set, get) => ({
  assetSetId: getActiveAssetSetId(),
  assetSet: getAssetSet(),
  qualityId: getActiveQualityId(),
  splat: INITIAL_SPLAT,
  collider: INITIAL_COLLIDER,
  objects: INITIAL_OBJECTS,
  floor: createFloorSampler(null),
  showCollider: false,
  colliderToggleTouched: false,

  setShowCollider(value, fromUser = true) {
    set((s) => ({
      showCollider: value,
      colliderToggleTouched: s.colliderToggleTouched || fromUser,
    }));
  },

  toggleCollider() {
    get().setShowCollider(!get().showCollider, true);
  },

  async loadRoom() {
    if (roomLoad) return roomLoad;
    roomLoad = runRoomLoad(set);
    return roomLoad;
  },

  async switchAssetSet(id) {
    if (!setActiveAssetSet(id)) return;
    set({ assetSetId: id, assetSet: getAssetSet(id), qualityId: getActiveQualityId() });
    return get().reloadRoom();
  },

  async switchQuality(id) {
    if (!setActiveQuality(id)) return;
    // Only the splat changes. The collider and manifest describe the same
    // scene at any density, so reloading them would just re-download and
    // re-parse identical bytes - and would throw away the parsed collider the
    // path generator's grid cache is keyed on.
    splatResolution = null;
    set({ qualityId: getActiveQualityId(), splat: INITIAL_SPLAT });
  },

  async reloadRoom() {
    roomLoad = null;
    set({
      collider: INITIAL_COLLIDER,
      objects: INITIAL_OBJECTS,
      splat: INITIAL_SPLAT,
      floor: createFloorSampler(null),
    });
    splatResolution = null;
    return get().loadRoom();
  },

  async beginSplat() {
    set((s) => ({ splat: { ...s.splat, phase: 'loading', progress: 0, error: null } }));
    if (!splatResolution) splatResolution = resolveSplatSource();
    const resolved = await splatResolution;
    if (!resolved) {
      set((s) => ({
        splat: {
          ...s.splat,
          phase: 'failed',
          error: 'No splat file found (neither .spz nor .ply)',
        },
      }));
      return null;
    }
    set((s) => ({
      splat: {
        ...s.splat,
        phase: 'loading',
        url: resolved.url,
        kind: resolved.kind,
        usedFallback: resolved.usedFallback,
      },
    }));
    return resolved.url;
  },

  setSplatProgress(fraction) {
    set((s) =>
      s.splat.phase === 'loading' ? { splat: { ...s.splat, progress: fraction } } : {},
    );
  },

  setSplatLoaded(splatCount) {
    set((s) => ({
      splat: { ...s.splat, phase: 'loaded', progress: 1, error: null, splatCount },
    }));
  },

  setSplatFailed(message) {
    set((s) => ({ splat: { ...s.splat, phase: 'failed', error: message } }));
  },
}));

/* -------------------------------------------------------------------------- */

/** Guards `loadRoom` so React StrictMode's double-mount cannot double-fetch. */
let roomLoad: Promise<void> | null = null;
/** Memoised .spz-vs-.ply probe, so remounting the canvas does not re-probe. */
let splatResolution: Promise<Awaited<ReturnType<typeof resolveSplatSource>>> | null = null;

type SetFn = (
  partial: Partial<RoomStore> | ((s: RoomStore) => Partial<RoomStore>),
) => void;

async function runRoomLoad(set: SetFn): Promise<void> {
  await Promise.all([loadColliderInto(set), loadObjectsInto(set)]);
}

async function loadColliderInto(set: SetFn): Promise<void> {
  set({ collider: { ...INITIAL_COLLIDER, phase: 'loading' } });
  try {
    const data = await loadCollider(undefined, (progress) =>
      set((s) => ({ collider: { ...s.collider, progress } })),
    );
    set({
      collider: { phase: 'loaded', progress: 1, error: null, data },
      floor: createFloorSampler(data),
    });
  } catch (err) {
    set({
      collider: { ...INITIAL_COLLIDER, phase: 'failed', error: describeError(err) },
      floor: createFloorSampler(null),
    });
  }
}

async function loadObjectsInto(set: SetFn): Promise<void> {
  set({ objects: { ...INITIAL_OBJECTS, phase: 'loading' } });

  let manifest: SceneObject[];
  try {
    manifest = await loadObjectManifest();
  } catch (err) {
    set({ objects: { ...INITIAL_OBJECTS, phase: 'failed', error: describeError(err) } });
    return;
  }

  set((s) => ({
    objects: { ...s.objects, manifest, total: manifest.length, progress: 0 },
  }));

  const failures: string[] = [];
  const loaded = await loadSceneObjects(manifest, {
    onOne: () =>
      set((s) => {
        const ready = s.objects.ready + 1;
        const total = s.objects.total || 1;
        return { objects: { ...s.objects, ready, progress: ready / total } };
      }),
    onError: (spec, message) => failures.push(`${spec.id}: ${message}`),
  });

  const byId: Record<string, LoadedObject> = {};
  for (const item of loaded) byId[item.spec.id] = item;

  const allFailed = manifest.length > 0 && loaded.length === 0;
  set((s) => ({
    objects: {
      ...s.objects,
      phase: allFailed ? 'failed' : 'loaded',
      progress: 1,
      // Partial failures are surfaced but do not blank the room.
      error: failures.length > 0 ? failures.join('; ') : null,
      loaded,
      byId,
      ready: loaded.length,
    },
  }));
}

/* ------------------------------ non-React API ----------------------------- */

/**
 * Await the collider + object meshes from outside React (path generator,
 * workers, tests). Resolves once both have settled, loaded or failed.
 */
export async function ensureRoomLoaded(): Promise<RoomStore> {
  await useRoomStore.getState().loadRoom();
  return useRoomStore.getState();
}

/** Synchronous peek at the current room state. */
export function getRoomState(): RoomStore {
  return useRoomStore.getState();
}
