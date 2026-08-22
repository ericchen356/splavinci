/**
 * SPZ v1-v3 reader: positions, opacity and scale.
 *
 * Splat files carry no mesh and no collision data - only Gaussians. Anything
 * that wants to know where a wall is has to reconstruct it from the density
 * those Gaussians describe, and density needs more than positions: a haze of
 * tiny transparent floaters and a solid wall look identical if you only count
 * splat centres. So opacity and scale come out of here too.
 *
 * Encodings confirmed against Spark's own SpzReader:
 *   position  24-bit fixed point, / (1 << fractionalBits)
 *   alpha     byte / 255
 *   scale     exp(byte / 16 - 10)   (world-space sigma, per axis)
 */
import { createReadStream, createWriteStream, readFileSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH_DIM = { 0: 0, 1: 3, 2: 8, 3: 15 };

export async function readSpz(path, { flipYDown = true } = {}) {
  const tmp = join(tmpdir(), `spzread-${process.pid}-${Math.abs(path.length)}.bin`);
  await pipeline(createReadStream(path), createGunzip(), createWriteStream(tmp));
  const raw = readFileSync(tmp);

  if (raw.readUInt32LE(0) !== 0x5053474e) throw new Error(`${path}: not an SPZ file`);
  const version = raw.readUInt32LE(4);
  const n = raw.readUInt32LE(8);
  const shDegree = raw.readUInt8(12);
  const fractionalBits = raw.readUInt8(13);
  const shDim = SH_DIM[shDegree];
  if (shDim === undefined) throw new Error(`unsupported shDegree ${shDegree}`);

  const HEADER = 16;
  const posOff = HEADER;
  const alphaOff = posOff + n * 9;
  const colorOff = alphaOff + n * 1;
  const scaleOff = colorOff + n * 3;
  const expected = scaleOff + n * 3 + n * 3 + n * shDim * 3;
  if (raw.length !== expected) {
    throw new Error(`${path}: layout mismatch (${raw.length} vs ${expected})`);
  }

  const scale = 1 / (1 << fractionalBits);
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const Z = new Float32Array(n);
  const A = new Float32Array(n);
  // One horizontal sigma per splat: the larger of the two ground-plane axes,
  // which is what determines how much floor area the Gaussian actually covers.
  const S = new Float32Array(n);

  const rd = (b) => {
    let v = raw[b] | (raw[b + 1] << 8) | (raw[b + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v * scale;
  };

  const flip = flipYDown ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const o = posOff + i * 9;
    X[i] = rd(o);
    Y[i] = flip * rd(o + 3);
    Z[i] = flip * rd(o + 6);
    A[i] = raw[alphaOff + i] / 255;
    const s = scaleOff + i * 3;
    const sx = Math.exp(raw[s] / 16 - 10);
    const sy = Math.exp(raw[s + 1] / 16 - 10);
    const sz = Math.exp(raw[s + 2] / 16 - 10);
    S[i] = Math.max(sx, sz);
    // sy is kept out of S deliberately - vertical extent does not widen a
    // splat's floor footprint, and folding it in fattens thin wall panels.
    void sy;
  }

  unlinkSync(tmp);
  return { n, version, shDegree, fractionalBits, X, Y, Z, A, S };
}

/**
 * Otsu's method: the threshold that best separates a histogram into two
 * classes by maximising between-class variance.
 *
 * Used instead of a hand-tuned "this fraction of splats means wall" constant.
 * That constant only ever suits the capture it was tuned on; free space and
 * solid surface are genuinely bimodal in density, so the split can be found
 * from the data itself and transfers to captures we have not seen.
 */
export function otsuThreshold(values, bins = 256) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return hi;

  const hist = new Float64Array(bins);
  const span = hi - lo;
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - lo) / span) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    hist[b]++;
    total++;
  }
  if (total === 0) return hi;

  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];

  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = b; }
  }
  return lo + ((best + 0.5) / bins) * span;
}
