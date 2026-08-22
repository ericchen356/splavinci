/**
 * Public surface of the scene-loading layer.
 *
 *   import { useRoomAssets, ensureRoomLoaded, useRoomStore } from '@/lib/scene';
 *
 * Everything here is React-free except `useRoomAssets`, so the path generator
 * can pull collider geometry without mounting a canvas.
 */

export {
  buildColliderData,
  classifyColliderMeshes,
  collectMeshes,
  worldTriangleSoup,
  type ColliderData,
} from './collider';

export { createFloorSampler, DEFAULT_FLOOR_Y, type FloorSampler } from './floor';

export {
  IDLE_ASSET,
  type AssetPhase,
  type AssetState,
  type ColliderState,
  type LoadedObject,
  type ObjectsState,
  type SplatSourceKind,
  type SplatState,
} from './assetTypes';

export {
  describeError,
  loadCollider,
  loadObjectManifest,
  loadSceneObject,
  loadSceneObjects,
  resolveSplatSource,
  type ProgressFn,
  type SplatResolution,
} from './loaders';

export {
  ensureRoomLoaded,
  getRoomState,
  useRoomStore,
  type RoomStore,
} from './roomStore';

export { useRoomAssets, type RoomAssets } from './useRoomAssets';

export {
  DEFAULT_SPLAT_TRANSFORM,
  SPLAT_ROTATION_Y_DOWN,
  type SplatTransform,
} from './splat';
