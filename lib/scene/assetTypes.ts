/**
 * Per-asset loading state. These are scene-loading concerns only — the shared
 * authoring contract (Waypoint, FrameEntry, Comment, PathSettings, SceneObject)
 * lives in lib/types.ts and is never redeclared here.
 */

import type * as THREE from 'three';
import type { SceneObject, Vec3 } from '@/lib/types';
import type { ColliderData } from './collider';

export type AssetPhase = 'idle' | 'loading' | 'loaded' | 'failed';

export type AssetState = {
  phase: AssetPhase;
  /** 0..1 while downloading; -1 when the server sent no content length. */
  progress: number;
  /** Human-readable reason the asset failed, or null. */
  error: string | null;
};

export const IDLE_ASSET: AssetState = { phase: 'idle', progress: 0, error: null };

/** Which file actually supplied the splats. */
export type SplatSourceKind = 'spz' | 'ply';

export type SplatState = AssetState & {
  /** The URL that was ultimately fetched, once resolved. */
  url: string | null;
  kind: SplatSourceKind | null;
  /** Splat count reported by Spark after decode. */
  splatCount: number | null;
  /** True when ASSETS.splat was missing and ASSETS.splatFallback was used. */
  usedFallback: boolean;
};

export type ColliderState = AssetState & {
  data: ColliderData | null;
};

/** One entry of objects.json plus its loaded mesh and derived framing info. */
export type LoadedObject = {
  /** The manifest entry, verbatim. */
  spec: SceneObject;
  /**
   * Canonical parsed mesh, positioned at the manifest position.
   * Clone before parenting it into a scene you also mount elsewhere.
   */
  root: THREE.Object3D;
  /** World-space AABB at the manifest position. */
  bounds: THREE.Box3;
  /** World-space centre — equal to `spec.position` for these fixtures. */
  center: Vec3;
  /** World-space extents. */
  size: Vec3;
  /** Bounding-sphere radius; a reasonable framing distance scale. */
  radius: number;
};

export type ObjectsState = AssetState & {
  /** objects.json as parsed, available as soon as the manifest lands. */
  manifest: SceneObject[];
  loaded: LoadedObject[];
  byId: Record<string, LoadedObject>;
  /** Manifest length, once known. */
  total: number;
  /** How many meshes have finished. */
  ready: number;
};
