/**
 * Measuring an uploaded collider, and refusing one that cannot be routed on.
 *
 * The collider is the authority in this app: the walk grid is rasterised out of
 * its triangles, the mini-map is its footprint, and the splat is placed onto it
 * rather than the other way round. So it is checked before anything is written,
 * with the same three gates the Marble pipeline already applies to a downloaded
 * one — container structure, then a real GLTFLoader parse, then "did that parse
 * actually yield triangles". An empty collider is the one failure the path
 * generator cannot detect for itself: it produces a grid with no obstacles in
 * it, and the camera flies through the walls.
 *
 * Everything past the gates is measurement, and it goes through
 * `buildColliderData` rather than reading accessor bounds out of the glTF JSON.
 * That is deliberate: a collider from Marble is one fused mesh with no floor
 * node, and only the per-triangle normal split in there finds a walk surface in
 * it. Reading the JSON would be cheaper and would report the floor of a fused
 * collider as "none".
 *
 * SERVER ONLY: node:fs, plus three.js.
 */

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import { inspectGlb, parseColliderGlb } from '@/lib/marble';
import { buildColliderData } from '@/lib/scene/collider';
import type { Vec3 } from '@/lib/types';
import type { ColliderScan, Extent } from './align';

/** Names of the meshes, for the log and for the capture's scene.json. */
export type ColliderInspection = ColliderScan & {
  meshNames: string[];
  /**
   * How the walk surface was found: by node name, by slab shape, or by
   * splitting a fused mesh on face normals. Worth recording — it is the
   * difference between a collider that says where its floor is and one whose
   * floor this app inferred.
   */
  floorSource: 'meshes' | 'derived' | 'none';
};

function extentOf(box: THREE.Box3): Extent {
  return {
    min: [box.min.x, box.min.y, box.min.z] as Vec3,
    max: [box.max.x, box.max.y, box.max.z] as Vec3,
  };
}

/**
 * Read, validate and measure a collider GLB.
 *
 * Throws MarbleError (from `inspectGlb` / `parseColliderGlb`) with a message
 * that names what is wrong with the file; the upload route turns those into a
 * field error beside the collider dropzone.
 */
export async function scanCollider(path: string): Promise<ColliderInspection> {
  const bytes = new Uint8Array(await readFile(path));

  // Structure first: it is the cheap check, and it is the one that catches an
  // HTML error page or a truncated transfer saved with a .glb name.
  const structure = inspectGlb(bytes);

  const root = await parseColliderGlb(bytes);
  const data = buildColliderData(root);

  if (data.triangleCount === 0) {
    throw new Error(
      `The collider parsed but yielded ${structure.meshCount} meshes and no triangles. ` +
        'A collider with no geometry is indistinguishable from open space downstream.',
    );
  }

  const derived = data.floorMeshes.some((mesh) => mesh.name === 'floor:derived');
  const floorTriangles = data.floorGeometry.getAttribute('position')?.count ?? 0;

  return {
    meshes: structure.meshCount,
    triangles: data.triangleCount,
    bounds: extentOf(data.bounds),
    floorBounds: floorTriangles > 0 ? extentOf(data.floorBounds) : null,
    meshNames: data.meshNames,
    floorSource: floorTriangles === 0 ? 'none' : derived ? 'derived' : 'meshes',
  };
}
