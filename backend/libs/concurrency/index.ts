// L7 concurrency (40 SEC-IC-3..5, 41 §7): ETag "v<version>" on versioned
// resources, If-Match required on ETAG operations (428 PRECONDITION_REQUIRED
// when missing, 412 VERSION_MISMATCH when stale), conditional updates on
// version. Row locks for transitions use Kysely's .forUpdate() in the use case.
import { ApiError } from '#libs/contract/index.js';

export const formatEtag = (version: number): string => `"v${version}"`;

/**
 * Parses If-Match. Returns the expected version, or undefined when the header
 * is absent and not required. A malformed or wildcard value can never match a
 * version, so it is reported as VERSION_MISMATCH.
 */
export function parseIfMatch(header: string | undefined, required: boolean): number | undefined {
  if (header === undefined || header === '') {
    if (required) throw new ApiError('PRECONDITION_REQUIRED', { detail: 'If-Match required' });
    return undefined;
  }
  const m = /^"v([1-9]\d{0,9})"$/.exec(header.trim());
  if (!m || Number(m[1]) > 2_147_483_647) throw new ApiError('VERSION_MISMATCH', { detail: 'malformed If-Match' });
  return Number(m[1]);
}

/** Throws 412 when the stored version differs from If-Match (no lost updates). */
export function assertVersion(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) throw new ApiError('VERSION_MISMATCH');
}

/**
 * For `UPDATE … WHERE id = $1 AND version = $2` statements: zero affected rows
 * means stale (or not visible); the caller distinguishes with a locked read.
 */
export function assertUpdated(affectedRows: bigint | number, expected: number | undefined): void {
  if (Number(affectedRows) === 0) throw new ApiError(expected === undefined ? 'NOT_FOUND' : 'VERSION_MISMATCH');
}
