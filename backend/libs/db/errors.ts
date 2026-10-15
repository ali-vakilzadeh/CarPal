// Maps PostgreSQL errors to contract error codes (40 §4.3/§4.4, 42 §5.3, §6).
// Link-token functions raise P0410/P0411/P0403/P0409; transition and taxonomy
// triggers raise 23514 with the code as message prefix; modules register
// their constraint names for unique/check violations with a specific meaning.
import { ApiError, type ErrorCode, type FieldError } from '#libs/contract/index.js';

export interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  schema?: string;
}

export const isPgError = (e: unknown): e is PgErrorLike & Error =>
  e instanceof Error && typeof (e as PgErrorLike).code === 'string' && /^[0-9A-Z]{5}$/.test((e as PgErrorLike).code!);

export interface ConstraintMapping {
  code: ErrorCode;
  /** JSON pointer of the offending input field, when one applies. */
  pointer?: string;
  fieldCode?: FieldError['code'];
}

const constraintRegistry = new Map<string, ConstraintMapping>();

/** Modules register what their named constraints mean, e.g. { reviews_one_per_visit_uq: { code: 'DUPLICATE' } }. */
export function registerConstraintErrors(map: Record<string, ErrorCode | ConstraintMapping>): void {
  for (const [name, m] of Object.entries(map)) constraintRegistry.set(name, typeof m === 'string' ? { code: m } : m);
}

/** SQLSTATEs after which the whole transaction may be retried. */
export const RETRYABLE_SQLSTATES = new Set(['40001' /* serialization_failure */, '40P01' /* deadlock_detected */]);

const SQLSTATE_CODES: Record<string, ErrorCode> = {
  P0410: 'LINK_EXPIRED',
  P0411: 'LINK_USED',
  P0403: 'LINK_RECIPIENT_MISMATCH',
  P0409: 'INVALID_TRANSITION',
  '28000': 'UNAUTHENTICATED',
  '23503': 'REFERENCE_NOT_FOUND',
  '40001': 'UNAVAILABLE',
  '40P01': 'UNAVAILABLE',
  '55P03': 'UNAVAILABLE', // lock_not_available (lock_timeout)
  '57014': 'UNAVAILABLE', // query_canceled (statement_timeout)
  '53300': 'UNAVAILABLE', // too_many_connections
  '57P01': 'UNAVAILABLE', // admin_shutdown
};

const MESSAGE_PREFIX_CODES: [string, ErrorCode][] = [
  ['INVALID_TRANSITION', 'INVALID_TRANSITION'],
  ['NOT_FOUND', 'NOT_FOUND'],
  ['TAXONOMY_MISMATCH', 'TAXONOMY_MISMATCH'],
  ['LINK_EXPIRED', 'LINK_EXPIRED'],
  ['LINK_USED', 'LINK_USED'],
  ['LINK_RECIPIENT_MISMATCH', 'LINK_RECIPIENT_MISMATCH'],
];

/**
 * Converts a database error into an ApiError. Anything unexpected becomes
 * INTERNAL (the original error is kept as cause for the log, never sent).
 */
export function mapDbError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (!isPgError(err)) return new ApiError('INTERNAL', { detail: err instanceof Error ? err.message : String(err), cause: err });
  const code = err.code!;
  const message = err.message ?? '';
  const detail = `${code} ${message}`.slice(0, 500);

  if (err.constraint) {
    const m = constraintRegistry.get(err.constraint);
    if (m) {
      const errors: FieldError[] | undefined = m.pointer ? [{ pointer: m.pointer, code: m.fieldCode ?? 'not_unique' }] : undefined;
      return new ApiError(m.code, { detail, cause: err, ...(errors ? { errors } : {}) });
    }
  }
  for (const [prefix, c] of MESSAGE_PREFIX_CODES) if (message.startsWith(prefix)) return new ApiError(c, { detail, cause: err });

  switch (code) {
    case '23505':
      return new ApiError('DUPLICATE', { detail, cause: err });
    case '23514': // check_violation not caught by input validation
    case '22P02': // invalid_text_representation
    case '22001': // string_data_right_truncation
    case '22003': // numeric_value_out_of_range
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '23P01': // exclusion_violation
      return new ApiError('VALIDATION_FAILED', { detail, cause: err });
    case '42501':
      // A row outside the caller's RLS scope is reported like a missing one (SEC-AZ-3);
      // other privilege errors are configuration defects.
      if (message.includes('row-level security')) return new ApiError('NOT_FOUND', { detail, cause: err });
      return new ApiError('INTERNAL', { detail, cause: err });
  }
  const mapped = SQLSTATE_CODES[code];
  if (mapped) return new ApiError(mapped, { detail, cause: err, ...(mapped === 'UNAVAILABLE' ? { retryAfterMs: 1_000 } : {}) });
  if (code.startsWith('08')) return new ApiError('UNAVAILABLE', { detail, cause: err, retryAfterMs: 2_000 });
  return new ApiError('INTERNAL', { detail, cause: err });
}
