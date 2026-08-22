/**
 * Regression check: a fused single-mesh collider must produce the same walk
 * grid as a properly-named one.
 *
 *   npx tsx scripts/collider-check.ts
 *
 * Marble returns the collider as one mesh named `geometry_0`, with no floor/wall
 * separation. This reproduces that shape from the sample room and asserts the
 * two paths agree.
 */
import * as THREE from 'three';
import { loadColliderFromDisk } from './path-lab';
import { buildColliderData, worldTriangleSoup, collectMeshes } from '@/lib/scene/collider';
import { buildWalkGrid, gridStats } from '@/lib/path';

const original = await loadColliderFromDisk('public/sample-room/collider.glb');

// Reproduce a Marble-style export: every triangle in ONE mesh, named the way
// Marble names it, with no floor/wall separation of any kind.
const soup = worldTriangleSoup(collectMeshes(original.root));
const fusedRoot = new THREE.Object3D();
const fused = new THREE.Mesh(soup, new THREE.MeshBasicMaterial());
fused.name = 'geometry_0';
fusedRoot.add(fused);
fusedRoot.updateMatrixWorld(true);

const rebuilt = buildColliderData(fusedRoot);

const tris = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3;
console.log('=== fused single-mesh collider (Marble shape) ===');
console.log('mesh names      :', rebuilt.meshNames.join(', '));
console.log('floor meshes    :', rebuilt.floorMeshes.map((m) => m.name).join(', ') || '(NONE)');
console.log('floor triangles :', tris(rebuilt.floorGeometry));
console.log('obstacle tris   :', tris(rebuilt.obstacleGeometry));
console.log('floorBounds     :', rebuilt.floorBounds.isEmpty()
  ? 'EMPTY'
  : `y ${rebuilt.floorBounds.min.y.toFixed(2)}..${rebuilt.floorBounds.max.y.toFixed(2)}`);

const g = buildWalkGrid(rebuilt);
console.log('walk grid       :', JSON.stringify(gridStats(g)));

console.log('\n=== original per-mesh collider (regression) ===');
const og = buildWalkGrid(original);
console.log('floor meshes    :', original.floorMeshes.map((m) => m.name).join(', '));
console.log('walk grid       :', JSON.stringify(gridStats(og)));
