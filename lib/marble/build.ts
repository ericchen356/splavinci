/**
 * STAGE 2 — environment-builder.
 *
 * Composed prompt + photos in; room.spz and collider.glb on disk out. See
 * .claude/agents/environment-builder.md.
 *
 * The hard rule from that spec shapes the end of this file: collider.glb is the
 * only source of truth for where the walls are, so it is downloaded to a
 * temporary path, verified, and only then moved into place. Nothing here
 * reports success on a collider it has not parsed.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import {
  DEFAULT_MODEL,
  MAX_IMAGES_DEFAULT,
  type MarbleModel,
  type MarbleWorld,
  type MediaReference,
  type SplatPlacementValues,
  type WorldAssets,
  type WorldSemanticsMetadata,
  type WorldsGenerateRequest,
  buildWorldPrompt,
  listSpzUrls,
  pickSpzUrl,
  placementFromSemantics,
  readColliderUrl,
  readWorld,
  readWorldId,
} from './api';
import { MarbleClient, type Logger, type MarbleClientOptions, type WaitOptions } from './client';
import { MarbleError } from './errors';
import { inspectGlb, type GlbInspection } from './glb';
import { assertLooksLikeSpz, verifyColliderWithLoader, type LoaderVerification } from './verify';

export type ImageDelivery = 'upload' | 'inline';

export type EnvironmentInput = {
  composedPrompt: string;
  images: string[];
};

export type EnvironmentBuildOptions = {
  /** Parent of the per-capture folder. Defaults to <cwd>/public/generated. */
  outDir?: string;
  /** Folder name and AssetSet id. Defaults to a timestamped slug. */
  setId?: string;
  model?: MarbleModel;
  displayName?: string;
  tags?: string[];
  seed?: number | null;
  /** Per-photo bearing in degrees, aligned to `images`. null = unknown. */
  azimuths?: (number | null)[];
  /**
   * How local photos reach Marble. `upload` is the flow the docs prescribe for
   * local files; `inline` base64s them into the request, which the docs only
   * recommend for small files.
   */
  imageDelivery?: ImageDelivery;
  /** Density key, or 'all' to keep every density Marble returns. */
  spz?: string;
  disableRecaption?: boolean;
  reconstructImages?: boolean;
  /** Run GLTFLoader over the collider as well as the structural check. */
  deepVerify?: boolean;
  /** Anything the caller wants recorded in scene.json (intake provenance). */
  provenance?: Record<string, unknown>;
  client?: MarbleClient;
  clientOptions?: MarbleClientOptions;
  wait?: WaitOptions;
  log?: Logger;
  signal?: AbortSignal;
  /** Attach to a generation already in flight instead of starting a new one. */
  resumeOperationId?: string;
  /** Re-download an already finished world. Skips generation entirely. */
  worldId?: string;
};

export type DownloadedAsset = {
  /** Path relative to the capture directory. */
  file: string;
  url: string;
  bytes: number;
  sha256: string;
};

export type SplatAsset = DownloadedAsset & { spzKey: string };

export type ColliderAsset = DownloadedAsset & {
  inspection: GlbInspection;
  loader: LoaderVerification | null;
};

export type EnvironmentBuildResult = {
  setId: string;
  dir: string;
  operationId: string | null;
  worldId: string;
  worldMarbleUrl: string | null;
  model: string | null;
  caption: string | null;
  splat: SplatAsset;
  /** Extra densities, when `spz: 'all'`. */
  extraSplats: SplatAsset[];
  collider: ColliderAsset;
  semantics: WorldSemanticsMetadata | null;
  placement: SplatPlacementValues;
  scenePath: string;
};

const SPLAT_FILE = 'room.spz';
const COLLIDER_FILE = 'collider.glb';
const SCENE_FILE = 'scene.json';

/** `file_name` is capped at 64 characters by the media-asset schema. */
const MAX_UPLOAD_NAME = 64;

/** Mirrors FLOOR_NAME in lib/scene/collider.ts; used only for the advisory. */
const FLOOR_NAME_CONVENTION = /^(floor|ground|walkable)/i;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function defaultSetId(displayName?: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const base = displayName ? slugify(displayName) : '';
  return base ? `${base}-${stamp}` : `marble-${stamp}`;
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

/**
 * Asset URLs come back pre-signed, so the query string is a short-lived
 * credential. scene.json is written under public/ and is very likely to be
 * committed, so only the origin and path are recorded.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

/* -------------------------------------------------------------------------- */
/* photo delivery                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Turn local photo paths into Marble media references.
 *
 * Both paths send the file's bytes exactly as they are on disk — intake
 * promised the photos pass through unmodified, and base64 is a transport
 * encoding, not an edit.
 */
async function deliverPhotos(
  client: MarbleClient,
  images: string[],
  delivery: ImageDelivery,
  log: Logger,
  signal?: AbortSignal,
): Promise<MediaReference[]> {
  const references: MediaReference[] = [];

  for (const path of images) {
    const bytes = await readFile(path);
    const extension = extensionOf(path);

    if (delivery === 'inline') {
      log(`inlining ${basename(path)} (${bytes.byteLength} bytes, base64)`);
      references.push({
        source: 'data_base64',
        data_base64: bytes.toString('base64'),
        extension,
      });
      continue;
    }

    const fileName = basename(path).slice(-MAX_UPLOAD_NAME);
    log(`uploading ${fileName} (${bytes.byteLength} bytes)`);
    const prepared = await client.prepareUpload(
      { file_name: fileName, kind: 'image', extension },
      signal,
    );
    await client.uploadBytes(prepared.upload_info, bytes, signal);
    references.push({
      source: 'media_asset',
      media_asset_id: prepared.media_asset.media_asset_id,
    });
  }

  return references;
}

/* -------------------------------------------------------------------------- */
/* asset resolution                                                           */
/* -------------------------------------------------------------------------- */

function requireAssets(world: MarbleWorld | null, worldId: string): WorldAssets {
  const assets = world?.assets;
  if (!assets) {
    throw new MarbleError({
      kind: 'asset-missing',
      message: `World ${worldId} completed without an assets block.`,
      hint: `Inspect it with GET /marble/v1/worlds/${worldId}, or open https://marble.worldlabs.ai/world/${worldId}.`,
    });
  }
  return assets;
}

/* -------------------------------------------------------------------------- */
/* download + verify                                                          */
/* -------------------------------------------------------------------------- */

type FetchedFile = { path: string; bytes: number; sha256: string };

/**
 * Download to `name.part`, hand it to `verify`, and only then move it onto the
 * real name. A failed verify leaves nothing behind that a later run — or the
 * plan screen — could mistake for a good asset.
 */
async function fetchVerified<T>(
  client: MarbleClient,
  url: string,
  dir: string,
  name: string,
  verify: (path: string) => Promise<T>,
  log: Logger,
  signal?: AbortSignal,
): Promise<FetchedFile & { verification: T }> {
  const finalPath = join(dir, name);
  const partPath = `${finalPath}.part`;
  await rm(partPath, { force: true });

  let lastPercent = -1;
  let bytes: number;
  let sha256: string;
  let verification: T;

  try {
    ({ bytes, sha256 } = await client.downloadToFile(url, partPath, {
      signal,
      onProgress: (received, total) => {
        if (!total) return;
        const percent = Math.floor((received / total) * 10) * 10;
        if (percent !== lastPercent) {
          lastPercent = percent;
          log(`  ${name} ${percent}%`);
        }
      },
    }));
    verification = await verify(partPath);
  } catch (error) {
    // Never leave a partial or unverified file behind, under any name.
    await rm(partPath, { force: true });
    throw error;
  }

  await rename(partPath, finalPath);
  log(`  ${name} ${bytes} bytes  sha256 ${sha256.slice(0, 16)}`);
  return { path: finalPath, bytes, sha256, verification };
}

/** First bytes of a file, without reading a 300 MB splat into memory. */
async function readHead(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/* -------------------------------------------------------------------------- */
/* stage 2                                                                    */
/* -------------------------------------------------------------------------- */

export async function buildEnvironment(
  input: EnvironmentInput,
  options: EnvironmentBuildOptions = {},
): Promise<EnvironmentBuildResult> {
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const client = options.client ?? new MarbleClient({ log, ...options.clientOptions });

  const setId = options.setId ?? defaultSetId(options.displayName);
  const parentDir = options.outDir
    ? resolve(options.outDir)
    : resolve(process.cwd(), 'public', 'generated');
  const dir = join(parentDir, setId);

  /* ------------------------------- generate ------------------------------ */

  let operationId: string | null = options.resumeOperationId ?? null;
  let world: MarbleWorld | null = null;

  if (options.worldId) {
    log(`fetching existing world ${options.worldId}`);
    world = await client.getWorld(options.worldId, signal);
  } else {
    if (!operationId) {
      if (input.images.length === 0) {
        throw new MarbleError({
          kind: 'input',
          message: 'environment-builder needs at least one photo.',
        });
      }

      const references = await deliverPhotos(
        client,
        input.images,
        options.imageDelivery ?? 'upload',
        log,
        signal,
      );

      const worldPrompt = buildWorldPrompt({
        composedPrompt: input.composedPrompt,
        references,
        azimuths: options.azimuths,
        disableRecaption: options.disableRecaption,
        reconstructImages: options.reconstructImages,
      });

      const request: WorldsGenerateRequest = {
        world_prompt: worldPrompt,
        model: options.model ?? DEFAULT_MODEL,
        ...(options.displayName ? { display_name: options.displayName.slice(0, 64) } : {}),
        ...(options.tags?.length ? { tags: options.tags.slice(0, 10) } : {}),
        ...(options.seed === undefined || options.seed === null ? {} : { seed: options.seed }),
      };

      log(
        `starting ${worldPrompt.type} generation with ${input.images.length} photo(s) ` +
          `on ${request.model}` +
          (references.length > MAX_IMAGES_DEFAULT ? ' (reconstruction mode)' : ''),
      );
      const started = await client.generateWorld(request, signal);
      operationId = started.operation_id;
      log(`operation ${operationId}`);
    } else {
      log(`resuming operation ${operationId}`);
    }

    const finishedOp = await client.waitForOperation(operationId, { ...options.wait, signal });
    world = readWorld(finishedOp.response);

    // The operation snapshot is documented as possibly partial. If it did not
    // carry assets, ask for the authoritative world.
    if (!world?.assets) {
      const id = readWorldId(world) ?? readOperationWorldId(finishedOp.metadata);
      if (!id) {
        throw new MarbleError({
          kind: 'asset-missing',
          message: `Operation ${operationId} finished but carried no world id.`,
          detail: finishedOp.response ?? finishedOp.metadata,
        });
      }
      log(`operation snapshot had no assets; fetching world ${id}`);
      world = await client.getWorld(id, signal);
    }
  }

  const worldId = readWorldId(world) ?? options.worldId ?? '';
  if (!worldId) {
    throw new MarbleError({
      kind: 'asset-missing',
      message: 'Could not determine the generated world id.',
      detail: world,
    });
  }

  const assets = requireAssets(world, worldId);

  /* ------------------------------- resolve ------------------------------- */

  const wantAll = options.spz === 'all';
  const primary = pickSpzUrl(assets, wantAll ? undefined : options.spz);
  if (!primary) {
    throw new MarbleError({
      kind: 'asset-missing',
      message:
        options.spz && !wantAll
          ? `World ${worldId} has no SPZ density "${options.spz}".`
          : `World ${worldId} returned no SPZ URLs.`,
      detail: assets.splats?.spz_urls ?? null,
      hint: `Available densities: ${listSpzUrls(assets).map((s) => s.key).join(', ') || 'none'}`,
    });
  }

  const colliderUrl = readColliderUrl(assets);
  if (!colliderUrl) {
    throw new MarbleError({
      kind: 'asset-missing',
      message: `World ${worldId} returned no collider_mesh_url.`,
      hint:
        'The collider is the only description of where the walls are; without it the ' +
        'path generator cannot keep the camera inside the house. Refusing to write a ' +
        'half-built capture.',
      detail: assets.mesh ?? null,
    });
  }

  /* ------------------------------ download ------------------------------- */

  await mkdir(dir, { recursive: true });
  log(`writing to ${relative(process.cwd(), dir) || dir}`);

  // Collider first, deliberately. It is a few megabytes against a splat that can
  // be hundreds, and it is the asset that can fail the whole stage — no reason
  // to spend ten minutes on a download before finding out the walls are missing.
  //
  // Structural parse always; GLTFLoader unless explicitly skipped. Both throw,
  // so a bad collider never reaches the final filename.
  const colliderFile = await fetchVerified(
    client,
    colliderUrl,
    dir,
    COLLIDER_FILE,
    async (path): Promise<{ inspection: GlbInspection; loader: LoaderVerification | null }> => {
      const bytes = await readFile(path);
      const inspection = inspectGlb(bytes);
      const loader = options.deepVerify === false ? null : await verifyColliderWithLoader(bytes);
      return { inspection, loader };
    },
    log,
    signal,
  );

  const verified = colliderFile.verification.inspection;
  const loaded = colliderFile.verification.loader;

  log(
    `  collider: ${verified.meshCount} mesh(es), ${verified.primitiveCount} primitive(s)` +
      (loaded ? `, ${loaded.triangles} triangles via GLTFLoader` : ' (loader check skipped)'),
  );

  // Marble ships the collider as one fused mesh (the public example exports are
  // a single node called `geometry_0`). lib/scene/collider.ts splits floor from
  // obstacles by name first and by shape second, and a single whole-scene mesh
  // satisfies neither test - it classifies as all-obstacle with empty floor
  // bounds, which leaves the walk grid with nothing walkable in it. Worth
  // saying out loud here, because the symptom appears three stages later.
  if (!verified.meshNames.some((name) => FLOOR_NAME_CONVENTION.test(name))) {
    log(
      `  note: no collider mesh is named floor/ground/walkable ` +
        `(${verified.meshNames.join(', ')}). classifyColliderMeshes falls back to a ` +
        `shape heuristic, and a single fused mesh yields zero floor meshes. Check ` +
        `the walk grid with: npx tsx scripts/path-lab.ts ${join(dir, COLLIDER_FILE)}`,
    );
  }

  const splatFile = await fetchVerified(
    client,
    primary.url,
    dir,
    SPLAT_FILE,
    async (path) => assertLooksLikeSpz(await readHead(path, 8), path),
    log,
    signal,
  );

  const extraSplats: SplatAsset[] = [];
  if (wantAll) {
    for (const choice of listSpzUrls(assets)) {
      if (choice.key === primary.key) continue;
      const name = `room-${slugify(choice.key)}.spz`;
      const fetched = await fetchVerified(
        client,
        choice.url,
        dir,
        name,
        async (path) => assertLooksLikeSpz(await readHead(path, 8), path),
        log,
        signal,
      );
      extraSplats.push({
        file: name,
        url: choice.url,
        bytes: fetched.bytes,
        sha256: fetched.sha256,
        spzKey: choice.key,
      });
    }
  }

  /* ------------------------------ scene.json ----------------------------- */

  const semantics = assets.splats?.semantics_metadata ?? null;
  const placement = placementFromSemantics(semantics);

  const splat: SplatAsset = {
    file: SPLAT_FILE,
    url: primary.url,
    bytes: splatFile.bytes,
    sha256: splatFile.sha256,
    spzKey: primary.key,
  };

  const collider: ColliderAsset = {
    file: COLLIDER_FILE,
    url: colliderUrl,
    bytes: colliderFile.bytes,
    sha256: colliderFile.sha256,
    inspection: verified,
    loader: loaded,
  };

  const scenePath = join(dir, SCENE_FILE);
  await writeFile(
    scenePath,
    `${JSON.stringify(
      {
        source: 'world-labs-marble',
        generator: 'scripts/marble-generate.ts',
        generatedAt: new Date().toISOString(),
        world: {
          id: worldId,
          marbleUrl: world?.world_marble_url ?? null,
          model: world?.model ?? options.model ?? DEFAULT_MODEL,
          caption: assets.caption ?? null,
          operationId,
        },
        prompt: input.composedPrompt,
        provenance: options.provenance ?? null,
        // Derived from semantics_metadata; see placementFromSemantics for the
        // three documented steps this folds into one three.js transform.
        splatTransform: {
          rotation: placement.rotation,
          position: placement.position,
          scale: placement.scale,
        },
        semanticsMetadata: semantics,
        colliderFrameNote:
          'The collider GLB arrives in the same OpenCV frame as the splat, so it ' +
          'needs the same 180 degree turn about X (docs.worldlabs.ai/marble/export/' +
          'specs). Whether it also needs metric_scale_factor and ground_plane_offset ' +
          'is UNVERIFIED - semantics_metadata is documented only against the SPZ ' +
          'export. This project applies splatTransform to the splat only, so check ' +
          'alignment on the plan screen before trusting the walls.',
        files: {
          splat: { ...splat, url: redactUrl(splat.url) },
          extraSplats: extraSplats.map((extra) => ({ ...extra, url: redactUrl(extra.url) })),
          collider: {
            file: collider.file,
            url: redactUrl(collider.url),
            bytes: collider.bytes,
            sha256: collider.sha256,
            meshes: verified.meshCount,
            primitives: verified.primitiveCount,
            triangles: loaded?.triangles ?? null,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    setId,
    dir,
    operationId,
    worldId,
    worldMarbleUrl: world?.world_marble_url ?? null,
    model: world?.model ?? null,
    caption: assets.caption ?? null,
    splat,
    extraSplats,
    collider,
    semantics,
    placement,
    scenePath,
  };
}

/** `metadata.world_id` is present on in-flight operations in the docs example. */
function readOperationWorldId(metadata: Record<string, unknown> | null | undefined): string | null {
  const id = metadata?.world_id;
  return typeof id === 'string' && id ? id : null;
}
