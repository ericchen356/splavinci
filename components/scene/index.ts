/**
 * Scene components. Mount RoomScene inside your own <Canvas>:
 *
 *   import { RoomScene, CameraRig } from '@/components/scene';
 */

export { RoomScene, type RoomSceneProps } from './RoomScene';
export { SplatLayer, type SplatLayerProps } from './SplatLayer';
export { ColliderLayer, type ColliderLayerProps } from './ColliderLayer';
export {
  CameraRig,
  CameraPresetDriver,
  CAMERA_BODY_RADIUS,
  CAMERA_PRESETS,
  derivePresets,
  type CameraPreset,
  type CameraRigProps,
} from './CameraRig';
export {
  CameraTracker,
  type TrackedPose,
  type CameraTrackerProps,
} from './CameraTracker';
export { PoseCapture, type PoseCaptureProps } from './PoseCapture';
export { CLICK_SLOP_PX, isDrag } from './pointer';
export { AssetStatusPanel, type AssetStatusPanelProps } from './AssetStatusPanel';
