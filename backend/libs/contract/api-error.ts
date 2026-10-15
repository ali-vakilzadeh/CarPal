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
  /** Optional Problem members of 40 §4.2 (DI-10): sent to the client. */
  extensions?: ProblemExtensions;
}

/** 40 §4.2 optional Problem members that name what is missing (DI-10). */
export interface ProblemExtensions {
  /** PUBLISH_REQUIREMENTS_UNMET: unmet publish rule keys (≤ 20). */
  requirements?: string[];
  /** CONSENT_REQUIRED: the missing consent type. */
  consent_type?: string;
  /** ENTITLEMENT_REQUIRED: the plan entitlement key. */
  entitlement_key?: string;
  /** AI_UNAVAILABLE on Help Me triage: the server-computed safety block (40 triage.start, SEC-AI-7). */
  safety?: TriageSafety;
  /** AI_UNAVAILABLE: the non-AI path the client can take instead (e.g. direct search). */
  fallback_path?: string;
  /** DUPLICATE at /vin: another owner has the VIN; a transfer can be requested (GD-33). */
  vin_transfer_available?: boolean;
}

/** 40 SafetyBlock & { do_not_drive }. */
export interface TriageSafety {
  flag: boolean;
  level: 'none' | 'warning' | 'urgent';
  message_i18n_key: string | null;
  urgent_help_available: boolean;
  do_not_drive: boolean;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly retryAfterMs: number | undefined;
  readonly headers: Record<string, string>;
  readonly extensions: ProblemExtensions | undefined;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.detail = options.detail;
    this.errors = options.errors?.slice(0, 50);
    this.headers = { ...options.headers };
    this.extensions = options.extensions;
    const needsDelay = this.status === 429 || this.status === 503;
    this.retryAfterMs = options.retryAfterMs ?? (needsDelay ? 1_000 : undefined);
    if (this.retryAfterMs !== undefined) this.retryAfterMs = Math.min(3_600_000, Math.max(100, Math.ceil(this.retryAfterMs)));
  }

  static validation(errors: FieldError[], code: ErrorCode = 'VALIDATION_FAILED'): ApiError {
    return new ApiError(code, { errors });
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
