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
      'Real outdoor capture, downsampled to 2M splats. Collider and features ' +
      'derived from the splat itself - there is no authored collision mesh.',
    splat: '/hobbiton/room.spz',
    splatFallback: null,
    collider: '/hobbiton/collider.glb',
    objects: '/hobbiton/objects.json',
    // Y-down capture: flip about X, then lift so median ground sits at y = 0.
    // Must match public/hobbiton/scene.json.
    placement: { position: [0, 0.8003, 0], rotation: [Math.PI, 0, 0], scale: 1 },
    approxSplats: 2_000_000,
  },
};

export const DEFAULT_ASSET_SET_ID = 'sample-room';

const STORAGE_KEY = 'splavinci.assetSet';

/**
 * Module-level rather than React state: the plain-three loaders read it at call
 * time, and it has to survive client-side navigation between the three screens.
 */
let activeId: string = DEFAULT_ASSET_SET_ID;

if (typeof window !== 'undefined') {
  const saved = window.localStorage?.getItem(STORAGE_KEY);
  if (saved && ASSET_SETS[saved]) activeId = saved;
}

export function getActiveAssetSetId(): string {
  return activeId;
}

export function getAssetSet(id: string = activeId): AssetSet {
  return ASSET_SETS[id] ?? ASSET_SETS[DEFAULT_ASSET_SET_ID];
}

/** Returns true when the active set actually changed. */
export function setActiveAssetSet(id: string): boolean {
  if (!ASSET_SETS[id] || id === activeId) return false;
  activeId = id;
  try {
    window.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing or blocked storage - the choice just will not persist.
  }
  return true;
}

/** Current URLs. Kept as a getter so callers cannot cache a stale set. */
export const ASSETS = {
  get splat() { return getAssetSet().splat; },
  get splatFallback() { return getAssetSet().splatFallback; },
  get collider() { return getAssetSet().collider; },
  get objects() { return getAssetSet().objects; },
};
