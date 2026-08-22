/**
 * SPZ v2 utilities.
 *
 *   node scripts/spz-tools.mjs info       <in.spz>
 *   node scripts/spz-tools.mjs downsample <in.spz> <out.spz> <targetCount>
 *
 * SPZ v2 is gzip around a 16-byte header followed by flat per-attribute blocks:
 *   positions  numPoints * 9   (3 axes x 24-bit fixed point, fractionalBits scale)
 *   alphas     numPoints * 1
 *   colors     numPoints * 3
 *   scales     numPoints * 3
 *   rotations  numPoints * 3
 *   sh         numPoints * shDim * 3     (shDim = 0 for shDegree 0)
 * Because each attribute is its own contiguous block, subsampling is an exact
 * per-block gather - no requantisation, no quality loss beyond dropped splats.
 */
import { readFileSync, writeFileSync, createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH_DIM = { 0: 0, 1: 3, 2: 8, 3: 15 };
const HEADER = 16;

function parseHeader(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x5053474e) throw new Error(`bad magic 0x${magic.toString(16)} (expected NGSP)`);
  return {
    version: buf.readUInt32LE(4),
    numPoints: buf.readUInt32LE(8),
    shDegree: buf.readUInt8(12),
    fractionalBits: buf.readUInt8(13),
    flags: buf.readUInt8(14),
    reserved: buf.readUInt8(15),
  };
}

function blockSpec(h) {
  const shDim = SH_DIM[h.shDegree];
  if (shDim === undefined) throw new Error(`unsupported shDegree ${h.shDegree}`);
  return [
    { name: 'positions', stride: 9 },
    { name: 'alphas',    stride: 1 },
    { name: 'colors',    stride: 3 },
    { name: 'scales',    stride: 3 },
    { name: 'rotations', stride: 3 },
    { name: 'sh',        stride: shDim * 3 },
  ].filter((b) => b.stride > 0);
}

async function gunzipToTmp(inPath) {
  const tmp = join(tmpdir(), `spz-${process.pid}.bin`);
  await pipeline(createReadStream(inPath), createGunzip(), createWriteStream(tmp));
  return tmp;
}

function readPos(buf, off, i, scale) {
  const o = off + i * 9;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const b = o + k * 3;
    let v = buf[b] | (buf[b + 1] << 8) | (buf[b + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    out[k] = v * scale;
  }
  return out;
}

const [, , cmd, inPath, outPath, targetArg] = process.argv;
if (!cmd || !inPath) {
  console.error('usage: spz-tools.mjs info <in.spz> | downsample <in.spz> <out.spz> <count>');
  process.exit(1);
}

const tmp = await gunzipToTmp(inPath);
const raw = readFileSync(tmp);
const h = parseHeader(raw);
const blocks = blockSpec(h);
const perSplat = blocks.reduce((s, b) => s + b.stride, 0);
const expected = HEADER + h.numPoints * perSplat;

// byte offset of each block in the decompressed payload
let cursor = HEADER;
for (const b of blocks) { b.offset = cursor; cursor += h.numPoints * b.stride; }

console.log(`version ${h.version}  points ${h.numPoints.toLocaleString()}  shDegree ${h.shDegree}  ` +
            `fracBits ${h.fractionalBits}  flags ${h.flags}`);
console.log(`packed ${raw.length.toLocaleString()} B, expected ${expected.toLocaleString()} B  ` +
            `${raw.length === expected ? 'OK' : 'LAYOUT MISMATCH'}`);
if (raw.length !== expected) { unlinkSync(tmp); process.exit(1); }

if (cmd === 'info') {
  const scale = 1 / (1 << h.fractionalBits);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const pOff = blocks[0].offset;
  for (let i = 0; i < h.numPoints; i++) {
    const p = readPos(raw, pOff, i, scale);
    for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
  }
  console.log('bounds min', mn.map((v) => v.toFixed(2)).join(', '));
  console.log('bounds max', mx.map((v) => v.toFixed(2)).join(', '));
  console.log('extent    ', mx.map((v, i) => (v - mn[i]).toFixed(2)).join(', '));
  unlinkSync(tmp);
  process.exit(0);
}

if (cmd === 'downsample') {
  const target = Math.min(Number(targetArg), h.numPoints);
  if (!outPath || !Number.isFinite(target) || target < 1) {
    console.error('downsample needs <out.spz> and a positive <count>');
    process.exit(1);
  }
  // Evenly spaced gather across the whole file - splats are not spatially
  // ordered, so a uniform stride is an unbiased spatial sample.
  const idx = new Uint32Array(target);
  for (let i = 0; i < target; i++) idx[i] = Math.floor((i * h.numPoints) / target);

  const out = Buffer.alloc(HEADER + target * perSplat);
  raw.copy(out, 0, 0, HEADER);
  out.writeUInt32LE(target, 8);

  let w = HEADER;
  for (const b of blocks) {
    for (let i = 0; i < target; i++) {
      raw.copy(out, w, b.offset + idx[i] * b.stride, b.offset + (idx[i] + 1) * b.stride);
      w += b.stride;
    }
  }

  const gzTmp = join(tmpdir(), `spz-out-${process.pid}.bin`);
  writeFileSync(gzTmp, out);
  await pipeline(createReadStream(gzTmp), createGzip({ level: 6 }), createWriteStream(outPath));
  unlinkSync(gzTmp);
  unlinkSync(tmp);

  console.log(`wrote ${outPath}: ${target.toLocaleString()} splats ` +
              `(${(100 * target / h.numPoints).toFixed(1)}% of source), ` +
              `${(statSync(outPath).size / 1e6).toFixed(1)} MB gzipped`);
}
