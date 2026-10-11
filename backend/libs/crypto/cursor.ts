// Signed pagination cursors (40 §3.1 `Cursor`, §2.17): opaque base64url,
// HMAC-SHA-256 signed, bound to the caller and the query, valid 15 minutes.
// Layout before base64url: tag(16 bytes, truncated HMAC) | JSON payload.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { KeyRing } from './keys.js';

export const CURSOR_TTL_MS = 15 * 60 * 1000;
const TAG = 16;
const MAX_LEN = 512;

interface CursorPayload {
  /** Principal binding (hash). */
  p: string;
  /** Query binding (hash of operation + filters). */
  q: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Position data of the operation (e.g. last sort key and id). */
  d: unknown;
}

export type CursorCheck = { ok: true; position: unknown } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' };

const short = (s: string): string => createHash('sha256').update(s).digest('base64url').slice(0, 16);

export class CursorSigner {
  readonly #key: Buffer;

  constructor(keys: KeyRing) {
    this.#key = keys.hmacKey('cursor');
  }

  #tag(body: Buffer): Buffer {
    return createHmac('sha256', this.#key).update(body).digest().subarray(0, TAG);
  }

  sign(principal: string, query: string, position: unknown, now = Date.now()): string {
    const payload: CursorPayload = { p: short(principal), q: short(query), e: Math.floor((now + CURSOR_TTL_MS) / 1000), d: position };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const out = Buffer.concat([this.#tag(body), body]).toString('base64url');
    if (out.length > MAX_LEN) throw new Error(`cursor too long (${out.length} > ${MAX_LEN}); keep positions small`);
    return out;
  }

  verify(cursor: string, principal: string, query: string, now = Date.now()): CursorCheck {
    if (cursor.length === 0 || cursor.length > MAX_LEN || !/^[A-Za-z0-9_-]+$/.test(cursor)) return { ok: false, reason: 'malformed' };
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.length <= TAG) return { ok: false, reason: 'malformed' };
    const tag = raw.subarray(0, TAG);
    const body = raw.subarray(TAG);
    if (!timingSafeEqual(tag, this.#tag(body))) return { ok: false, reason: 'signature' };
    let payload: CursorPayload;
    try {
      payload = JSON.parse(body.toString('utf8')) as CursorPayload;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (payload.e * 1000 < now) return { ok: false, reason: 'expired' };
    if (payload.p !== short(principal) || payload.q !== short(query)) return { ok: false, reason: 'mismatch' };
    return { ok: true, position: payload.d };
  }
}
