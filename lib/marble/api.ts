/**
 * ============================================================================
 * ADAPTER SECTION — everything that encodes World Labs' wire contract
 * ============================================================================
 *
 * This is the ONLY file that knows what Marble's JSON looks like. If the API
 * moves, it moves here and nowhere else: the client transports, the builder
 * orchestrates, neither one reads a field name.
 *
 * PROVENANCE. None of this has been exercised against the live service — no
 * API key exists in this project yet, so not one byte has been sent. Every
 * shape below was taken from World Labs' published documentation on
 * 2026-08-22, and each block says which. Two confidence levels are used:
 *
 *   CONFIRMED  copied from the OpenAPI 3.1 schema that docs.worldlabs.ai
 *              embeds in its reference pages (fetched as raw markdown from
 *              https://docs.worldlabs.ai/api/reference/... .md), or from
 *              World Labs' own sample code at
 *              https://github.com/worldlabsai/worldlabs-api-examples.
 *   ASSUMED    a judgement this project made where the docs are silent,
 *              ambiguous, or self-contradictory. Each one says so inline.
 *
 * Sources, all read 2026-08-22:
 *   https://docs.worldlabs.ai/api                                  (quickstart)
 *   https://docs.worldlabs.ai/api/reference/worlds/generate        (OpenAPI)
 *   https://docs.worldlabs.ai/api/reference/worlds/get             (OpenAPI)
 *   https://docs.worldlabs.ai/api/reference/operations/get         (OpenAPI)
 *   https://docs.worldlabs.ai/api/reference/media-assets/prepare-upload
 *   https://docs.worldlabs.ai/api/world-generation-examples
 *   https://docs.worldlabs.ai/api/errors
 *   https://docs.worldlabs.ai/api/rate-limits
 *   https://docs.worldlabs.ai/api/rendering-spz
 *   https://docs.worldlabs.ai/marble/export/specs
 *   https://github.com/worldlabsai/worldlabs-api-examples/blob/main/generate-world-from-image.js
 */

/* -------------------------------------------------------------------------- */
/* endpoint + auth                                                            */
/* -------------------------------------------------------------------------- */

/**
 * CONFIRMED. `apiBaseUrl` in World Labs' own generate-world-from-image.js, and
 * the host in every curl example in the quickstart.
 */
export const MARBLE_BASE_URL = 'https://api.worldlabs.ai/marble/v1';

/** CONFIRMED. OpenAPI `securitySchemes.ApiKeyAuth`; used by every doc example. */
export const AUTH_HEADER = 'WLT-Api-Key';

/**
 * CONFIRMED enum, from the OpenAPI `model` property on WorldsGenerateRequest.
 * The three legacy names ('Marble 0.1-mini', 'Marble 0.1-plus',
 * 'Marble 1.1-plus') still resolve but are documented as deprecated, so they
 * are deliberately not offered here.
 */
export const MARBLE_MODELS = [
  'marble-1.0-draft',
  'marble-1.0',
  'marble-1.1',
  'marble-1.1-plus',
] as const;

export type MarbleModel = (typeof MARBLE_MODELS)[number];

/** CONFIRMED: OpenAPI gives `model` a default of `marble-1.1`. */
export const DEFAULT_MODEL: MarbleModel = 'marble-1.1';

/**
 * CONFIRMED. MultiImagePrompt.reconstruct_images: "Whether to use
 * reconstruction mode (allows up to 8 images, otherwise 4)".
 */
export const MAX_IMAGES_DEFAULT = 4;
export const MAX_IMAGES_RECONSTRUCT = 8;

/**
 * CONFIRMED as a recommendation, not an enforced list: ImagePrompt and
 * MultiImagePrompt both say "Recommended image formats: jpg, jpeg, png, webp."
 * Intake rejects anything else rather than discovering it 5 minutes into a
 * generation.
 */
export const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

/* -------------------------------------------------------------------------- */
/* request wire types                                                         */
/* -------------------------------------------------------------------------- */

/**
 * CONFIRMED. Discriminated on `source`; OpenAPI schemas UriReference,
 * MediaAssetReference, DataBase64Reference.
 */
export type MediaReference =
  | { source: 'uri'; uri: string }
  | { source: 'media_asset'; media_asset_id: string }
  | { source: 'data_base64'; data_base64: string; extension?: string };

/** CONFIRMED: OpenAPI SphericallyLocatedContent. `azimuth` is optional. */
export type SphericallyLocatedContent = {
  content: MediaReference;
  /** Degrees. Omitted when the photo's bearing is genuinely unknown. */
  azimuth?: number;
};

/** CONFIRMED: OpenAPI PanoDetectionMode enum. Note `true`/`false` are strings. */
export type PanoDetectionMode = 'auto' | 'true' | 'false';

/** CONFIRMED: OpenAPI ImagePrompt. */
export type ImageWorldPrompt = {
  type: 'image';
  image_prompt: MediaReference;
  text_prompt?: string | null;
  is_pano?: PanoDetectionMode;
  disable_recaption?: boolean | null;
};

/** CONFIRMED: OpenAPI MultiImagePrompt-Input. */
export type MultiImageWorldPrompt = {
  type: 'multi-image';
  multi_image_prompt: SphericallyLocatedContent[];
  text_prompt?: string | null;
  reconstruct_images?: boolean;
  disable_recaption?: boolean | null;
};

export type WorldPrompt = ImageWorldPrompt | MultiImageWorldPrompt;

/** CONFIRMED: OpenAPI WorldsGenerateRequest. Only `world_prompt` is required. */
export type WorldsGenerateRequest = {
  world_prompt: WorldPrompt;
  model?: MarbleModel;
  /** Max 64 characters, enforced by the schema. */
  display_name?: string;
  /** Max 10 tags. */
  tags?: string[];
  /** 0 .. 4294967295. */
  seed?: number | null;
  permission?: {
    public?: boolean;
    allow_id_access?: boolean;
    allowed_readers?: string[];
    allowed_writers?: string[];
  };
};

/* -------------------------------------------------------------------------- */
/* response wire types                                                        */
/* -------------------------------------------------------------------------- */

/** CONFIRMED: OpenAPI OperationError. Both fields nullable. */
export type OperationError = {
  code?: number | null;
  message?: string | null;
};

/** CONFIRMED: OpenAPI OperationCost. */
export type OperationCost = {
  total_credits: number;
  line_items?: { name?: string; credits?: number }[];
};

/**
 * CONFIRMED: OpenAPI WorldSemanticsMetadata, plus the maths in
 * /api/rendering-spz. Both fields are nullable only for worlds generated
 * before December 2025.
 */
export type WorldSemanticsMetadata = {
  /** Multiply raw XYZ (and isotropic scales) by this to get metres. */
  metric_scale_factor?: number | null;
  /** Subtract from Y after scaling to put the ground plane at y = 0. */
  ground_plane_offset?: number | null;
};

/** CONFIRMED: OpenAPI SplatAssets / MeshAssets / ImageryAssets / WorldAssets. */
export type WorldAssets = {
  caption?: string | null;
  thumbnail_url?: string | null;
  splats?: {
    /**
     * CONFIRMED as an open map (`additionalProperties: string`). The keys
     * "100k", "500k" and "full_res" appear in every documented example but are
     * NOT in the schema, so `pickSpzUrl` prefers them and then falls back to
     * whatever keys actually arrive rather than indexing blind.
     */
    spz_urls?: Record<string, string> | null;
    semantics_metadata?: WorldSemanticsMetadata | null;
  } | null;
  mesh?: {
    /** CONFIRMED: "Collider mesh in GLB format" (quickstart asset list). */
    collider_mesh_url?: string | null;
    /** Only populated after POST /worlds/{id}:export. */
    hq_mesh_url?: string | null;
    full_res_mesh_url?: string | null;
  } | null;
  imagery?: { pano_url?: string | null } | null;
};

/**
 * CONFIRMED: OpenAPI World. Required fields are world_id, display_name and
 * world_marble_url.
 *
 * `id` is NOT in the schema. It is here because the quickstart's prose JSON
 * examples show the completed operation's snapshot using `"id"` while the
 * schema and World Labs' own sample code use `world_id` — see `readWorldId`.
 */
export type MarbleWorld = {
  world_id?: string;
  id?: string;
  display_name?: string;
  world_marble_url?: string;
  model?: string | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  assets?: WorldAssets | null;
};

/**
 * CONFIRMED: OpenAPI GenerateWorldResponse, and
 * GetOperationResponse[Union[World, ...]] for the polling endpoint. `response`
 * is typed as `{}`/any in the schema — it is a World for a generate operation.
 */
export type MarbleOperation = {
  operation_id: string;
  done: boolean;
  error?: OperationError | null;
  /** "Service-specific metadata, such as progress percentage." */
  metadata?: Record<string, unknown> | null;
  response?: unknown;
  cost?: OperationCost | null;
  created_at?: string | null;
  updated_at?: string | null;
  expires_at?: string | null;
};

/** CONFIRMED: OpenAPI MediaAssetPrepareUploadResponse. */
export type PrepareUploadResponse = {
  media_asset: {
    media_asset_id: string;
    file_name: string;
    kind: 'image' | 'video';
    extension?: string | null;
    created_at: string;
  };
  upload_info: {
    upload_url: string;
    upload_method: string;
    required_headers?: Record<string, string> | null;
    curl_example?: string | null;
  };
};

/* -------------------------------------------------------------------------- */
/* request builders                                                           */
/* -------------------------------------------------------------------------- */

export type WorldPromptInput = {
  composedPrompt: string;
  /** One reference per photo, already uploaded or inlined, in caller order. */
  references: MediaReference[];
  /** Per-photo bearing in degrees, aligned to `references`. null = unknown. */
  azimuths?: (number | null)[];
  /** True to send `text_prompt` verbatim instead of letting Marble recaption. */
  disableRecaption?: boolean;
  /** Forced on above MAX_IMAGES_DEFAULT photos; see MultiImagePrompt. */
  reconstructImages?: boolean;
};

/**
 * Single image vs multi-image, decided purely by photo count — the rule the
 * environment-builder stage is specified against.
 *
 * `is_pano: 'auto'` on the single-image path is the schema default anyway, but
 * it is stated explicitly because it is load-bearing: an interior photo shot on
 * a phone must NOT be treated as an equirectangular panorama, and 'auto' is the
 * mode that checks rather than assumes.
 */
export function buildWorldPrompt(input: WorldPromptInput): WorldPrompt {
  const { references, composedPrompt } = input;
  if (references.length === 0) {
    throw new Error('buildWorldPrompt: at least one image reference is required');
  }

  if (references.length === 1) {
    return {
      type: 'image',
      image_prompt: references[0],
      text_prompt: composedPrompt,
      is_pano: 'auto',
      ...(input.disableRecaption === undefined
        ? {}
        : { disable_recaption: input.disableRecaption }),
    };
  }

  const items: SphericallyLocatedContent[] = references.map((content, i) => {
    const azimuth = input.azimuths?.[i];
    // Omitted rather than defaulted to 0: claiming every photo faces north
    // would be a worse input than admitting the bearings are unknown.
    return azimuth === null || azimuth === undefined ? { content } : { content, azimuth };
  });

  const reconstruct = input.reconstructImages ?? references.length > MAX_IMAGES_DEFAULT;

  return {
    type: 'multi-image',
    multi_image_prompt: items,
    text_prompt: composedPrompt,
    ...(reconstruct ? { reconstruct_images: true } : {}),
    ...(input.disableRecaption === undefined
      ? {}
      : { disable_recaption: input.disableRecaption }),
  };
}

/* -------------------------------------------------------------------------- */
/* response readers                                                           */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The World carried by a finished operation, or by GET /worlds/{id}.
 *
 * ASSUMED — one documented contradiction is absorbed here. The OpenAPI schema
 * for GET /marble/v1/worlds/{world_id} returns a bare `World`, but the
 * quickstart's example response for that same call shows it wrapped as
 * `{"world": {...}}`. Both are accepted; the schema is trusted as primary.
 */
export function readWorld(payload: unknown): MarbleWorld | null {
  const record = asRecord(payload);
  if (!record) return null;
  const wrapped = asRecord(record.world);
  return (wrapped ?? record) as MarbleWorld;
}

/**
 * ASSUMED — the second half of the same contradiction. The World schema names
 * the field `world_id` (required) and World Labs' generate-world-from-image.js
 * reads `operation.response.world_id`, but the quickstart's JSON examples print
 * `"id"`. `world_id` is preferred, `id` accepted.
 */
export function readWorldId(world: MarbleWorld | null): string | null {
  return world?.world_id ?? world?.id ?? null;
}

/** Progress line for logs, if the operation carried one. CONFIRMED shape from
 *  the quickstart example: `metadata.progress = { status, description }`. */
export function readProgress(op: MarbleOperation): string | null {
  const progress = asRecord(op.metadata?.progress);
  if (!progress) return null;
  const status = typeof progress.status === 'string' ? progress.status : null;
  const description =
    typeof progress.description === 'string' ? progress.description : null;
  return [status, description].filter(Boolean).join(' - ') || null;
}

/**
 * Densities in descending preference. `full_res` is deliberately last: the
 * hobbiton capture in this repo is 372 MB at full resolution and the plan
 * screen is unusable at that weight, so the middle density is the sane default.
 */
export const SPZ_PREFERENCE = ['500k', '100k', 'full_res'] as const;

export type SpzChoice = { key: string; url: string };

/**
 * Pick one SPZ density. `preferred` wins if present; otherwise the first
 * documented key that exists; otherwise any key at all, because `spz_urls` is
 * schema'd as an open map and new densities would silently break a hard index.
 */
export function pickSpzUrl(
  assets: WorldAssets | null | undefined,
  preferred?: string,
): SpzChoice | null {
  const urls = assets?.splats?.spz_urls;
  if (!urls) return null;

  if (preferred) {
    const exact = urls[preferred];
    return exact ? { key: preferred, url: exact } : null;
  }
  for (const key of SPZ_PREFERENCE) {
    const url = urls[key];
    if (url) return { key, url };
  }
  const first = Object.entries(urls).find(([, url]) => typeof url === 'string' && url);
  return first ? { key: first[0], url: first[1] } : null;
}

export function listSpzUrls(assets: WorldAssets | null | undefined): SpzChoice[] {
  const urls = assets?.splats?.spz_urls ?? {};
  return Object.entries(urls)
    .filter(([, url]) => typeof url === 'string' && url.length > 0)
    .map(([key, url]) => ({ key, url }));
}

export function readColliderUrl(assets: WorldAssets | null | undefined): string | null {
  return assets?.mesh?.collider_mesh_url ?? null;
}

/* -------------------------------------------------------------------------- */
/* splat placement                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The transform that puts a Marble SPZ into this project's world.
 *
 * CONFIRMED from /api/rendering-spz, which specifies three separate steps:
 *   metric_xyz  = raw_xyz * metric_scale_factor
 *   aligned_xyz = metric_xyz - (0, ground_plane_offset, 0)
 *   axis        = "Marble's web viewer applies a 180 degree rotation around
 *                  the X axis for generated SPZ assets" (marble_raw_opencv ->
 *                  a Three.js-style frame)
 *
 * three.js composes a node transform as T * R * S, so folding those three steps
 * into one placement gives scale = metric_scale_factor, rotation = [PI, 0, 0],
 * and position = (0, +ground_plane_offset, 0) — the ground offset flips sign
 * because the 180 degree turn about X negates Y after it is applied. That is
 * exactly the SplatPlacement shape lib/assets.ts expects, and it is why the
 * hobbiton entry there carries a positive Y lift with the same rotation.
 *
 * The same axis flip applies to the collider. /marble/export/specs says of
 * exports generally — the collider GLB is listed among them — "Default world
 * labs worlds are in OpenCV coordinate system (+x left, +y down, +z forward) …
 * perform an OpenCV-to-OpenGL transformation by scaling the Y and Z axes by -1
 * (keeping X unchanged)", which is the same 180 degree turn about X.
 *
 * ASSUMED, and the one thing to check first on a real capture: whether the
 * collider also needs `metric_scale_factor` and `ground_plane_offset`.
 * semantics_metadata is documented only against the SPZ export. If the splat
 * and the collider come out separated or differently sized in the plan screen,
 * this is why.
 */
export type SplatPlacementValues = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
};

export function placementFromSemantics(
  semantics: WorldSemanticsMetadata | null | undefined,
): SplatPlacementValues {
  const scale = semantics?.metric_scale_factor ?? 1;
  const ground = semantics?.ground_plane_offset ?? 0;
  return {
    position: [0, ground, 0],
    rotation: [Math.PI, 0, 0],
    scale,
  };
}
