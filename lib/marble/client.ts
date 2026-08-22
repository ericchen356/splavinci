/**
 * Transport for the Marble API: auth, error taxonomy, retry policy, polling,
 * and asset download.
 *
 * Nothing here knows a field name — payloads are built and responses read in
 * api.ts. This layer only cares about HTTP.
 *
 * NOT YET EXERCISED. There is no API key in this project, so no request in this
 * file has ever been sent. The endpoint paths, header name and status-code
 * meanings come from World Labs' documentation (cited in api.ts); the retry and
 * backoff policy is this project's own, shaped by
 * https://docs.worldlabs.ai/api/rate-limits.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

import { MarbleError } from './errors';
import {
  AUTH_HEADER,
  MARBLE_BASE_URL,
  type MarbleOperation,
  type MarbleWorld,
  type PrepareUploadResponse,
  type WorldsGenerateRequest,
  readProgress,
  readWorld,
} from './api';

/* -------------------------------------------------------------------------- */
/* api key                                                                    */
/* -------------------------------------------------------------------------- */

/** The name this project standardises on. Documented in .env.example. */
export const API_KEY_ENV = 'WORLD_LABS_API_KEY';
/** World Labs' own samples read this one; accepted so an existing export works. */
export const API_KEY_ENV_ALIAS = 'WLT_API_KEY';
export const BASE_URL_ENV = 'MARBLE_API_BASE_URL';

/**
 * Fail loudly and specifically when no key is configured.
 *
 * The alternative — a client that constructs fine and dies with a 401 five
 * calls later — hides the one thing the operator actually needs to fix.
 */
export function resolveApiKey(explicit?: string | null): string {
  const key =
    explicit?.trim() ||
    process.env[API_KEY_ENV]?.trim() ||
    process.env[API_KEY_ENV_ALIAS]?.trim();

  if (!key) {
    throw new MarbleError({
      kind: 'missing-key',
      message: `${API_KEY_ENV} is not set — cannot call the World Labs Marble API.`,
      hint:
        `Create a key at https://platform.worldlabs.ai/api-keys, copy .env.example ` +
        `to .env.local and fill it in, then run:\n` +
        `  npx tsx --env-file=.env.local scripts/marble-generate.ts ...\n` +
        `Or export it for one command:\n` +
        `  ${API_KEY_ENV}=wl_... npx tsx scripts/marble-generate.ts ...\n` +
        `${API_KEY_ENV_ALIAS} is accepted as an alias. --dry-run needs no key.`,
    });
  }
  return key;
}

/* -------------------------------------------------------------------------- */
/* client                                                                     */
/* -------------------------------------------------------------------------- */

export type Logger = (line: string) => void;

export type MarbleClientOptions = {
  apiKey?: string | null;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Attempts for retryable failures (429/5xx/network). Total, not extra. */
  maxAttempts?: number;
  /** First backoff step; doubles with full jitter. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-request timeout. Generation start can be slow; polling is quick. */
  requestTimeoutMs?: number;
  log?: Logger;
};

export type WaitOptions = {
  /** Give up after this long. Docs put a typical generation at ~5 minutes. */
  timeoutMs?: number;
  /** First poll delay. World Labs' own sample uses a flat 5s. */
  initialPollMs?: number;
  maxPollMs?: number;
  /** Growth per poll, so a 40-minute generation is not polled 480 times. */
  pollGrowth?: number;
  onPoll?: (op: MarbleOperation, elapsedMs: number) => void;
  signal?: AbortSignal;
};

const DEFAULTS = {
  maxAttempts: 4,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 120_000,
  waitTimeoutMs: 30 * 60_000,
  initialPollMs: 5_000,
  maxPollMs: 20_000,
  pollGrowth: 1.35,
} as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new MarbleError({ kind: 'timeout', message: 'Aborted.' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MarbleError({ kind: 'timeout', message: 'Aborted.' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full jitter, so a batch of clients does not resynchronise after a 429. */
function backoffMs(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

type ParsedBody = { json: unknown; text: string };

function readDetail(body: ParsedBody): { detail: unknown; requestId?: string } {
  const record =
    typeof body.json === 'object' && body.json !== null
      ? (body.json as Record<string, unknown>)
      : null;
  const requestId = typeof record?.request_id === 'string' ? record.request_id : undefined;
  return { detail: record?.detail ?? body.text.slice(0, 500), requestId };
}

function summarise(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export class MarbleClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;
  private readonly requestTimeoutMs: number;
  private readonly log: Logger;

  constructor(options: MarbleClientOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = (
      options.baseUrl ??
      process.env[BASE_URL_ENV] ??
      MARBLE_BASE_URL
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseBackoff = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoff = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.log = options.log ?? (() => {});
  }

  /* ---------------------------- error mapping ---------------------------- */

  /**
   * Status codes and their meanings are from
   * https://docs.worldlabs.ai/api/errors, plus the 401 that
   * /api/reference/operations/get documents for an unauthorised caller.
   */
  private toError(status: number, body: ParsedBody, path: string): MarbleError {
    const { detail, requestId } = readDetail(body);
    const message = `${path} -> ${status}: ${summarise(detail)}`;
    const common = { status, detail, requestId };

    if (status === 401 || status === 403) {
      return new MarbleError({
        ...common,
        kind: 'auth',
        message,
        hint:
          `The ${AUTH_HEADER} header was rejected. Check that ${API_KEY_ENV} holds a ` +
          `current key from https://platform.worldlabs.ai/api-keys and has not been ` +
          `truncated or wrapped in quotes.`,
      });
    }
    if (status === 402) {
      return new MarbleError({
        ...common,
        kind: 'credits',
        message,
        hint: 'Out of API credits. Top up at https://platform.worldlabs.ai/billing (API credits are separate from Marble app credits).',
      });
    }
    if (status === 404) {
      return new MarbleError({
        ...common,
        kind: 'not-found',
        message,
        hint: 'The id does not exist, or it belongs to a different API key.',
      });
    }
    if (status === 429) {
      return new MarbleError({
        ...common,
        kind: 'rate-limit',
        message,
        hint: 'Default tier is about 3 generation starts per minute and 60 per hour. The request was NOT accepted, so it must be retried rather than polled for.',
      });
    }
    if (status >= 500) {
      return new MarbleError({ ...common, kind: 'server', message });
    }
    return new MarbleError({
      ...common,
      kind: 'request',
      message,
      hint:
        status === 422
          ? 'Schema validation failed; each detail[] entry names the offending field path.'
          : 'Rejected before generation. A 400 with no detail is usually a body that was not serialised to JSON; a 400 with detail can also be a content-policy rejection.',
    });
  }

  /* ------------------------------- requests ------------------------------ */

  private async requestJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    let lastError: MarbleError | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const isLast = attempt === this.maxAttempts - 1;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: init.method,
          headers: {
            [AUTH_HEADER]: this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          // Serialised here, not handed to fetch as an object: a body that
          // arrives as a language-native map stringification is the single most
          // common cause of an undiagnosable 400 (documented in /api/errors).
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: this.timeoutSignal(init.signal),
        });
      } catch (cause) {
        lastError = new MarbleError({
          kind: 'network',
          message: `${path}: request failed before a response arrived.`,
          hint: 'DNS, TLS, a dropped socket, or the per-request timeout.',
          cause,
        });
        if (isLast) break;
        await this.pauseBeforeRetry(path, attempt, null, init.signal);
        continue;
      }

      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (response.ok) return json as T;

      const error = this.toError(response.status, { json, text }, path);
      if (!error.retryable) throw error;
      lastError = error;
      if (isLast) break;
      await this.pauseBeforeRetry(path, attempt, response.headers.get('retry-after'), init.signal);
    }

    throw (
      lastError ??
      new MarbleError({ kind: 'network', message: `${path}: exhausted retries with no response.` })
    );
  }

  /** Exponential backoff with jitter, never shorter than an advised Retry-After. */
  private async pauseBeforeRetry(
    path: string,
    attempt: number,
    retryAfter: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const advised = retryAfterMs(retryAfter);
    const delay = Math.max(advised ?? 0, backoffMs(attempt, this.baseBackoff, this.maxBackoff));
    this.log(`retry ${attempt + 1}/${this.maxAttempts - 1} for ${path} in ${delay}ms`);
    await sleep(delay, signal);
  }

  private timeoutSignal(caller?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }

  /* ------------------------------ endpoints ------------------------------ */

  /** POST /media-assets:prepare_upload */
  prepareUpload(
    request: { file_name: string; kind: 'image' | 'video'; extension?: string },
    signal?: AbortSignal,
  ): Promise<PrepareUploadResponse> {
    return this.requestJson<PrepareUploadResponse>('media-assets:prepare_upload', {
      method: 'POST',
      body: request,
      signal,
    });
  }

  /**
   * PUT the raw bytes to the signed storage URL.
   *
   * This one does not go through `requestJson`: it is not the Marble API, it is
   * object storage, the response has no JSON body, and the API key must not be
   * attached — the URL is already signed and an extra auth header can invalidate
   * the signature.
   */
  async uploadBytes(
    upload: PrepareUploadResponse['upload_info'],
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(upload.upload_url, {
      method: upload.upload_method || 'PUT',
      headers: { ...(upload.required_headers ?? {}) },
      body: bytes as unknown as BodyInit,
      signal: this.timeoutSignal(signal),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new MarbleError({
        kind: 'network',
        message: `Signed upload failed: ${response.status}`,
        detail: text.slice(0, 500),
        hint: 'The upload URL is short-lived — if it expired, prepare a new one.',
        status: response.status,
      });
    }
  }

  /** POST /worlds:generate */
  generateWorld(request: WorldsGenerateRequest, signal?: AbortSignal): Promise<MarbleOperation> {
    return this.requestJson<MarbleOperation>('worlds:generate', {
      method: 'POST',
      body: request,
      signal,
    });
  }

  /** GET /operations/{id} */
  getOperation(operationId: string, signal?: AbortSignal): Promise<MarbleOperation> {
    return this.requestJson<MarbleOperation>(
      `operations/${encodeURIComponent(operationId)}`,
      { method: 'GET', signal },
    );
  }

  /** GET /worlds/{id} */
  async getWorld(worldId: string, signal?: AbortSignal): Promise<MarbleWorld | null> {
    const payload = await this.requestJson<unknown>(
      `worlds/${encodeURIComponent(worldId)}`,
      { method: 'GET', signal },
    );
    return readWorld(payload);
  }

  /**
   * Poll until the operation reports `done`.
   *
   * Rate limits are documented against generation *starts*, not polls, so the
   * interval is about not being wasteful rather than about staying legal. It
   * starts at the 5s World Labs' own sample uses and grows gently, because a
   * `marble-1.1-plus` world can run well past the ~5 minute typical case.
   */
  async waitForOperation(operationId: string, options: WaitOptions = {}): Promise<MarbleOperation> {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.waitTimeoutMs;
    const maxPoll = options.maxPollMs ?? DEFAULTS.maxPollMs;
    const growth = options.pollGrowth ?? DEFAULTS.pollGrowth;
    let interval = options.initialPollMs ?? DEFAULTS.initialPollMs;

    const startedAt = Date.now();
    for (;;) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) {
        throw new MarbleError({
          kind: 'timeout',
          message: `Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
          hint:
            `The generation may still be running. Nothing was lost — resume with:\n` +
            `  npx tsx scripts/marble-generate.ts --resume ${operationId}`,
        });
      }

      const operation = await this.getOperation(operationId, options.signal);
      options.onPoll?.(operation, elapsed);

      if (operation.done) {
        const failure = operation.error;
        // `done: true` with a non-null error is the documented shape for a
        // generation that started fine and then failed - it never surfaces as
        // an HTTP status, so it has to be checked explicitly.
        if (failure && (failure.code != null || failure.message)) {
          throw new MarbleError({
            kind: 'generation',
            message: `Generation failed: ${failure.message ?? 'no message'}${
              failure.code == null ? '' : ` (code ${failure.code})`
            }`,
            detail: failure,
            hint: 'The operation completed with an error; retrying the same prompt may or may not help. Content-policy rejections will not.',
          });
        }
        return operation;
      }

      const progress = readProgress(operation);
      if (progress) this.log(`  ${Math.round(elapsed / 1000)}s  ${progress}`);

      await sleep(interval, options.signal);
      interval = Math.min(maxPoll, Math.round(interval * growth));
    }
  }

  /* ------------------------------ downloads ------------------------------ */

  /**
   * Stream an asset URL to disk.
   *
   * Streamed rather than buffered because a full-resolution SPZ is hundreds of
   * megabytes (the hobbiton capture in this repo is 372 MB). No auth header:
   * asset URLs come back pre-signed.
   *
   * A short read is a hard error rather than a partial file, and the caller
   * writes to a temporary path so a failure never leaves something that looks
   * like a valid asset behind.
   */
  async downloadToFile(
    url: string,
    destPath: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void } = {},
  ): Promise<{ bytes: number; sha256: string }> {
    let lastError: MarbleError | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = backoffMs(attempt, this.baseBackoff, this.maxBackoff);
        this.log(`retrying download (${attempt}/${this.maxAttempts - 1}) in ${delay}ms`);
        await sleep(delay, options.signal);
      }

      try {
        return await this.downloadOnce(url, destPath, options);
      } catch (error) {
        if (error instanceof MarbleError && !error.retryable) throw error;
        lastError = error instanceof MarbleError
          ? error
          : new MarbleError({ kind: 'network', message: `Download failed: ${String(error)}`, cause: error });
      }
    }

    throw lastError ?? new MarbleError({ kind: 'network', message: `Could not download ${url}` });
  }

  private async downloadOnce(
    url: string,
    destPath: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void },
  ): Promise<{ bytes: number; sha256: string }> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      // No per-request timeout here: a multi-hundred-megabyte splat legitimately
      // takes longer than any sane request deadline.
      signal: options.signal,
    });

    if (!response.ok) {
      const kind = response.status >= 500 || response.status === 429 ? 'server' : 'request';
      throw new MarbleError({
        kind,
        status: response.status,
        message: `Asset download failed: ${response.status} for ${url}`,
        hint:
          response.status === 403
            ? 'Signed asset URLs expire. Re-fetch the world with GET /worlds/{id} for fresh links.'
            : undefined,
      });
    }
    if (!response.body) {
      throw new MarbleError({ kind: 'network', message: `Asset response had no body: ${url}` });
    }

    const header = response.headers.get('content-length');
    const expected = header && /^\d+$/.test(header) ? Number(header) : null;

    const hash = createHash('sha256');
    const out = createWriteStream(destPath);
    let received = 0;

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        hash.update(value);
        if (!out.write(value)) await once(out, 'drain');
        options.onProgress?.(received, expected);
      }
      out.end();
      await finished(out);
    } catch (cause) {
      out.destroy();
      throw new MarbleError({
        kind: 'network',
        message: `Transfer of ${url} broke after ${received} bytes.`,
        cause,
      });
    }

    if (expected !== null && received !== expected) {
      throw new MarbleError({
        kind: 'network',
        message: `Short read: got ${received} of ${expected} bytes from ${url}.`,
        hint: 'The connection closed early. Nothing was written to the final path.',
      });
    }
    if (received === 0) {
      throw new MarbleError({
        kind: 'asset-invalid',
        message: `Asset download produced 0 bytes: ${url}`,
      });
    }

    return { bytes: received, sha256: hash.digest('hex') };
  }
}
