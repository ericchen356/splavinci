/**
 * World Labs Marble pipeline.
 *
 *   stage 1  composeIntake      blueprint + photos + keywords -> prompt + images
 *   stage 2  buildEnvironment   prompt + images -> room.spz + collider.glb
 *
 * api.ts is the single adapter for World Labs' wire format; every unverified
 * assumption about their contract is marked there and nowhere else.
 */

export {
  AUTH_HEADER,
  DEFAULT_MODEL,
  MARBLE_BASE_URL,
  MARBLE_MODELS,
  MAX_IMAGES_DEFAULT,
  MAX_IMAGES_RECONSTRUCT,
  SPZ_PREFERENCE,
  SUPPORTED_IMAGE_EXTENSIONS,
  buildWorldPrompt,
  listSpzUrls,
  pickSpzUrl,
  placementFromSemantics,
  readColliderUrl,
  readProgress,
  readWorld,
  readWorldId,
} from './api';
export type {
  ImageWorldPrompt,
  MarbleModel,
  MarbleOperation,
  MarbleWorld,
  MediaReference,
  MultiImageWorldPrompt,
  PrepareUploadResponse,
  SplatPlacementValues,
  WorldAssets,
  WorldPrompt,
  WorldSemanticsMetadata,
  WorldsGenerateRequest,
} from './api';

export { API_KEY_ENV, API_KEY_ENV_ALIAS, BASE_URL_ENV, MarbleClient, resolveApiKey } from './client';
export type { Logger, MarbleClientOptions, WaitOptions } from './client';

export { MarbleError, isMarbleError } from './errors';
export type { MarbleErrorKind } from './errors';

export {
  COHERENCE_CLAUSE,
  DEFAULT_ANCHOR,
  INSPIRATION_CLAUSE,
  RECONSTRUCTION_CLAUSE,
  composeIntake,
} from './intake';
export type {
  BlueprintInput,
  BlueprintReader,
  IntakeDetail,
  IntakeInput,
  IntakeOptions,
  IntakeResult,
} from './intake';

export { buildEnvironment } from './build';
export type {
  ColliderAsset,
  DownloadedAsset,
  EnvironmentBuildOptions,
  EnvironmentBuildResult,
  EnvironmentInput,
  ImageDelivery,
  SplatAsset,
} from './build';

export { inspectGlb } from './glb';
export type { GlbInspection } from './glb';

export { assertLooksLikeSpz, verifyColliderWithLoader } from './verify';
export type { LoaderVerification } from './verify';

export { runCli } from './cli';
