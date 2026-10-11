// Errors raised anywhere in the backend and rendered as application/problem+json
// (40 §4.2, RFC 9457) by the HTTP pipeline. Only codes of the contract catalog
// (40 §4.3/§4.4) exist; the HTTP status comes from the catalog.
import { ERROR_CODES, type ErrorCode } from './generated/errors.js';

/** 40 §4.2 FieldErrorCode. */
export type FieldErrorCode =
  | 'required'
  | 'unknown_field'
  | 'read_only'
  | 'type'
  | 'too_short'
  | 'too_long'
  | 'out_of_range'
  | 'pattern'
  | 'enum'
  | 'forbidden_character'
  | 'not_unique'
  | 'reference_not_found'
  | 'conditional_required'
  | 'conditional_forbidden'
  | 'in_past'
  | 'in_future'
  | 'order';

/** 40 §4.2 FieldError: an RFC 6901 pointer into the request body (or "/query/<name>"). */
export interface FieldError {
  pointer: string;
  code: FieldErrorCode;
  limit?: string;
}

export interface ApiErrorOptions {
  /** Internal detail for logs only; never sent to the client (SEC-OUT-5). */
  detail?: string;
  errors?: FieldError[];
  /** Retry delay for 429/503 (SEC-RL-1). Defaults to 1 s on those statuses. */
  retryAfterMs?: number;
  /** Extra response headers (WWW-Authenticate, Allow, RateLimit…). */
  headers?: Record<string, string>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly retryAfterMs: number | undefined;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.detail = options.detail;
    this.errors = options.errors?.slice(0, 50);
    this.headers = { ...options.headers };
    const needsDelay = this.status === 429 || this.status === 503;
    this.retryAfterMs = options.retryAfterMs ?? (needsDelay ? 1_000 : undefined);
    if (this.retryAfterMs !== undefined) this.retryAfterMs = Math.min(3_600_000, Math.max(100, Math.ceil(this.retryAfterMs)));
  }

  static validation(errors: FieldError[], code: ErrorCode = 'VALIDATION_FAILED'): ApiError {
    return new ApiError(code, { errors });
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
