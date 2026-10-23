import type { ErrorCode, RetryDisposition } from "./enums.js";
import type { VapErrorBody } from "./types.js";

const DEFAULTS: Record<ErrorCode, { status: number; retry: RetryDisposition }> = {
  INVALID_ARGUMENT: { status: 400, retry: "fix_request" },
  UNAUTHORIZED: { status: 401, retry: "fix_request" },
  FORBIDDEN: { status: 403, retry: "do_not_retry" },
  NOT_FOUND: { status: 404, retry: "do_not_retry" },
  STALE_PLAN: { status: 409, retry: "fix_request" },
  PLAN_EXPIRED: { status: 409, retry: "fix_request" },
  APPROVAL_REQUIRED: { status: 403, retry: "retry_with_same_key" },
  KEY_REUSE_CONFLICT: { status: 409, retry: "fix_request" },
  REQUEST_KEY_EXPIRED: { status: 409, retry: "reconcile_first" },
  LIMIT_EXCEEDED: { status: 429, retry: "fix_request" },
  CAPABILITY_UNAVAILABLE: { status: 501, retry: "do_not_retry" },
  DESTINATION_UNAVAILABLE: { status: 503, retry: "reconcile_first" },
  OUTCOME_UNKNOWN: { status: 409, retry: "reconcile_first" },
  CONFLICT: { status: 409, retry: "fix_request" },
  UNSUPPORTED_PROTOCOL_VERSION: { status: 400, retry: "fix_request" },
  UNAVAILABLE: { status: 503, retry: "retry_with_same_key" },
  INTERNAL: { status: 500, retry: "retry_with_same_key" },
};

export interface VapErrorOptions {
  retry?: RetryDisposition;
  status?: number;
  operationId?: string | null;
  details?: Record<string, unknown>;
  evidenceRefs?: string[];
  cause?: unknown;
}

/**
 * The single error type crossing every VAP boundary. HTTP failure alone never proves
 * that a previously submitted effect did not occur; OUTCOME_UNKNOWN and
 * DESTINATION_UNAVAILABLE therefore default to reconcile_first.
 */
export class VapError extends Error {
  readonly code: ErrorCode;
  readonly retryDisposition: RetryDisposition;
  readonly httpStatus: number;
  readonly operationId: string | null;
  readonly details: Record<string, unknown>;
  readonly evidenceRefs: string[];

  constructor(code: ErrorCode, message: string, opts: VapErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "VapError";
    this.code = code;
    this.retryDisposition = opts.retry ?? DEFAULTS[code].retry;
    this.httpStatus = opts.status ?? DEFAULTS[code].status;
    this.operationId = opts.operationId ?? null;
    this.details = opts.details ?? {};
    this.evidenceRefs = opts.evidenceRefs ?? [];
  }

  toBody(): VapErrorBody {
    return {
      code: this.code,
      message: this.message,
      retry_disposition: this.retryDisposition,
      operation_id: this.operationId,
      details: this.details,
      evidence_refs: this.evidenceRefs,
    };
  }

  static fromBody(body: VapErrorBody, status?: number): VapError {
    return new VapError(body.code, body.message, {
      retry: body.retry_disposition,
      status,
      operationId: body.operation_id ?? null,
      details: body.details ?? {},
      evidenceRefs: body.evidence_refs ?? [],
    });
  }
}

export function isVapError(e: unknown): e is VapError {
  return e instanceof VapError;
}

export function httpStatusFor(code: ErrorCode): number {
  return DEFAULTS[code].status;
}

export function defaultRetryDisposition(code: ErrorCode): RetryDisposition {
  return DEFAULTS[code].retry;
}
