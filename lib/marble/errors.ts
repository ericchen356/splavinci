/**
 * One error type for the whole Marble pipeline.
 *
 * Every stage can fail in a way the operator has to act on — a key that was
 * never exported, an account out of credits, a collider that arrived
 * truncated — and the difference between those matters far more than a stack
 * trace does. `kind` lets callers branch, `hint` carries the fix, and
 * `retryable` says whether trying again could possibly help.
 */

export type MarbleErrorKind =
  /** No API key in the environment or the call. */
  | 'missing-key'
  /** 401/403 — the key was rejected. */
  | 'auth'
  /** 429 — start-rate limit. */
  | 'rate-limit'
  /** 402 — account is out of API credits. */
  | 'credits'
  /** 400/422 — the payload or the prompt was rejected. */
  | 'request'
  /** 404 — world, operation, or media asset does not exist for this key. */
  | 'not-found'
  /** 5xx. */
  | 'server'
  /** DNS, TLS, socket, aborted transfer. */
  | 'network'
  /** The operation finished with `done: true` and a non-null `error`. */
  | 'generation'
  /** Polling gave up before the operation finished. */
  | 'timeout'
  /** The world completed but did not carry an asset we require. */
  | 'asset-missing'
  /** A downloaded asset is empty, truncated, or not the format it claims. */
  | 'asset-invalid'
  /** Bad input to a stage — missing file, too many photos, no layout text. */
  | 'input';

export type MarbleErrorInit = {
  kind: MarbleErrorKind;
  message: string;
  /** What to do about it. Printed under the message by the CLI. */
  hint?: string;
  status?: number;
  /** Parsed `detail` from the API body, or whatever the body actually was. */
  detail?: unknown;
  /** World Labs trace id, when the response carried one. */
  requestId?: string;
  cause?: unknown;
};

/** Kinds where retrying the identical call can plausibly succeed. */
const RETRYABLE: ReadonlySet<MarbleErrorKind> = new Set<MarbleErrorKind>([
  'rate-limit',
  'server',
  'network',
]);

export class MarbleError extends Error {
  readonly kind: MarbleErrorKind;
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly detail: unknown;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(init: MarbleErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'MarbleError';
    this.kind = init.kind;
    this.hint = init.hint;
    this.status = init.status;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryable = RETRYABLE.has(init.kind);
  }

  /** Message plus hint, for a terminal. */
  format(): string {
    const parts = [`${this.kind}: ${this.message}`];
    if (this.requestId) parts.push(`request_id: ${this.requestId}`);
    if (this.hint) parts.push(this.hint);
    return parts.join('\n');
  }
}

export function isMarbleError(e: unknown): e is MarbleError {
  return e instanceof MarbleError;
}
