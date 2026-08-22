/**
 * Plain-three asset loaders. No React, no R3F, no WebGL context required —
 * GLTFLoader parses to CPU-side buffers, so these are safe to call from a
 * plain async function (the path generator does exactly that).
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSETS } from '@/lib/assets';
import { buildColliderData, type ColliderData } from './collider';
import type { SplatSourceKind } from './assetTypes';

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
  const preferred = ASSETS.splat;
  if (await urlExists(preferred)) {
    return { url: preferred, kind: splatKindFor(preferred), usedFallback: false };
  }
  const fallback = ASSETS.splatFallback;
  if (fallback && (await urlExists(fallback))) {
    return { url: fallback, kind: splatKindFor(fallback), usedFallback: true };
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
