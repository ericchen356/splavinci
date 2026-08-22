/**
 * Floor-height lookup.
 *
 * "Given x,z, what is the floor y?" — needed by the plan screen to drop
 * mini-map clicks onto the floor, and by the path generator to place camera
 * samples at a consistent height above the walk surface.
 *
 * Pure three.js, no React. Build one with `createFloorSampler(colliderData)`.
 */

import * as THREE from 'three';
import type { ColliderData } from './collider';

/** Floor height used when there is no collider at all yet. */
export const DEFAULT_FLOOR_Y = 0;

export type FloorSampler = {
  /** True once a real collider is backing this sampler. */
  readonly ready: boolean;
  /** Floor surface Y at (x, z), or null when nothing is underfoot there. */
  floorYAt(x: number, z: number): number | null;
  /** Same lookup, but substitutes `baseY` (or `fallbackY`) on a miss. */
  floorYAtOr(x: number, z: number, fallbackY?: number): number;
  /** Whether (x, z) is over walkable floor at all. */
  isOverFloor(x: number, z: number): boolean;
  /**
   * Drop a world point onto the floor, keeping x/z and optionally lifting it.
   * `heightAboveFloor` defaults to 0.
   */
  snapToFloor(point: THREE.Vector3Like, heightAboveFloor?: number): THREE.Vector3;
  /** Raycast an arbitrary ray against the floor meshes. Null when it misses. */
  raycast(raycaster: THREE.Raycaster): THREE.Intersection | null;
  /** Dominant floor height — `floorBounds.max.y`. The sane default. */
  readonly baseY: number;
  /** AABB over the whole collider (room extents, including wall thickness). */
  readonly bounds: THREE.Box3;
  /** AABB over the floor only. */
  readonly floorBounds: THREE.Box3;
  /** The meshes this sampler shoots at, for callers wanting their own raycast. */
  readonly floorMeshes: readonly THREE.Mesh[];
};

/**
 * Build a floor sampler from parsed collider data.
 * Passing null yields a sampler that always reports "no floor" but still
 * answers `floorYAtOr` with DEFAULT_FLOOR_Y, so callers never need a null check.
 */
export function createFloorSampler(collider: ColliderData | null): FloorSampler {
  const floorMeshes = collider?.floorMeshes ?? [];
  const bounds = collider?.bounds.clone() ?? new THREE.Box3();
  const floorBounds = collider?.floorBounds.clone() ?? new THREE.Box3();
  const ready = floorMeshes.length > 0;
  const baseY = ready ? floorBounds.max.y : DEFAULT_FLOOR_Y;

  // Start the down-ray above everything in the room so it can never begin
  // inside the floor slab (which would make the top face a back-face hit).
  const rayStartY = ready ? bounds.max.y + 1 : 1;

  const raycaster = new THREE.Raycaster();
  raycaster.far = ready ? bounds.max.y - bounds.min.y + 2 : 2;
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);

  function intersectDown(x: number, z: number): THREE.Intersection | null {
    if (!ready) return null;
    origin.set(x, rayStartY, z);
    raycaster.set(origin, down);
    // `false` — floor meshes are collected flat by buildColliderData, so a
    // recursive walk would double-count nested children.
    const hits = raycaster.intersectObjects(floorMeshes as THREE.Mesh[], false);
    return hits.length > 0 ? hits[0] : null;
  }

  const sampler: FloorSampler = {
    ready,
    baseY,
    bounds,
    floorBounds,
    floorMeshes,

    floorYAt(x, z) {
      const hit = intersectDown(x, z);
      return hit ? hit.point.y : null;
    },

    floorYAtOr(x, z, fallbackY = baseY) {
      const y = sampler.floorYAt(x, z);
      return y === null ? fallbackY : y;
    },

    isOverFloor(x, z) {
      return intersectDown(x, z) !== null;
    },

    snapToFloor(point, heightAboveFloor = 0) {
      const y = sampler.floorYAtOr(point.x, point.z);
      return new THREE.Vector3(point.x, y + heightAboveFloor, point.z);
    },

    raycast(rc) {
      if (!ready) return null;
      const hits = rc.intersectObjects(floorMeshes as THREE.Mesh[], false);
      return hits.length > 0 ? hits[0] : null;
    },
  };

  return sampler;
}
