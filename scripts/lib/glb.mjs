/**
 * Minimal glTF 2.0 binary writer.
 *
 * Shared by the fixture generator and the splat-derived collider tool. Emits
 * one node + mesh per part with POSITION and NORMAL, which is all the loaders
 * in this project read.
 */
import { writeFileSync } from 'node:fs';

/* ---------------------------------- glb io ---------------------------------- */
export function pad4(n) { return (4 - (n % 4)) % 4; }

/** Writes a minimal glTF 2.0 binary: one node+mesh per part. */
export function writeGlb(path, parts, baseColor = [0.8, 0.8, 0.82, 1]) {
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

