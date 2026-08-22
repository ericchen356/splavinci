/**
 * The second half of the collider integrity gate.
 *
 * `inspectGlb` proves the container is well-formed. This proves the thing that
 * actually matters: that the loader this project uses at runtime — the same
 * GLTFLoader that scripts/path-lab.ts feeds into buildColliderData — can parse
 * the file and get triangles out of it. A GLB can be structurally perfect and
 * still yield zero geometry, and a wall-free collider is the one failure mode
 * the path generator cannot detect for itself.
 *
 * three.js is imported dynamically so nothing that only wants the API client
 * pays for it.
 */

import type * as THREE from 'three';

import { MarbleError } from './errors';

export type LoaderVerification = {
  meshes: number;
  triangles: number;
  meshNames: string[];
};

/**
 * Parse with GLTFLoader and count triangles. Throws MarbleError on a parse
 * failure or on geometry that is present-but-empty.
 */
export async function verifyColliderWithLoader(
  bytes: Uint8Array,
): Promise<LoaderVerification> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

  // GLTFLoader.parse wants a standalone ArrayBuffer; slicing detaches it from
  // whatever pooled buffer the read produced. Same dance as path-lab.ts.
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const scene = await new Promise<THREE.Object3D>((resolvePromise, reject) => {
    try {
      new GLTFLoader().parse(
        arrayBuffer,
        '',
        (gltf) => resolvePromise(gltf.scene),
        (error) => reject(error),
      );
    } catch (error) {
      reject(error);
    }
  }).catch((cause: unknown) => {
    throw new MarbleError({
      kind: 'asset-invalid',
      message: 'GLTFLoader could not parse collider.glb.',
      hint:
        'The container passed the structural check but the loader the app uses ' +
        'rejects it, so the plan screen would fail to load the walls.',
      cause,
    });
  });

  let meshes = 0;
  let triangles = 0;
  const meshNames: string[] = [];

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes += 1;
    meshNames.push(mesh.name || '(unnamed)');
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    const vertices = index ? index.count : (position?.count ?? 0);
    triangles += Math.floor(vertices / 3);
  });

  if (meshes === 0 || triangles === 0) {
    throw new MarbleError({
      kind: 'asset-invalid',
      message: `collider.glb parsed but yielded ${meshes} meshes / ${triangles} triangles.`,
      hint:
        'An empty collider is indistinguishable from open space downstream: the ' +
        'walk grid would contain no obstacles and the camera would fly through walls.',
    });
  }

  return { meshes, triangles, meshNames };
}

/**
 * Cheap header check for a downloaded splat.
 *
 * SPZ is a gzip container; scripts/spz-collider.mjs gunzips it and expects the
 * inner magic 'NGSP' (0x5053474e little-endian). Accepting either the gzip
 * envelope or a bare NGSP header keeps this from being brittle about
 * compression while still catching the common disaster — an HTML error page or
 * a JSON error body saved as room.spz.
 */
export function assertLooksLikeSpz(bytes: Uint8Array, path: string): void {
  if (bytes.byteLength === 0) {
    throw new MarbleError({
      kind: 'asset-invalid',
      message: `Splat file is zero bytes: ${path}`,
    });
  }
  if (bytes.byteLength < 4) {
    throw new MarbleError({
      kind: 'asset-invalid',
      message: `Splat file is ${bytes.byteLength} bytes: ${path}`,
    });
  }

  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const isRawSpz = view.getUint32(0, true) === 0x5053474e;

  if (!isGzip && !isRawSpz) {
    const head = Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join(' ');
    throw new MarbleError({
      kind: 'asset-invalid',
      message: `Downloaded splat is neither gzip nor raw SPZ: ${path}`,
      hint: `first bytes: ${head}. An error page was probably saved instead of the asset.`,
    });
  }
}
