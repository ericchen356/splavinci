/**
 * Selectable asset sets.
 *
 * A capture is more than a splat file: it is the splat, a collider to route on,
 * an object manifest to frame shots against, and the transform that puts the
 * splat in the same world as the other two. They travel together here, because
 * loading a splat with another capture's collider silently misaligns the whole
 * scene, and nothing downstream can detect that.
 *
 * The transform matters. 3DGS captures trained from COLMAP are Y-down, and
 * Spark applies no axis conversion of its own - it places splats exactly as
 * authored. Rendering one without the flip gives an upside-down room in which
 * every camera and path assumption is inverted. Derived colliders are written
 * in the corrected frame by scripts/spz-collider.mjs, which reports the exact
 * transform it used in scene.json; the value here must match it.
 */

import type { Vec3 } from './types';

export type SplatPlacement = {
  position: Vec3;
  /** XYZ Euler radians. [PI, 0, 0] converts a Y-down capture to this Y-up world. */
  rotation: Vec3;
  scale: number;
};

/**
 * A density variant of the same capture.
 *
 * Splat count trades fidelity against frame rate directly, and the right
 * balance depends on the machine and on what you are doing: placing waypoints
 * wants responsiveness, judging a final flythrough wants detail. Rather than
 * guess, the same capture ships at several densities and the user picks. They
 * are all the same scene, so switching between them keeps waypoints valid.
 */
export type SplatQuality = {
  id: string;
  label: string;
  url: string;
  approxSplats: number;
  /** Rough download size, so the UI can be honest before a long fetch. */
  approxBytes: number;
  note?: string;
};

export type AssetSet = {
  id: string;
  label: string;
  description: string;
  /** Preferred splat. */
  splat: string;
  /** Used when `splat` 404s. */
  splatFallback: string | null;
  collider: string;
  objects: string;
  placement: SplatPlacement;
  /** Roughly how many splats, for the UI to warn about heavy captures. */
  approxSplats?: number;
  /** Density variants, if the capture ships more than one. */
  qualities?: readonly SplatQuality[];
  defaultQualityId?: string;
};

const IDENTITY: SplatPlacement = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };

export const ASSET_SETS: Record<string, AssetSet> = {
  'sample-room': {
    id: 'sample-room',
    label: 'Sample room',
    description: 'Synthetic two-zone apartment. Authored Y-up, so no transform.',
    splat: '/sample-room/room.spz',
    splatFallback: '/sample-room/room.ply',
    collider: '/sample-room/collider.glb',
    objects: '/sample-room/objects.json',
    placement: IDENTITY,
    approxSplats: 62_508,
  },
  hobbiton: {
    id: 'hobbiton',
    label: 'Hobbiton',
    description:
      'Real outdoor capture. Collider and features are derived from the splat ' +
      'itself - there is no authored collision mesh.',
    splat: '/hobbiton/room-4m.spz',
    splatFallback: null,
    collider: '/hobbiton/collider.glb',
    objects: '/hobbiton/objects.json',
    // Y-down capture: flip about X, then lift so median ground sits at y = 0.
    //
    // MUST match public/hobbiton/scene.json, which scripts/spz-collider.mjs
    // writes alongside the collider. The offset is derived from the capture's
    // own median terrain, so it changes whenever the collider is regenerated
    // at a different cell size - and a stale value here does not fail, it just
    // floats the splat off its own collider (it was 93mm out). The generator
    // prints the exact line to paste; keep them in step.
    placement: { position: [0, 0.8933, 0], rotation: [Math.PI, 0, 0], scale: 1 },
    approxSplats: 4_000_000,
    defaultQualityId: 'balanced',
    qualities: [
      {
        id: 'fast', label: 'Fast', url: '/hobbiton/room.spz',
        approxSplats: 2_000_000, approxBytes: 30_413_281,
        note: 'visibly sparse - holes in the ground cover',
      },
      {
        id: 'balanced', label: 'Balanced', url: '/hobbiton/room-4m.spz',
        approxSplats: 4_000_000, approxBytes: 60_812_776,
      },
      {
        id: 'quality', label: 'Quality', url: '/hobbiton/room-8m.spz',
        approxSplats: 8_000_000, approxBytes: 121_612_655,
        note: 'best detail, roughly 20fps',
      },
    ],
  },
};

export const DEFAULT_ASSET_SET_ID = 'sample-room';

const STORAGE_KEY = 'splavinci.assetSet';

/**
 * Module-level rather than React state: the plain-three loaders read it at call
 * time, and it has to survive client-side navigation between the three screens.
 *
 * Deliberately starts at the default and is NOT seeded from localStorage here.
 * Reading storage at module scope makes the server and the first client render
 * disagree, and React does not patch up a mismatched attribute - the capture
 * picker would render its highlight on one set while the loaders fetched
 * another, which is worse than not persisting at all. `readSavedAssetSetId` is
 * called from an effect after mount instead.
 */
let activeId: string = DEFAULT_ASSET_SET_ID;
let activeQualityId: string | null = null;

/** The persisted choice, or null. Safe to call only on the client. */
export function readSavedAssetSetId(): string | null {
  try {
    const saved = window.localStorage?.getItem(STORAGE_KEY);
    return saved && ASSET_SETS[saved] ? saved : null;
  } catch {
    return null;
  }
}

export function getActiveAssetSetId(): string {
  return activeId;
}

/** The chosen density for the active capture, or its default. */
export function getActiveQualityId(): string | null {
  const set = getAssetSet();
  if (!set.qualities?.length) return null;
  const chosen = activeQualityId ?? set.defaultQualityId ?? set.qualities[0].id;
  return set.qualities.some((q) => q.id === chosen) ? chosen : set.qualities[0].id;
}

export function getActiveQuality(): SplatQuality | null {
  const set = getAssetSet();
  const id = getActiveQualityId();
  return set.qualities?.find((q) => q.id === id) ?? null;
}

/** Returns true when the density actually changed. */
export function setActiveQuality(id: string): boolean {
  const set = getAssetSet();
  if (!set.qualities?.some((q) => q.id === id)) return false;
  if (getActiveQualityId() === id) return false;
  activeQualityId = id;
  return true;
}

export function getAssetSet(id: string = activeId): AssetSet {
  return ASSET_SETS[id] ?? ASSET_SETS[DEFAULT_ASSET_SET_ID];
}

/** Returns true when the active set actually changed. */
export function setActiveAssetSet(id: string): boolean {
  if (!ASSET_SETS[id] || id === activeId) return false;
  activeId = id;
  // Density is per capture, so a stale choice must not leak across a switch.
  activeQualityId = null;
  try {
    window.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing or blocked storage - the choice just will not persist.
  }
  return true;
}

/** Current URLs. Kept as a getter so callers cannot cache a stale set. */
export const ASSETS = {
  get splat() { return getActiveQuality()?.url ?? getAssetSet().splat; },
  get splatFallback() { return getAssetSet().splatFallback; },
  get collider() { return getAssetSet().collider; },
  get objects() { return getAssetSet().objects; },
};
