/**
 * Plain-three asset loaders. No React, no R3F, no WebGL context required —
 * GLTFLoader parses to CPU-side buffers, so these are safe to call from a
 * plain async function (the path generator does exactly that).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSETS } from '@/lib/assets';
import type { SceneObject, Vec3 } from '@/lib/types';
import { buildColliderData, type ColliderData } from './collider';
import type { LoadedObject, SplatSourceKind } from './assetTypes';

let sharedGltfLoader: GLTFLoader | null = null;

function gltfLoader(): GLTFLoader {
  if (!sharedGltfLoader) sharedGltfLoader = new GLTFLoader();
  return sharedGltfLoader;
}

export type ProgressFn = (fraction: number) => void;

function progressFraction(event: ProgressEvent): number {
  return event.total > 0 ? event.loaded / event.total : -1;
}

/** Normalise anything thrown by a loader into a short message. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Unknown error';
}

/* ----------------------------- splat url probe ---------------------------- */

export type SplatResolution = {
  url: string;
  kind: SplatSourceKind;
  usedFallback: boolean;
};

function splatKindFor(url: string): SplatSourceKind {
  return url.toLowerCase().endsWith('.spz') ? 'spz' : 'ply';
}

async function urlExists(url: string): Promise<boolean> {
  try {
    // HEAD first — cheap, and Next serves a 404 for missing files in public/.
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 501) {
      // Server refuses HEAD; fall back to a ranged GET so we do not pull the
      // whole file just to find out whether it is there.
      const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      return ranged.ok;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Pick the splat file to load: prefer ASSETS.splat (room.spz, dropped in with a
 * real capture), fall back to ASSETS.splatFallback (the checked-in .ply) when
 * the .spz is not there. Never throws — returns null only when both are gone.
 */
export async function resolveSplatSource(): Promise<SplatResolution | null> {
  if (await urlExists(ASSETS.splat)) {
    return { url: ASSETS.splat, kind: splatKindFor(ASSETS.splat), usedFallback: false };
  }
  if (await urlExists(ASSETS.splatFallback)) {
    return {
      url: ASSETS.splatFallback,
      kind: splatKindFor(ASSETS.splatFallback),
      usedFallback: true,
    };
  }
  return null;
}

/* -------------------------------- collider -------------------------------- */

export async function loadCollider(
  url: string = ASSETS.collider,
  onProgress?: ProgressFn,
): Promise<ColliderData> {
  const gltf = await gltfLoader().loadAsync(url, (e) => onProgress?.(progressFraction(e)));
  return buildColliderData(gltf.scene);
}

/* --------------------------------- objects -------------------------------- */

export async function loadObjectManifest(url: string = ASSETS.objects): Promise<SceneObject[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (!Array.isArray(json)) throw new Error(`${url} is not an array`);
  return json as SceneObject[];
}

/**
 * Load one manifest entry's mesh and place it at its manifest position.
 *
 * Every mesh in public/sample-room/meshes is authored centred on its own
 * origin and the manifest position is the world-space centre, so the placement
 * is a straight assignment with no offset correction.
 */
export async function loadSceneObject(spec: SceneObject): Promise<LoadedObject> {
  const gltf = await gltfLoader().loadAsync(spec.meshUrl);
  const root = gltf.scene;
  root.name = spec.id;
  root.position.set(spec.position[0], spec.position[1], spec.position[2]);
  root.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  bounds.getCenter(center);
  bounds.getSize(size);

  return {
    spec,
    root,
    bounds,
    center: [center.x, center.y, center.z] as Vec3,
    size: [size.x, size.y, size.z] as Vec3,
    radius: size.length() / 2,
  };
}

/**
 * Load every mesh in the manifest. Individual failures are reported through
 * `onError` and skipped rather than sinking the whole batch — one bad mesh
 * should not blank the room.
 */
export async function loadSceneObjects(
  manifest: SceneObject[],
  hooks?: {
    onOne?: (loaded: LoadedObject, index: number) => void;
    onError?: (spec: SceneObject, message: string) => void;
  },
): Promise<LoadedObject[]> {
  const settled = await Promise.all(
    manifest.map(async (spec, i) => {
      try {
        const loaded = await loadSceneObject(spec);
        hooks?.onOne?.(loaded, i);
        return loaded;
      } catch (err) {
        hooks?.onError?.(spec, describeError(err));
        return null;
      }
    }),
  );
  return settled.filter((x): x is LoadedObject => x !== null);
}
