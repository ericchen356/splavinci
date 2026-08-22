/**
 * Generates the *input* fixtures the app assumes already exist:
 *   public/sample-room/collider.glb   - walkable-space collision mesh
 *   public/sample-room/objects.json   - manifest of individually meshed objects
 *   public/sample-room/meshes/*.glb   - one mesh per manifest entry
 *   public/sample-room/room.ply       - Gaussian splat stand-in for room.spz
 *
 * This is NOT the capture/reconstruction pipeline - it just fabricates a
 * plausible apartment so the app has something real to load. Drop a genuine
 * room.spz / collider.glb / objects.json in the same folder to replace it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'sample-room');
mkdirSync(join(OUT, 'meshes'), { recursive: true });

/* ----------------------------- deterministic rng ----------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260821);

/* --------------------------------- geometry --------------------------------- */
// Axis-aligned box -> 24 verts (4 per face, flat normals) + 36 indices.
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    { n: [0, 0, 1],  v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] }, // +z
    { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] }, // -z
    { n: [1, 0, 0],  v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] }, // +x
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] }, // -x
    { n: [0, 1, 0],  v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] }, // +y
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] }, // -y
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach((f, fi) => {
    f.v.forEach((v) => { positions.push(...v); normals.push(...f.n); });
    const b = fi * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions, normals, indices };
}

function mergeParts(parts) {
  const positions = [], normals = [], indices = [];
  for (const p of parts) {
    const off = positions.length / 3;
    positions.push(...p.positions);
    normals.push(...p.normals);
    for (const i of p.indices) indices.push(i + off);
  }
  return { positions, normals, indices };
}

/* ---------------------------------- glb io ---------------------------------- */
function pad4(n) { return (4 - (n % 4)) % 4; }

/** Writes a minimal glTF 2.0 binary: one node+mesh per part. */
function writeGlb(path, parts, baseColor = [0.8, 0.8, 0.82, 1]) {
  const bufferViews = [], accessors = [], meshes = [], nodes = [];
  const chunks = [];
  let byteOffset = 0;

  const pushView = (buf, target) => {
    const padding = pad4(byteOffset);
    if (padding) { chunks.push(Buffer.alloc(padding)); byteOffset += padding; }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target });
    chunks.push(buf);
    byteOffset += buf.length;
    return bufferViews.length - 1;
  };

  parts.forEach((part, i) => {
    const pos = Float32Array.from(part.positions);
    const nor = Float32Array.from(part.normals);
    const idx = Uint32Array.from(part.indices);

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pos.length; v += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], pos[v + c]);
        max[c] = Math.max(max[c], pos[v + c]);
      }
    }

    const posView = pushView(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength), 34962);
    const norView = pushView(Buffer.from(nor.buffer, nor.byteOffset, nor.byteLength), 34962);
    const idxView = pushView(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength), 34963);

    accessors.push({ bufferView: posView, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: norView, componentType: 5126, count: nor.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: idxView, componentType: 5125, count: idx.length, type: 'SCALAR' });

    const a = i * 3;
    meshes.push({
      name: part.name ?? `part_${i}`,
      primitives: [{ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: 0 }],
    });
    nodes.push({ mesh: i, name: part.name ?? `part_${i}` });
  });

  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'splavinci make-fixtures' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: [{
      name: 'fixture',
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: 0.9 },
    }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (pad4(json.length)) json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);
  const binPad = pad4(bin.length) ? Buffer.concat([bin, Buffer.alloc(pad4(bin.length))]) : bin;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binPad.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPad.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  writeFileSync(path, Buffer.concat([header, jsonHeader, json, binHeader, binPad]));
  return 12 + 8 + json.length + 8 + binPad.length;
}

/* --------------------------------- the room --------------------------------- */
// A two-zone apartment. The interior partition has a single doorway, and the
// kitchen nook is reachable only through a gap - so routing between zones is a
// real pathfinding problem, not a straight line.
const WALL_H = 2.7;
const T = 0.2; // wall thickness

const WALLS = [
  { name: 'wall_south',     min: [0.0, 0, 0.0], max: [10.0, WALL_H, T] },
  { name: 'wall_north',     min: [0.0, 0, 7.8], max: [10.0, WALL_H, 8.0] },
  { name: 'wall_west',      min: [0.0, 0, 0.0], max: [T, WALL_H, 8.0] },
  { name: 'wall_east',      min: [9.8, 0, 0.0], max: [10.0, WALL_H, 8.0] },
  // interior partition, split around a doorway at z in [3.2, 4.4]
  { name: 'partition_s',    min: [6.0, 0, 0.0], max: [6.2, WALL_H, 3.2] },
  { name: 'partition_n',    min: [6.0, 0, 4.4], max: [6.2, WALL_H, 8.0] },
  // kitchen nook divider, open from x = 3.0 eastward
  { name: 'nook_divider',   min: [0.0, 0, 4.6], max: [3.0, WALL_H, 4.8] },
];

const FLOOR = { name: 'floor', min: [0, -0.1, 0], max: [10, 0, 8] };

const OBJECTS = [
  { id: 'sofa',            label: 'Sofa',            min: [1.1, 0, 1.15], max: [2.05, 0.85, 3.25], color: [0.35, 0.42, 0.52] },
  { id: 'coffee-table',    label: 'Coffee table',    min: [2.45, 0, 1.90], max: [3.55, 0.45, 2.50], color: [0.45, 0.32, 0.22] },
  { id: 'tv',              label: 'Wall TV',         min: [5.85, 0.8, 1.55], max: [5.98, 1.55, 2.85], color: [0.09, 0.09, 0.11] },
  { id: 'plant',           label: 'Fiddle-leaf fig', min: [5.10, 0, 5.30], max: [5.70, 1.10, 5.90], color: [0.24, 0.45, 0.26] },
  { id: 'dining-table',    label: 'Dining table',    min: [3.60, 0, 5.95], max: [5.20, 0.75, 6.85], color: [0.52, 0.38, 0.25] },
  { id: 'kitchen-counter', label: 'Kitchen counter', min: [0.30, 0, 6.85], max: [2.70, 0.90, 7.55], color: [0.78, 0.76, 0.72] },
  { id: 'bed',             label: 'Bed',             min: [7.25, 0, 0.95], max: [9.15, 0.55, 3.05], color: [0.80, 0.74, 0.66] },
  { id: 'nightstand',      label: 'Nightstand',      min: [9.20, 0, 3.30], max: [9.65, 0.55, 3.75], color: [0.42, 0.30, 0.21] },
  { id: 'desk',            label: 'Desk',            min: [6.35, 0, 6.30], max: [7.65, 0.75, 6.90], color: [0.48, 0.35, 0.24] },
  { id: 'wardrobe',        label: 'Wardrobe',        min: [8.85, 0, 5.30], max: [9.55, 2.10, 7.10], color: [0.30, 0.24, 0.20] },
];

const center = (o) => [
  +((o.min[0] + o.max[0]) / 2).toFixed(3),
  +((o.min[1] + o.max[1]) / 2).toFixed(3),
  +((o.min[2] + o.max[2]) / 2).toFixed(3),
];

/* -------------------------------- collider.glb -------------------------------- */
{
  const parts = [FLOOR, ...WALLS].map((w) => ({ name: w.name, ...box(w.min, w.max) }));
  const bytes = writeGlb(join(OUT, 'collider.glb'), parts, [0.6, 0.65, 0.75, 1]);
  console.log(`collider.glb            ${parts.length} parts, ${bytes} bytes`);
}

/* ------------------------------ object meshes -------------------------------- */
// Each object mesh is authored around its own origin; the manifest carries the
// world position, so the loader places it rather than baking it into the mesh.
const manifest = [];
for (const o of OBJECTS) {
  const c = center(o);
  const local = box(
    [o.min[0] - c[0], o.min[1] - c[1], o.min[2] - c[2]],
    [o.max[0] - c[0], o.max[1] - c[1], o.max[2] - c[2]],
  );
  writeGlb(join(OUT, 'meshes', `${o.id}.glb`), [{ name: o.id, ...local }], [...o.color, 1]);
  manifest.push({
    id: o.id,
    meshUrl: `/sample-room/meshes/${o.id}.glb`,
    position: c,
    label: o.label,
  });
}
writeFileSync(join(OUT, 'objects.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`objects.json            ${manifest.length} objects`);

/* --------------------------- room.ply (splat stand-in) ------------------------ */
// Standard INRIA 3DGS binary PLY, SH degree 0. Spark loads .ply directly, so
// this stands in for room.spz until a real capture is dropped in.
const SH_C0 = 0.28209479177387814;
const logit = (a) => Math.log(a / (1 - a));

const splats = [];
function emit(x, y, z, r, g, b, scale) {
  splats.push([x, y, z, r, g, b, scale]);
}

/** Scatter splats over an axis-aligned rectangle in the given plane. */
function scatterRect(axis, fixed, u0, u1, v0, v1, color, density, scale, jitter = 0.012) {
  const n = Math.max(1, Math.round(Math.abs(u1 - u0) * Math.abs(v1 - v0) * density));
  for (let i = 0; i < n; i++) {
    const u = u0 + rand() * (u1 - u0);
    const v = v0 + rand() * (v1 - v0);
    const f = fixed + (rand() - 0.5) * jitter;
    const shade = 0.86 + rand() * 0.28;
    const [r, g, b] = color;
    if (axis === 'y') emit(u, f, v, r * shade, g * shade, b * shade, scale);
    else if (axis === 'x') emit(f, v, u, r * shade, g * shade, b * shade, scale);
    else emit(u, v, f, r * shade, g * shade, b * shade, scale);
  }
}

/** Scatter over the 5 visible faces of a box (skips the underside). */
function scatterBox(min, max, color, density, scale) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  scatterRect('y', y1, x0, x1, z0, z1, color, density, scale);          // top
  scatterRect('z', z0, x0, x1, y0, y1, color, density, scale);          // -z
  scatterRect('z', z1, x0, x1, y0, y1, color, density, scale);          // +z
  scatterRect('x', x0, z0, z1, y0, y1, color, density, scale);          // -x
  scatterRect('x', x1, z0, z1, y0, y1, color, density, scale);          // +x
}

const FLOOR_COLOR = [0.60, 0.46, 0.33];
const WALL_COLOR = [0.87, 0.86, 0.83];

scatterRect('y', 0, 0.2, 9.8, 0.2, 7.8, FLOOR_COLOR, 150, 0.032, 0.006);
for (const w of WALLS) {
  const [x0, , z0] = w.min, [x1, , z1] = w.max;
  // only the two long faces of each wall carry splats - the caps are slivers
  if (x1 - x0 > z1 - z0) {
    scatterRect('z', z0, x0, x1, 0, WALL_H, WALL_COLOR, 120, 0.030);
    scatterRect('z', z1, x0, x1, 0, WALL_H, WALL_COLOR, 120, 0.030);
  } else {
    scatterRect('x', x0, z0, z1, 0, WALL_H, WALL_COLOR, 120, 0.030);
    scatterRect('x', x1, z0, z1, 0, WALL_H, WALL_COLOR, 120, 0.030);
  }
}
for (const o of OBJECTS) scatterBox(o.min, o.max, o.color, 420, 0.020);

{
  const N = splats.length;
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${N}\n` +
    ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
     'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
      .map((p) => `property float ${p}\n`).join('') +
    'end_header\n';

  const STRIDE = 17;
  const body = Buffer.alloc(N * STRIDE * 4);
  splats.forEach(([x, y, z, r, g, b, s], i) => {
    const o = i * STRIDE * 4;
    const f = [
      x, y, z,
      0, 0, 0,
      (r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0,
      logit(0.96),
      Math.log(s), Math.log(s), Math.log(s),
      1, 0, 0, 0,
    ];
    for (let k = 0; k < STRIDE; k++) body.writeFloatLE(f[k], o + k * 4);
  });

  writeFileSync(join(OUT, 'room.ply'), Buffer.concat([Buffer.from(header, 'ascii'), body]));
  console.log(`room.ply                ${N} splats, ${((header.length + body.length) / 1e6).toFixed(2)} MB`);
}
