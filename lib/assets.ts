/**
 * Where the pre-generated room inputs live. Swap these for a real capture by
 * dropping the files in public/sample-room/ and updating the paths.
 */
export const ASSETS = {
  /** Gaussian splat environment. A real capture is room.spz; the checked-in
   *  fixture is a .ply stand-in (Spark loads both). */
  splat: '/sample-room/room.spz',
  splatFallback: '/sample-room/room.ply',
  /** Invisible walkable-space collision mesh. */
  collider: '/sample-room/collider.glb',
  /** Manifest of individually meshed objects. */
  objects: '/sample-room/objects.json',
} as const;
