// HMAC-SHA-256 helpers (40 §2.17): link tokens, OTP, refresh tokens at rest,
// vin_hash, lookup hashes. Results are 32 bytes (core.hash). Comparison is
// constant time.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HmacPurpose, KeyRing } from './keys.js';

export class Hmac {
  constructor(private readonly keys: KeyRing) {}

  /** 32-byte HMAC-SHA-256 of `data` with the purpose's key. */
  digest(purpose: HmacPurpose, data: string | Buffer): Buffer {
    return createHmac('sha256', this.keys.hmacKey(purpose)).update(data).digest();
  }

  /** Constant-time check of `data` against a stored digest. */
  verify(purpose: HmacPurpose, data: string | Buffer, expected: Buffer): boolean {
    const actual = this.digest(purpose, data);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }
}

export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();

/** Constant-time equality for two byte strings of possibly different length. */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = typeof a === 'string' ? Buffer.from(a) : a;
  const y = typeof b === 'string' ? Buffer.from(b) : b;
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // keep the timing independent of where the mismatch is
    return false;
  }
  return timingSafeEqual(x, y);
}
