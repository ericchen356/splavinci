/**
 * How the splat cloud is placed relative to the collider/object world.
 *
 * COORDINATE NOTE — read before dropping in a real capture.
 * The checked-in fixture (public/sample-room/room.ply) is authored in the SAME
 * right-handed Y-up world as collider.glb: floor at y = 0,
 * x in [0,10], z in [0,8]. So the default transform below is identity.
 *
 * A real INRIA / Nerfstudio 3DGS capture is normally Y-DOWN. Spark applies no
 * axis conversion of its own — it drops the splats in exactly as authored. To
 * bring such a capture into this world, set `rotation: SPLAT_ROTATION_Y_DOWN`
 * (a 180-degree turn about X) and then position/scale it onto the collider.
 */

import type { Vec3 } from '@/lib/types';

export type SplatTransform = {
  /** World position of the splat cloud's origin. */
  position: Vec3;
  /** XYZ Euler rotation in radians. */
  rotation: Vec3;
  /** Uniform scale. */
  scale: number;
};

/** 180 degrees about X: converts a Y-down 3DGS capture to this Y-up world. */
export const SPLAT_ROTATION_Y_DOWN: Vec3 = [Math.PI, 0, 0];

/** Identity — correct for the checked-in room.ply fixture. */
export const DEFAULT_SPLAT_TRANSFORM: SplatTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};
