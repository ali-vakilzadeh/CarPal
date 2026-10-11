// L12 link tokens (41 §2.2, 40 SEC-LT): `cp_<type>_<43 base64url>` = 256
// random bits, stored only as HMAC-SHA-256 (constant-time compare), sent in
// URL fragments, consumed atomically with one conditional UPDATE. Expired and
// unknown tokens are both 410 LINK_EXPIRED (no oracle); used ones 410
// LINK_USED; a token bound to another person 403 LINK_RECIPIENT_MISMATCH.
import { randomBytes } from 'node:crypto';
import { ApiError } from '#libs/contract/index.js';
import type { Hmac } from '#libs/crypto/index.js';

const H = 3_600_000;
/** SEC-LT-3. `ci` lives until confirmed_end_at + 12 h (set by the appointment module). */
export const LINK_TYPES = {
  ri: { purpose: 'review invitation', ttlMs: 7 * 24 * H, singleUse: true },
  ci: { purpose: 'appointment check-in', ttlMs: null, singleUse: false },
  ev: { purpose: 'email verification', ttlMs: 24 * H, singleUse: true },
  pr: { purpose: 'password reset', ttlMs: 30 * 60_000, singleUse: true },
  mi: { purpose: 'member invitation', ttlMs: 7 * 24 * H, singleUse: true },
  cn: { purpose: 'consent request', ttlMs: 14 * 24 * H, singleUse: true },
} as const;
export type LinkType = keyof typeof LINK_TYPES;

const TOKEN = /^cp_(ri|ci|ev|pr|mi|cn)_([A-Za-z0-9_-]{43})$/;

export interface IssuedLinkToken {
  /** Returned to the recipient once (in a link fragment); never stored or logged. */
  token: string;
  /** 32-byte HMAC to store (core.hash). */
  hash: Buffer;
  expiresAt: Date | null;
}

export class LinkTokens {
  constructor(
    private readonly hmac: Hmac,
    private readonly linkBase = 'https://carpal.app/l',
  ) {}

  issue(type: LinkType, now = Date.now(), expiresAt?: Date): IssuedLinkToken {
    const token = `cp_${type}_${randomBytes(32).toString('base64url')}`;
    const ttl = LINK_TYPES[type].ttlMs;
    return { token, hash: this.hash(token), expiresAt: expiresAt ?? (ttl === null ? null : new Date(now + ttl)) };
  }

  hash(token: string): Buffer {
    return this.hmac.digest('link-token', token);
  }

  /**
   * Checks the token format and type from a request body. A malformed token or
   * one of another type behaves like an unknown one (410 LINK_EXPIRED).
   */
  parse(value: unknown, type: LinkType): { token: string; hash: Buffer } {
    const m = typeof value === 'string' ? TOKEN.exec(value) : null;
    if (!m || m[1] !== type) throw new ApiError('LINK_EXPIRED', { detail: 'malformed or foreign link token' });
    return { token: value as string, hash: this.hash(value as string) };
  }

  /** Link with the token in the fragment (SEC-LT-2): never sent to servers or in Referer. */
  link(type: LinkType, token: string): string {
    return `${this.linkBase}/${type}#${token}`;
  }
}

/**
 * Explains why the atomic consume (`UPDATE … WHERE token_hash = $1 AND
 * used_at IS NULL AND expires_at > now() RETURNING …`) changed no row, from a
 * follow-up read of the same hash (undefined when unknown).
 */
export function consumeFailure(row: { used_at: Date | string | null } | undefined): ApiError {
  if (row?.used_at) return new ApiError('LINK_USED');
  return new ApiError('LINK_EXPIRED');
}

/** SEC-LT-5: a token bound to a person needs the caller to be that person. */
export function assertRecipient(
  bound: { userId?: string | null; email?: string | null },
  caller: { userId: string; verifiedEmail?: string | null },
): void {
  const byId = bound.userId != null && bound.userId === caller.userId;
  const byEmail = bound.email != null && caller.verifiedEmail != null && bound.email.toLowerCase() === caller.verifiedEmail.toLowerCase();
  if (!byId && !byEmail) throw new ApiError('LINK_RECIPIENT_MISMATCH');
}
