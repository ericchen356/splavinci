/**
 * Collider parsing + world-space geometry extraction.
 *
 * The path generator needs a flat, world-space triangle soup to rasterise a
 * walkable grid from, and the plan screen needs the floor meshes to raycast
 * against. Both come out of `buildColliderData`, which is deliberately pure
 * three.js — no React, no R3F — so it can be called from a worker or a plain
 * async function.
 */

import * as THREE from 'three';

export type ColliderData = {
  /** The GLTF scene as parsed. Canonical copy — clone it before parenting. */
  root: THREE.Object3D;
  /** Every mesh in the collider, world matrices already updated. */
  meshes: THREE.Mesh[];
  /** Meshes classified as walkable floor (see `classifyColliderMeshes`). */
  floorMeshes: THREE.Mesh[];
  /** Everything that is not floor: walls, partitions, dividers. */
  obstacleMeshes: THREE.Mesh[];
  /** All triangles, world space, non-indexed. 9 floats per triangle. */
  merged: THREE.BufferGeometry;
  /** Obstacle triangles only, world space, non-indexed. */
  obstacleGeometry: THREE.BufferGeometry;
  /** Floor triangles only, world space, non-indexed. */
  floorGeometry: THREE.BufferGeometry;
  /** AABB over every collider mesh. */
  bounds: THREE.Box3;
  /** AABB over the floor meshes only. `floorBounds.max.y` is the walk surface. */
  floorBounds: THREE.Box3;
  triangleCount: number;
  meshNames: string[];
};

/** Names that mark a mesh as walkable floor rather than an obstacle. */
const FLOOR_NAME = /^(floor|ground|walkable)/i;

/**
 * Split collider meshes into floor vs obstacle.
 *
 * Prefers the naming convention ("floor", "ground", "walkable"). If nothing
 * matches — a real capture may use different names — it falls back to a shape
 * heuristic: a floor slab is wide in XZ and thin in Y, and sits at the bottom
 * of the collider's vertical range.
 */
export function classifyColliderMeshes(meshes: THREE.Mesh[]): {
  floorMeshes: THREE.Mesh[];
  obstacleMeshes: THREE.Mesh[];
} {
  const named = meshes.filter((m) => FLOOR_NAME.test(m.name));
  if (named.length > 0) {
    const floor = new Set(named);
    return {
      floorMeshes: named,
      obstacleMeshes: meshes.filter((m) => !floor.has(m)),
    };
  }

  // Shape fallback: score each mesh by XZ footprint / Y thickness, keep the
  // ones that are both flat and near the bottom of the overall bounds.
  const boxes = meshes.map((m) => meshWorldBox(m));
  const all = new THREE.Box3();
  for (const b of boxes) all.union(b);
  const floorMeshes: THREE.Mesh[] = [];
  const obstacleMeshes: THREE.Mesh[] = [];
  const yRange = Math.max(1e-6, all.max.y - all.min.y);
  meshes.forEach((mesh, i) => {
    const b = boxes[i];
    const thickness = b.max.y - b.min.y;
    const footprint = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    const flat = thickness <= yRange * 0.25;
    const low = b.max.y - all.min.y <= yRange * 0.35;
    const wide = footprint >= 1;
    if (flat && low && wide) floorMeshes.push(mesh);
    else obstacleMeshes.push(mesh);
  });
  return { floorMeshes, obstacleMeshes };
}

function meshWorldBox(mesh: THREE.Mesh): THREE.Box3 {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox ? geom.boundingBox.clone() : new THREE.Box3();
  box.applyMatrix4(mesh.matrixWorld);
  return box;
}

/**
 * Flatten meshes into one non-indexed, world-space position buffer.
 * Everything downstream (grid rasterisation, raycasting, BVH construction)
 * wants triangles in world space with the node transforms already baked in.
 */
export function worldTriangleSoup(meshes: THREE.Mesh[]): THREE.BufferGeometry {
  let total = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const index = mesh.geometry.getIndex();
    total += index ? index.count : pos.count;
  }

  const out = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  let w = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
      out[w++] = v.x;
      out[w++] = v.y;
      out[w++] = v.z;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Collect every THREE.Mesh under `root`, with world matrices refreshed. */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  return meshes;
}

/** Parse a loaded collider scene into the shape every other screen consumes. */
export function buildColliderData(root: THREE.Object3D): ColliderData {
  const meshes = collectMeshes(root);
  const { floorMeshes, obstacleMeshes } = classifyColliderMeshes(meshes);

  const merged = worldTriangleSoup(meshes);
  const obstacleGeometry = worldTriangleSoup(obstacleMeshes);
  const floorGeometry = worldTriangleSoup(floorMeshes);

  const bounds = merged.boundingBox?.clone() ?? new THREE.Box3();
  const floorBounds = floorGeometry.boundingBox?.clone() ?? bounds.clone();

  return {
    root,
    meshes,
    floorMeshes,
    obstacleMeshes,
    merged,
    obstacleGeometry,
    floorGeometry,
    bounds,
    floorBounds,
    triangleCount: merged.getAttribute('position').count / 3,
    meshNames: meshes.map((m) => m.name),
  };
}
