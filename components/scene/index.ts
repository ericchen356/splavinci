/**
 * Scene components. Mount RoomScene inside your own <Canvas>:
 *
 *   import { RoomScene, CameraRig } from '@/components/scene';
 */

export { RoomScene, type RoomSceneProps } from './RoomScene';
export { SplatLayer, type SplatLayerProps } from './SplatLayer';
export { ColliderLayer, type ColliderLayerProps } from './ColliderLayer';
export { ObjectsLayer, type ObjectsLayerProps } from './ObjectsLayer';
export {
  CameraRig,
  CameraPresetDriver,
  CAMERA_PRESETS,
  type CameraMode,
  type CameraPreset,
  type CameraRigProps,
} from './CameraRig';
export { AssetStatusPanel, type AssetStatusPanelProps } from './AssetStatusPanel';
