/**
 * Measuring an uploaded splat without loading it.
 *
 * The alignment in align.ts needs three facts about the file — how many splats,
 * how big the room is, and how the mass divides top to bottom — and a splat
 * file is up to two thirds of a gigabyte. Decoding one in the route handler
 * would mean holding the whole decompressed cloud in the dev server's heap for
 * a number that fits on one line.
 *
 * So this reads the file as a stream and keeps a fixed-size sample. Positions
 * are picked at an even stride across the whole cloud, which is what makes the
 * percentile box meaningful: a prefix of a splat file is not a sample of a room,
 * because both writers here emit splats in training order, not spatial order.
 *
 * Memory is bounded by SAMPLE_TARGET regardless of file size. Nothing is
 * written, and the source stream is abandoned as soon as the last byte of
 * interest goes past — an SPZ keeps its positions and opacities in the first
 * two sections, so a 500 MB file with 3rd-order spherical harmonics stops
 * decompressing about a fifth of the way in.
 *
 * SERVER ONLY: node:fs and node:zlib.
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

import type { Vec3 } from '@/lib/types';
import type { AxisProfile, Extent, SplatScan } from './align';

/** Splats kept for the percentile box and the profile. ~3 MB of Float32. */
const SAMPLE_TARGET = 250_000;

/** Bins per axis. Even, so `uprightEvidence` splits it without a middle. */
export const PROFILE_BINS = 32;

/**
 * Fraction trimmed off each end of each axis for the robust box.
 *
 * A capture's extremes are floaters — splats behind walls, blobs of sky pulled
 * in through a window, the reconstruction's opinion of the space outside. They
 * are a small share of the cloud and they can be tens of metres out, so a raw
 * AABB is not a room's size. 1% at each end keeps the walls (which hold a lot
 * of splats) and drops the haze.
 */
const TRIM = 0.01;

/** Below this a splat contributes nothing visible, so it is not evidence. */
const MIN_ALPHA = 0.06;

export class SplatScanError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'SplatScanError';
    this.hint = hint;
  }
}

/* -------------------------------------------------------------------------- */
/* the sample                                                                 */
/* -------------------------------------------------------------------------- */

type Sample = {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  alpha: Float32Array;
  count: number;
};

function createSample(capacity: number): Sample {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    alpha: new Float32Array(capacity),
    count: 0,
  };
}

/** Every `stride`-th splat, so the sample spans the file rather than its start. */
function strideFor(count: number): number {
  return Math.max(1, Math.floor(count / SAMPLE_TARGET));
}

/* -------------------------------------------------------------------------- */
/* the byte cursor                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pull fixed-size records at known absolute offsets out of a byte stream.
 *
 * Both formats here are "header, then an array of fixed-size records", and the
 * records we want are a sparse arithmetic sequence through that array. This
 * walks the stream once, copying only the bytes of a record that happens to
 * straddle a chunk boundary — so the carry buffer is never larger than one
 * record and the bytes in between are dropped as they arrive.
 */
type Target = { offset: number; size: number };

async function readTargets(
  stream: AsyncIterable<Buffer>,
  nextTarget: () => Target | null,
  consume: (record: Buffer) => void,
): Promise<void> {
  let target = nextTarget();
  if (!target) return;

  /* Invariant: `base` is the absolute offset of carry[0], and the next chunk to
     arrive begins at base + carry.length. Everything below preserves it. */
  let carry: Buffer = Buffer.alloc(0);
  let base = 0;

  for await (const chunk of stream) {
    const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;

    while (target) {
      const relative = target.offset - base;
      if (relative + target.size > buffer.length) break;
      consume(buffer.subarray(relative, relative + target.size));
      target = nextTarget();
    }

    if (!target) return;

    // Keep only from the next record's first byte. When that record is still
    // far ahead this keeps nothing at all, which is the common case.
    const keepFrom = Math.max(0, Math.min(buffer.length, target.offset - base));
    carry = buffer.subarray(keepFrom);
    base += keepFrom;
  }

  if (target) {
    throw new SplatScanError(
      'The splat file ended in the middle of its own point data.',
      'It is truncated — the upload or the export it came from did not finish.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* SPZ                                                                        */
/* -------------------------------------------------------------------------- */

/** 'NGSP', little-endian. Matches scripts/lib/spz-read.mjs. */
const SPZ_MAGIC = 0x5053474e;
const SPZ_HEADER_BYTES = 16;
const SPZ_POSITION_BYTES = 9;

async function scanSpz(path: string): Promise<{ count: number; sample: Sample }> {
  const gunzip = createGunzip();
  const file = createReadStream(path);
  file.on('error', (error) => gunzip.destroy(error));
  file.pipe(gunzip);

  let count = 0;
  let stride = 1;
  let sample = createSample(0);
  let positionsWanted = 0;
  let alphaOffset = 0;

  // Three sections in one pass: the header, then the sampled position records,
  // then the same splats' opacity bytes. Alpha sits directly after the whole
  // position block, so it is still a forward walk.
  let phase: 'header' | 'positions' | 'alpha' | 'done' = 'header';
  let emitted = 0;

  const nextTarget = (): Target | null => {
    if (phase === 'header') return { offset: 0, size: SPZ_HEADER_BYTES };
    if (phase === 'positions') {
      if (emitted >= positionsWanted) {
        phase = 'alpha';
        emitted = 0;
        return nextTarget();
      }
      return {
        offset: SPZ_HEADER_BYTES + emitted * stride * SPZ_POSITION_BYTES,
        size: SPZ_POSITION_BYTES,
      };
    }
    if (phase === 'alpha') {
      if (emitted >= positionsWanted) {
        phase = 'done';
        return null;
      }
      return { offset: alphaOffset + emitted * stride, size: 1 };
    }
    return null;
  };

  let positionScale = 1;

  const consume = (record: Buffer): void => {
    if (phase === 'header') {
      if (record.readUInt32LE(0) !== SPZ_MAGIC) {
        throw new SplatScanError(
          'The .spz file does not start with the SPZ magic number.',
          'It decompressed, so it is a gzip of something else — check that this is the ' +
            'splat and not, say, a compressed collider.',
        );
      }
      count = record.readUInt32LE(8);
      if (count <= 0) {
        throw new SplatScanError('The .spz header declares zero splats.');
      }
      const fractionalBits = record.readUInt8(13);
      positionScale = 1 / (1 << fractionalBits);
      stride = strideFor(count);
      positionsWanted = Math.ceil(count / stride);
      sample = createSample(positionsWanted);
      alphaOffset = SPZ_HEADER_BYTES + count * SPZ_POSITION_BYTES;
      phase = 'positions';
      emitted = 0;
      return;
    }

    if (phase === 'positions') {
      const i = sample.count;
      sample.x[i] = decodeFixed24(record, 0) * positionScale;
      sample.y[i] = decodeFixed24(record, 3) * positionScale;
      sample.z[i] = decodeFixed24(record, 6) * positionScale;
      sample.count += 1;
      emitted += 1;
      return;
    }

    sample.alpha[emitted] = record[0] / 255;
    emitted += 1;
  };

  try {
    await readTargets(gunzip as AsyncIterable<Buffer>, nextTarget, consume);
  } catch (error) {
    if (error instanceof SplatScanError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SplatScanError(`The .spz file could not be decompressed: ${message}`, 'SPZ is a gzip container; this one does not unpack.');
  } finally {
    gunzip.destroy();
    file.destroy();
  }

  if (sample.count === 0) {
    throw new SplatScanError('No splat positions could be read from the .spz file.');
  }
  return { count, sample };
}

/** 24-bit little-endian two's complement, as SPZ stores each coordinate. */
function decodeFixed24(record: Buffer, at: number): number {
  let value = record[at] | (record[at + 1] << 8) | (record[at + 2] << 16);
  if (value & 0x800000) value -= 0x1000000;
  return value;
}

/* -------------------------------------------------------------------------- */
/* PLY                                                                        */
/* -------------------------------------------------------------------------- */

const PLY_TYPE_BYTES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};

type PlyProperty = { name: string; type: string; offset: number };

type PlyHeader = {
  format: 'binary_little_endian' | 'binary_big_endian' | 'ascii';
  headerBytes: number;
  vertexCount: number;
  vertexOffset: number;
  vertexStride: number;
  properties: Map<string, PlyProperty>;
  /** Column index per property, for the ascii body. */
  order: string[];
};

/** The header is ASCII and short; read enough of the file to be sure of it. */
const PLY_HEADER_PROBE_BYTES = 64 * 1024;

async function readPlyHeader(path: string): Promise<PlyHeader> {
  const chunks: Buffer[] = [];
  let read = 0;
  for await (const chunk of createReadStream(path, { end: PLY_HEADER_PROBE_BYTES - 1 })) {
    chunks.push(chunk as Buffer);
    read += (chunk as Buffer).length;
    if (read >= PLY_HEADER_PROBE_BYTES) break;
  }
  const head = Buffer.concat(chunks);
  const text = head.toString('latin1');
  const terminator = text.indexOf('end_header');
  if (!text.startsWith('ply')) {
    throw new SplatScanError(
      'The .ply file does not begin with a PLY header.',
      'The first bytes are not "ply", so this is some other format with a .ply name.',
    );
  }
  if (terminator === -1) {
    throw new SplatScanError('The .ply header does not end within the first 64 KB.');
  }
  const newline = text.indexOf('\n', terminator);
  const headerBytes = newline + 1;
  const lines = text.slice(0, terminator).split(/\r?\n/);

  let format: PlyHeader['format'] | null = null;
  let vertexCount = 0;
  let vertexOffset = headerBytes;
  let vertexStride = 0;
  const properties = new Map<string, PlyProperty>();
  const order: string[] = [];

  /** Elements declared before `vertex`; their bytes sit in front of it. */
  let currentElement: string | null = null;
  const elementCounts: { name: string; count: number; bytes: number }[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      const declared = parts[1];
      if (declared !== 'binary_little_endian' && declared !== 'ascii' && declared !== 'binary_big_endian') {
        throw new SplatScanError(`Unsupported PLY format "${declared}".`);
      }
      format = declared;
    } else if (parts[0] === 'element') {
      currentElement = parts[1];
      elementCounts.push({ name: parts[1], count: Number(parts[2]) || 0, bytes: 0 });
    } else if (parts[0] === 'property') {
      if (parts[1] === 'list') {
        if (currentElement === 'vertex') {
          throw new SplatScanError(
            'This .ply declares a list property on its vertices, which no splat format uses.',
          );
        }
        // A list makes the preceding element's size unknowable without reading
        // it, and we only need to skip past it. Only fatal if it comes first.
        elementCounts[elementCounts.length - 1].bytes = Number.NaN;
        continue;
      }
      const size = PLY_TYPE_BYTES[parts[1]];
      if (size === undefined) throw new SplatScanError(`Unknown PLY property type "${parts[1]}".`);
      const element = elementCounts[elementCounts.length - 1];
      if (currentElement === 'vertex') {
        properties.set(parts[2], { name: parts[2], type: parts[1], offset: vertexStride });
        order.push(parts[2]);
        vertexStride += size;
      }
      element.bytes += size;
    }
  }

  if (!format) throw new SplatScanError('The .ply header declares no format line.');
  if (format === 'binary_big_endian') {
    throw new SplatScanError(
      'This .ply is big-endian, which nothing in the 3DGS toolchain writes.',
      'Re-export it as binary_little_endian.',
    );
  }

  const vertexIndex = elementCounts.findIndex((element) => element.name === 'vertex');
  if (vertexIndex === -1) throw new SplatScanError('The .ply declares no vertex element.');
  vertexCount = elementCounts[vertexIndex].count;
  if (vertexCount <= 0) throw new SplatScanError('The .ply declares zero vertices.');

  for (const element of elementCounts.slice(0, vertexIndex)) {
    if (!Number.isFinite(element.bytes)) {
      throw new SplatScanError(
        `The .ply puts a variable-size "${element.name}" element in front of its vertices.`,
        'Where the vertex data starts cannot be computed without reading the whole file.',
      );
    }
    vertexOffset += element.bytes * element.count;
  }

  for (const axis of ['x', 'y', 'z']) {
    if (!properties.has(axis)) {
      throw new SplatScanError(`The .ply vertices have no "${axis}" property.`);
    }
  }

  return { format, headerBytes, vertexCount, vertexOffset, vertexStride, properties, order };
}

function readPlyValue(record: Buffer, property: PlyProperty): number {
  switch (property.type) {
    case 'char':
    case 'int8':
      return record.readInt8(property.offset);
    case 'uchar':
    case 'uint8':
      return record.readUInt8(property.offset);
    case 'short':
    case 'int16':
      return record.readInt16LE(property.offset);
    case 'ushort':
    case 'uint16':
      return record.readUInt16LE(property.offset);
    case 'int':
    case 'int32':
      return record.readInt32LE(property.offset);
    case 'uint':
    case 'uint32':
      return record.readUInt32LE(property.offset);
    case 'double':
    case 'float64':
      return record.readDoubleLE(property.offset);
    default:
      return record.readFloatLE(property.offset);
  }
}

/** Whichever opacity property this writer used, or null when it stated none. */
function opacityProperty(header: PlyHeader): PlyProperty | null {
  return header.properties.get('opacity') ?? header.properties.get('alpha') ?? null;
}

async function scanPlyBinary(
  path: string,
  header: PlyHeader,
): Promise<{ count: number; sample: Sample }> {
  const stride = strideFor(header.vertexCount);
  const wanted = Math.ceil(header.vertexCount / stride);
  const sample = createSample(wanted);

  // readPlyHeader has already refused a file without all three.
  const x = header.properties.get('x') as PlyProperty;
  const y = header.properties.get('y') as PlyProperty;
  const z = header.properties.get('z') as PlyProperty;
  const opacity = opacityProperty(header);

  let emitted = 0;
  const nextTarget = (): Target | null =>
    emitted >= wanted
      ? null
      : {
          offset: header.vertexOffset + emitted * stride * header.vertexStride,
          size: header.vertexStride,
        };

  const stream = createReadStream(path);
  try {
    await readTargets(stream as unknown as AsyncIterable<Buffer>, nextTarget, (record) => {
      const i = sample.count;
      sample.x[i] = readPlyValue(record, x);
      sample.y[i] = readPlyValue(record, y);
      sample.z[i] = readPlyValue(record, z);
      sample.alpha[i] = opacity ? readPlyValue(record, opacity) : 1;
      sample.count += 1;
      emitted += 1;
    });
  } finally {
    stream.destroy();
  }

  normaliseOpacity(sample, opacity);
  return { count: header.vertexCount, sample };
}

async function scanPlyAscii(
  path: string,
  header: PlyHeader,
): Promise<{ count: number; sample: Sample }> {
  const stride = strideFor(header.vertexCount);
  const wanted = Math.ceil(header.vertexCount / stride);
  const sample = createSample(wanted);

  const xCol = header.order.indexOf('x');
  const yCol = header.order.indexOf('y');
  const zCol = header.order.indexOf('z');
  const opacity = opacityProperty(header);
  const alphaCol = opacity ? header.order.indexOf(opacity.name) : -1;

  const stream = createReadStream(path, { start: header.headerBytes, encoding: 'latin1' });
  let pending = '';
  let row = 0;
  try {
    for await (const chunk of stream) {
      pending += chunk as string;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (row >= header.vertexCount || sample.count >= wanted) break;
        const take = row % stride === 0;
        row += 1;
        if (!take) continue;
        const fields = line.trim().split(/\s+/);
        if (fields.length < header.order.length) continue;
        const i = sample.count;
        sample.x[i] = Number(fields[xCol]);
        sample.y[i] = Number(fields[yCol]);
        sample.z[i] = Number(fields[zCol]);
        sample.alpha[i] = alphaCol === -1 ? 1 : Number(fields[alphaCol]);
        sample.count += 1;
      }
      if (sample.count >= wanted) break;
    }
  } finally {
    stream.destroy();
  }

  if (sample.count === 0) {
    throw new SplatScanError('No vertices could be read from the ascii .ply body.');
  }
  normaliseOpacity(sample, opacity);
  return { count: header.vertexCount, sample };
}

/**
 * Turn whatever the file called opacity into a 0..1 alpha.
 *
 * 3DGS trainers store opacity in logit space, so the column runs roughly -6 to
 * +10 and a sigmoid is the documented way back. A plain point cloud stores a
 * uchar 0..255, and a few writers store a straight float 0..1. The three are
 * told apart by the range that actually turned up rather than by the property
 * name, because the name is `opacity` in all three.
 */
function normaliseOpacity(sample: Sample, property: PlyProperty | null): void {
  if (!property) {
    sample.alpha.fill(1, 0, sample.count);
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < sample.count; i += 1) {
    const value = sample.alpha[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min < 0 || max > 1.001) {
    const byteRange = max > 1.001 && min >= 0 && max <= 255.001;
    for (let i = 0; i < sample.count; i += 1) {
      sample.alpha[i] = byteRange
        ? sample.alpha[i] / 255
        : 1 / (1 + Math.exp(-sample.alpha[i]));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* reduction                                                                  */
/* -------------------------------------------------------------------------- */

function percentileBounds(sample: Sample, visible: Int32Array): Extent {
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  const min: number[] = [];
  const max: number[] = [];

  for (const axis of axes) {
    const source = sample[axis];
    const values = new Float64Array(visible.length);
    for (let i = 0; i < visible.length; i += 1) values[i] = source[visible[i]];
    values.sort();
    const low = Math.floor(values.length * TRIM);
    const high = Math.max(low, Math.ceil(values.length * (1 - TRIM)) - 1);
    min.push(values[low]);
    max.push(values[high]);
  }

  return { min: min as Vec3, max: max as Vec3 };
}

function rawBounds(sample: Sample): Extent {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < sample.count; i += 1) {
    if (sample.x[i] < minX) minX = sample.x[i];
    if (sample.y[i] < minY) minY = sample.y[i];
    if (sample.z[i] < minZ) minZ = sample.z[i];
    if (sample.x[i] > maxX) maxX = sample.x[i];
    if (sample.y[i] > maxY) maxY = sample.y[i];
    if (sample.z[i] > maxZ) maxZ = sample.z[i];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Opacity-weighted mass per bin, over the robust box.
 *
 * Weighted rather than counted because the question this answers is "where is
 * the room's substance", and a thousand near-transparent floaters under the
 * floor are not substance. Splats outside the box are left out entirely rather
 * than clamped into the end bins, which would put every floater in the very
 * bin the up/down test reads.
 */
function buildProfile(sample: Sample, bounds: Extent): AxisProfile {
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  const profile: AxisProfile = {
    x: new Array<number>(PROFILE_BINS).fill(0),
    y: new Array<number>(PROFILE_BINS).fill(0),
    z: new Array<number>(PROFILE_BINS).fill(0),
  };

  axes.forEach((axis, dimension) => {
    const low = bounds.min[dimension];
    const span = bounds.max[dimension] - low;
    if (!(span > 0)) return;
    const source = sample[axis];
    const bins = profile[axis];
    for (let i = 0; i < sample.count; i += 1) {
      const t = (source[i] - low) / span;
      if (t < 0 || t > 1) continue;
      const bin = Math.min(PROFILE_BINS - 1, Math.floor(t * PROFILE_BINS));
      bins[bin] += sample.alpha[i];
    }
  });

  return profile;
}

/** Sample indices worth measuring: the ones that are actually visible. */
function visibleIndices(sample: Sample): Int32Array {
  const kept: number[] = [];
  for (let i = 0; i < sample.count; i += 1) {
    if (sample.alpha[i] >= MIN_ALPHA) kept.push(i);
  }
  // A file whose opacities we misread would otherwise measure an empty room.
  // Falling back to every splat is worse evidence, never no evidence.
  if (kept.length < sample.count * 0.25) {
    return Int32Array.from({ length: sample.count }, (_, i) => i);
  }
  return Int32Array.from(kept);
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a splat file on disk to the numbers align.ts needs.
 *
 * `kind` comes from the filename, which is all the app knows before it opens
 * the file; a mismatch surfaces as a SplatScanError naming what the bytes
 * actually were.
 */
export async function scanSplat(path: string, kind: 'spz' | 'ply'): Promise<SplatScan> {
  const { count, sample } =
    kind === 'spz'
      ? await scanSpz(path)
      : await (async () => {
          const header = await readPlyHeader(path);
          return header.format === 'ascii'
            ? scanPlyAscii(path, header)
            : scanPlyBinary(path, header);
        })();

  const visible = visibleIndices(sample);
  const bounds = percentileBounds(sample, visible);

  if (!Number.isFinite(bounds.min[0]) || !Number.isFinite(bounds.max[1])) {
    throw new SplatScanError('The splat positions read back as NaN.', 'The file is corrupt.');
  }

  return {
    format: kind,
    splatCount: count,
    sampled: sample.count,
    bounds,
    rawBounds: rawBounds(sample),
    profile: buildProfile(sample, bounds),
  };
}
