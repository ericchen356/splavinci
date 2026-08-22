/**
 * GLB integrity check for the collider.
 *
 * collider.glb is the only description of where the walls are. The path
 * generator rasterises a walk grid straight out of its triangles, so a file
 * that is empty, truncated, or actually an HTML error page saved with a .glb
 * name does not degrade the flythrough — it produces a grid with no obstacles
 * in it, and the camera glides through solid walls with nothing anywhere in the
 * pipeline able to notice. That failure is silent and downstream, which is why
 * every check here throws instead of warning.
 *
 * This is a structural parse, not a full glTF validation: header, chunk table,
 * JSON syntax, and the buffer arithmetic that a truncated transfer breaks. It
 * deliberately does not need three.js, so it can run before anything heavy is
 * loaded. `verifyColliderWithLoader` in verify.ts adds the real GLTFLoader pass
 * on top.
 *
 * Format reference: glTF 2.0 spec, section 4.4 (GLB container). Matches the
 * writer this repo already ships at scripts/lib/glb.mjs.
 */

import { MarbleError } from './errors';

/** 'glTF' little-endian. Same constant scripts/lib/glb.mjs writes. */
const MAGIC_GLTF = 0x46546c67;
/** 'JSON' little-endian. */
const CHUNK_JSON = 0x4e4f534a;
/** 'BIN\0' little-endian. */
const CHUNK_BIN = 0x004e4942;

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

export type GlbInspection = {
  byteLength: number;
  version: number;
  jsonChunkBytes: number;
  binChunkBytes: number;
  meshCount: number;
  primitiveCount: number;
  nodeCount: number;
  accessorCount: number;
  /** Mesh names in file order, for a log line the operator can sanity-check. */
  meshNames: string[];
};

function invalid(message: string, hint?: string, detail?: unknown): MarbleError {
  return new MarbleError({ kind: 'asset-invalid', message, hint, detail });
}

/** What the first bytes look like, so a wrong-content download is obvious. */
function describeHead(bytes: Uint8Array): string {
  const head = bytes.subarray(0, Math.min(16, bytes.length));
  const hex = Array.from(head, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = Array.from(head, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  return `first bytes: ${hex}  ("${ascii}")`;
}

/** Guesses what actually got downloaded when it is not a GLB. */
function guessContent(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64)).trim();
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.startsWith('<?xml')) {
    return 'The file is markup — an error or redirect page was saved instead of the asset.';
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return `The file is JSON, probably an API error body: ${text.slice(0, 120)}`;
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'The file is gzip. It may need decompressing, or the wrong URL was fetched.';
  }
  return null;
}

/**
 * Parse and structurally validate a GLB. Throws MarbleError('asset-invalid')
 * with a specific reason; returns counts on success.
 */
export function inspectGlb(bytes: Uint8Array): GlbInspection {
  if (bytes.byteLength === 0) {
    throw invalid(
      'Collider file is zero bytes.',
      'The transfer produced nothing. Re-run the download; do not use this file.',
    );
  }
  if (bytes.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) {
    throw invalid(
      `Collider file is ${bytes.byteLength} bytes, too short to be a GLB header.`,
      describeHead(bytes),
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== MAGIC_GLTF) {
    const guess = guessContent(bytes);
    throw invalid(
      'Collider file is not a GLB: missing the "glTF" magic number.',
      [guess, describeHead(bytes)].filter(Boolean).join(' '),
    );
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw invalid(`Collider GLB declares container version ${version}; only 2 is supported.`);
  }

  const declared = view.getUint32(8, true);
  if (declared > bytes.byteLength) {
    throw invalid(
      `Collider GLB is truncated: header declares ${declared} bytes, file holds ${bytes.byteLength}.`,
      'The download was cut short. Delete the file and fetch it again.',
    );
  }
  if (declared < bytes.byteLength) {
    throw invalid(
      `Collider GLB has ${bytes.byteLength - declared} trailing bytes beyond the ${declared} it declares.`,
      'The file does not match its own header, so it cannot be trusted as the wall source.',
    );
  }

  let offset = HEADER_BYTES;
  let json: Record<string, unknown> | null = null;
  let jsonChunkBytes = 0;
  let binChunkBytes = 0;
  let chunkIndex = 0;

  while (offset + CHUNK_HEADER_BYTES <= declared) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + CHUNK_HEADER_BYTES;

    if (dataStart + chunkLength > declared) {
      throw invalid(
        `Collider GLB chunk ${chunkIndex} claims ${chunkLength} bytes but only ` +
          `${declared - dataStart} remain — the file is truncated.`,
      );
    }
    // The spec requires 4-byte alignment; a violation means a mangled writer or
    // a corrupted transfer, and every offset after it would be wrong.
    if (chunkLength % 4 !== 0) {
      throw invalid(
        `Collider GLB chunk ${chunkIndex} length ${chunkLength} is not 4-byte aligned.`,
      );
    }

    if (chunkIndex === 0 && chunkType !== CHUNK_JSON) {
      throw invalid('Collider GLB does not start with a JSON chunk.');
    }

    if (chunkType === CHUNK_JSON) {
      jsonChunkBytes = chunkLength;
      if (chunkLength === 0) throw invalid('Collider GLB has an empty JSON chunk.');
      const text = new TextDecoder('utf-8').decode(bytes.subarray(dataStart, dataStart + chunkLength));
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch (cause) {
        throw new MarbleError({
          kind: 'asset-invalid',
          message: 'Collider GLB JSON chunk is not valid JSON.',
          hint: 'The file is corrupt, not merely unexpected.',
          cause,
        });
      }
    } else if (chunkType === CHUNK_BIN) {
      binChunkBytes = chunkLength;
    }

    offset = dataStart + chunkLength;
    chunkIndex += 1;
  }

  if (offset !== declared) {
    throw invalid(
      `Collider GLB chunk table ends at ${offset} but the file declares ${declared} bytes.`,
    );
  }
  if (!json) throw invalid('Collider GLB contains no JSON chunk.');

  return inspectGltfJson(json, { jsonChunkBytes, binChunkBytes, byteLength: bytes.byteLength, version });
}

type ChunkFacts = {
  jsonChunkBytes: number;
  binChunkBytes: number;
  byteLength: number;
  version: number;
};

type GltfArrays = {
  meshes?: { name?: string; primitives?: { attributes?: Record<string, number> }[] }[];
  nodes?: unknown[];
  accessors?: unknown[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[];
  buffers?: { uri?: string; byteLength?: number }[];
  asset?: { version?: string };
};

function inspectGltfJson(json: Record<string, unknown>, facts: ChunkFacts): GlbInspection {
  const doc = json as GltfArrays;

  const assetVersion = doc.asset?.version;
  if (typeof assetVersion !== 'string' || !assetVersion.startsWith('2')) {
    throw invalid(
      `Collider GLB declares glTF asset version ${JSON.stringify(assetVersion)}; expected 2.x.`,
    );
  }

  const meshes = Array.isArray(doc.meshes) ? doc.meshes : [];
  if (meshes.length === 0) {
    throw invalid(
      'Collider GLB contains no meshes.',
      'A collider with no geometry produces a walk grid with no walls in it, and ' +
        'the path generator would route the camera straight through the house.',
    );
  }

  let primitiveCount = 0;
  let positioned = 0;
  const meshNames: string[] = [];
  meshes.forEach((mesh, i) => {
    meshNames.push(typeof mesh.name === 'string' && mesh.name ? mesh.name : `mesh_${i}`);
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    primitiveCount += primitives.length;
    for (const primitive of primitives) {
      if (typeof primitive.attributes?.POSITION === 'number') positioned += 1;
    }
  });

  if (primitiveCount === 0) {
    throw invalid('Collider GLB has meshes but no primitives.');
  }
  if (positioned === 0) {
    throw invalid(
      'No collider primitive declares a POSITION attribute.',
      'Without vertex positions there is nothing to rasterise a walk grid from.',
    );
  }

  // Buffer arithmetic catches the truncation the header alone can hide: a GLB
  // whose header was written before the BIN chunk was fully flushed still has a
  // consistent chunk table but cannot satisfy its own bufferViews.
  const buffers = Array.isArray(doc.buffers) ? doc.buffers : [];
  const embedded = buffers[0];
  if (embedded && embedded.uri === undefined) {
    const need = embedded.byteLength ?? 0;
    if (facts.binChunkBytes === 0) {
      throw invalid(
        `Collider GLB references a ${need}-byte embedded buffer but carries no BIN chunk.`,
      );
    }
    if (need > facts.binChunkBytes) {
      throw invalid(
        `Collider GLB buffer needs ${need} bytes, BIN chunk holds ${facts.binChunkBytes}.`,
        'The binary payload is short — the download did not complete.',
      );
    }
  }

  const bufferViews = Array.isArray(doc.bufferViews) ? doc.bufferViews : [];
  bufferViews.forEach((viewSpec, i) => {
    const bufferIndex = viewSpec.buffer ?? 0;
    const buffer = buffers[bufferIndex];
    if (!buffer) {
      throw invalid(`Collider GLB bufferView ${i} points at missing buffer ${bufferIndex}.`);
    }
    const end = (viewSpec.byteOffset ?? 0) + (viewSpec.byteLength ?? 0);
    if (buffer.byteLength !== undefined && end > buffer.byteLength) {
      throw invalid(
        `Collider GLB bufferView ${i} ends at ${end}, past the ${buffer.byteLength}-byte buffer.`,
      );
    }
  });

  return {
    byteLength: facts.byteLength,
    version: facts.version,
    jsonChunkBytes: facts.jsonChunkBytes,
    binChunkBytes: facts.binChunkBytes,
    meshCount: meshes.length,
    primitiveCount,
    nodeCount: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
    accessorCount: Array.isArray(doc.accessors) ? doc.accessors.length : 0,
    meshNames,
  };
}
