/**
 * Headless regression check for the path generator.
 *
 *   npx tsx scripts/path-check.ts
 *
 * Exercises the whole chain against the real collider and manifest: grid,
 * A*, smoothing, shot inference, incremental recompute, and the ambiguous
 * cases that must warn rather than fail silently.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadColliderFromDisk } from './path-lab';
import { generatePath, createPathCache, type ShotObject } from '@/lib/path';
import type { PathSettings, SceneObject, Vec3, Waypoint } from '@/lib/types';

const collider = await loadColliderFromDisk('public/sample-room/collider.glb');
const manifest: SceneObject[] = JSON.parse(readFileSync('public/sample-room/objects.json', 'utf8'));
const loader = new GLTFLoader();
const objects: ShotObject[] = [];
for (const spec of manifest) {
  const buf = readFileSync('public' + spec.meshUrl);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gltf = await new Promise<any>((res, rej) => loader.parse(ab, '', res, rej));
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(gltf.scene).getSize(size);
  objects.push({ id: spec.id, position: spec.position, label: spec.label, size: [size.x, size.y, size.z] as Vec3 });
}

const wp = (id: string, x: number, z: number, extra: Partial<Waypoint> = {}): Waypoint => ({
  id, position: [x, 0, z], targetObjectId: null, shotType: 'orbit',
  controlSpectrum: 0, duration: 4, pinned: false, ...extra,
});

const waypoints: Waypoint[] = [
  wp('w1', 3.0, 2.2),
  wp('w2', 4.4, 5.2),
  wp('w3', 1.6, 7.0),
  wp('w4', 8.2, 4.0),
  wp('w5', 8.4, 1.8),
];
const settings: PathSettings = { style: 'realEstate' };
const cache = createPathCache();

const r = generatePath({ collider, waypoints, settings, objects }, cache);
console.log(`frames ${r.frames.length}  duration ${r.duration}s  fps ${r.fps}`);
console.log(`grid ${r.stats.gridCols}x${r.stats.gridRows} @ ${r.stats.cellSize.toFixed(4)}m  ` +
            `gridMs ${r.stats.gridMs}  generateMs ${r.stats.generateMs}`);
console.log(`segments ${r.segments.length}  recomputed ${r.stats.recomputedSegments}  reused ${r.stats.reusedSegments}`);
console.log('\nshots:');
for (const s of r.shots) console.log(`  ${s.waypointId}  ${s.shotType.padEnd(13)} ${s.duration.toFixed(1)}s  int ${s.intensity.toFixed(2)}  [${s.source}]  ${s.reason}`);
console.log('\nsegments:');
for (const s of r.segments) console.log(`  ${s.startTime.toFixed(2)}-${s.endTime.toFixed(2)}s  ${s.kind.padEnd(6)} ${s.id.padEnd(22)} active=${s.waypointId} frames=${s.frameCount} reused=${s.reused}`);
console.log('\nwarnings:', r.warnings.length);
for (const w of r.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

// monotonic time check
let bad = 0;
for (let i = 1; i < r.frames.length; i++) if (r.frames[i].timeSeconds < r.frames[i-1].timeSeconds) bad++;
console.log(`\nmonotonic timeSeconds: ${bad === 0 ? 'OK' : bad + ' REGRESSIONS'}`);
const ids = new Set(r.frames.map(f => f.activeWaypointId));
console.log('activeWaypointIds present:', [...ids].join(', '));

/* ---------------- incremental recompute ---------------- */
console.log('\n=== incremental recompute ===');
const r2 = generatePath({ collider, waypoints, settings, objects }, cache);
console.log(`regenerate, nothing changed : recomputed ${r2.stats.recomputedSegments}  reused ${r2.stats.reusedSegments}  (${r2.stats.generateMs}ms)`);

const moved = waypoints.map((w) =>
  w.id === 'w3' ? { ...w, position: [2.4, 0, 6.4] as Vec3, pinned: true } : w);
const r3 = generatePath({ collider, waypoints: moved, settings, objects }, cache);
console.log(`drag w3 (pinned)            : recomputed ${r3.stats.recomputedSegments}  reused ${r3.stats.reusedSegments}  (${r3.stats.generateMs}ms)`);
console.log('  recomputed legs:', r3.segments.filter(s => s.kind === 'travel' && !s.reused).map(s => s.id).join(', ') || '(none)');
console.log('  reused legs    :', r3.segments.filter(s => s.kind === 'travel' && s.reused).map(s => s.id).join(', ') || '(none)');

const unpinned = moved.map((w) => ({ ...w, pinned: false }));
const r4 = generatePath({ collider, waypoints: unpinned, settings, objects }, cache);
console.log(`same again, unpinned        : recomputed ${r4.stats.recomputedSegments}  reused ${r4.stats.reusedSegments}  (${r4.stats.generateMs}ms)`);

const restyled = generatePath({ collider, waypoints: unpinned, settings: { style: 'cinematic' }, objects }, cache);
console.log(`change style to cinematic   : recomputed ${restyled.stats.recomputedSegments}  reused ${restyled.stats.reusedSegments}  duration ${restyled.duration}s`);

/* ---------------- unreachable ---------------- */
console.log('\n=== ambiguous cases ===');
const sealed: Waypoint[] = [wp('a', 3.0, 2.2), wp('b', 0.1, 0.1)];
const rs = generatePath({ collider, waypoints: sealed, settings, objects }, createPathCache());
for (const w of rs.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
console.log(`  still produced ${rs.frames.length} frames, ${rs.duration}s (coherent timeline, flagged)`);

const single = generatePath({ collider, waypoints: [wp('only', 3, 2.2)], settings, objects }, createPathCache());
for (const w of single.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);

const none = generatePath({ collider, waypoints: [], settings, objects }, createPathCache());
for (const w of none.warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
