/**
 * Per-asset loading state. These are scene-loading concerns only — the shared
 * authoring contract (Waypoint, FrameEntry, Comment, PathSettings) lives in
 * lib/types.ts and is never redeclared here.
 */

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
