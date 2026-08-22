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


/**
 * Split a triangle soup into floor and obstacle by face normal.
 *
 * The last-resort classifier, for a collider that arrives as ONE fused mesh.
 * A real Marble export does exactly that - a single node named `geometry_0`
 * holding the whole room - which defeats both strategies above: there is no
 * name to match, and the shape heuristic cannot fire because with one mesh the
 * slab thickness equals the full vertical range, so nothing is ever "flat".
 * The result was zero floor meshes and an empty floorBounds, leaving the walk
 * grid with no walkable surface at all and A* with nothing to route on.
 *
 * Geometry still carries the answer at triangle level: a floor faces up. Faces
 * within `maxSlopeDegrees` of vertical-up become floor, everything else is an
 * obstacle. That is orientation-based rather than name-based, so it works on a
 * capture whose naming we have never seen.
 */
export function splitSoupByNormal(
  geometry: THREE.BufferGeometry,
  maxSlopeDegrees = 40,
  /** Accept a downward face as horizontal. Only used as a winding fallback. */
  ignoreWinding = false,
): { floor: THREE.BufferGeometry; obstacle: THREE.BufferGeometry } {
  const pos = geometry.getAttribute('position');
  const minUp = Math.cos((maxSlopeDegrees * Math.PI) / 180);
  const triCount = Math.floor(pos.count / 3);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const upFacing = new Uint8Array(triCount);
  const centroidY = new Float32Array(triCount);

  const bounds = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
    pos as THREE.BufferAttribute,
  );
  const spanX = Math.max(1e-6, bounds.max.x - bounds.min.x);
  const spanZ = Math.max(1e-6, bounds.max.z - bounds.min.z);
  // Coarse columns purely for the lowest-surface test; 128 across the larger
  // horizontal axis is fine for deciding "is there floor beneath this face".
  const columnSize = Math.max(spanX, spanZ) / 128;
  const cols = Math.max(1, Math.ceil(spanX / columnSize));
  const lowestUp = new Map<number, number>();
  const triMinX = new Float32Array(triCount);
  const triMaxX = new Float32Array(triCount);
  const triMinZ = new Float32Array(triCount);
  const triMaxZ = new Float32Array(triCount);

  /** Visit every column a triangle's XZ footprint touches. */
  const forEachColumn = (t: number, visit: (key: number) => void) => {
    const c0 = Math.floor((triMinX[t] - bounds.min.x) / columnSize);
    const c1 = Math.floor((triMaxX[t] - bounds.min.x) / columnSize);
    const r0 = Math.floor((triMinZ[t] - bounds.min.z) / columnSize);
    const r1 = Math.floor((triMaxZ[t] - bounds.min.z) / columnSize);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) visit(r * cols + c);
    }
  };

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);
    const length = normal.length();
    // Signed, not absolute. glTF mandates counter-clockwise front faces, so an
    // upward normal really does mean an upward surface - and the distinction
    // matters: a wall's underside is horizontal too, and folding it into the
    // floor leaves the wall's interior with no obstacle beneath its top cap,
    // so the cell never blocks. `ignoreWinding` retries for the rare export
    // that gets this wrong.
    const rawUp = length > 1e-12 ? normal.y / length : 0;
    const upness = ignoreWinding ? Math.abs(rawUp) : rawUp;
    centroidY[t] = (a.y + b.y + c.y) / 3;
    triMinX[t] = Math.min(a.x, b.x, c.x);
    triMaxX[t] = Math.max(a.x, b.x, c.x);
    triMinZ[t] = Math.min(a.z, b.z, c.z);
    triMaxZ[t] = Math.max(a.z, b.z, c.z);
    if (upness < minUp) continue;
    upFacing[t] = 1;
    // Footprint, not centroid: a floor can be two enormous triangles whose
    // centroids fall in two columns, leaving every other column with no
    // reference height and every wall cap looking like ground.
    forEachColumn(t, (key) => {
      const current = lowestUp.get(key);
      if (current === undefined || centroidY[t] < current) lowestUp.set(key, centroidY[t]);
    });
  }

  // A wall's top cap faces up just as much as the floor does, and so does a
  // ceiling. Taking every up-facing face as floor puts the walkable surface on
  // top of the walls, which lifts the camera band clear of them and leaves the
  // grid with nothing blocked at all. Only the lowest horizontal surface over
  // a triangle's own footprint counts as ground.
  const LOWEST_TOLERANCE = 0.5;
  const floorVerts: number[] = [];
  const obstacleVerts: number[] = [];

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    let isFloor = false;
    if (upFacing[t]) {
      let base = Infinity;
      forEachColumn(t, (key) => {
        const v = lowestUp.get(key);
        if (v !== undefined && v < base) base = v;
      });
      isFloor = !Number.isFinite(base) || centroidY[t] - base <= LOWEST_TOLERANCE;
    }
    const target = isFloor ? floorVerts : obstacleVerts;
    target.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  const make = (verts: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };
  return { floor: make(floorVerts), obstacle: make(obstacleVerts) };
}

/** Wrap a geometry as a Mesh so the floor sampler has something to raycast. */
function meshFromGeometry(geometry: THREE.BufferGeometry, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
  mesh.name = name;
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Parse a loaded collider scene into the shape every other screen consumes. */
export function buildColliderData(root: THREE.Object3D): ColliderData {
  const meshes = collectMeshes(root);
  let { floorMeshes, obstacleMeshes } = classifyColliderMeshes(meshes);

  const merged = worldTriangleSoup(meshes);
  let obstacleGeometry = worldTriangleSoup(obstacleMeshes);
  let floorGeometry = worldTriangleSoup(floorMeshes);

  // Neither naming nor shape found a floor - a fused single-mesh collider, as
  // Marble returns. Fall back to per-triangle orientation, which still knows
  // which faces point up. Without this the grid has no walkable surface.
  if (floorGeometry.getAttribute('position').count === 0) {
    let split = splitSoupByNormal(merged);
    if (split.floor.getAttribute('position').count === 0) {
      // Nothing faced up at all - the export's winding is inverted or mixed.
      split = splitSoupByNormal(merged, 40, true);
    }
    if (split.floor.getAttribute('position').count > 0) {
      floorGeometry = split.floor;
      obstacleGeometry = split.obstacle;
      floorMeshes = [meshFromGeometry(split.floor, 'floor:derived')];
      obstacleMeshes = [meshFromGeometry(split.obstacle, 'obstacles:derived')];
    }
  }

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
