// Credential primitives of the identity module (40 SEC-AU-7..9, SEC-BF-7,
// RFC 6238, RFC 7636): TOTP, one-time codes, recovery codes, PKCE S256,
// proof-of-work and the password policy. Pure functions; storage and HMAC
// keys are the callers' concern.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// ------------------------------------------------------------------ TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_S = 30;

/** HOTP (RFC 4226) with HMAC-SHA-1 and 6 digits, as authenticator apps expect. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

export const totpStep = (nowMs = Date.now()): number => Math.floor(nowMs / 1000 / TOTP_STEP_S);

/**
 * TOTP check (SEC-AU-9): 30 s step, ±1 step, and a step at or before
 * `lastUsedStep` is refused (a used code cannot be replayed). Returns the
 * matched step, or null.
 */
export function verifyTotp(secret: Buffer, code: string, lastUsedStep: number | null, nowMs = Date.now()): number | null {
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (constantTimeEqual(hotp(secret, step), code)) return step;
  }
  return null;
}

export const newTotpSecret = (): Buffer => randomBytes(20);

/** otpauth:// provisioning URI (Key URI Format), ≤ 512 characters. */
export function otpauthUri(secret: Buffer, account: string, issuer = 'CarPal'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`.slice(
    0,
    512,
  );
}

// ------------------------------------------------------------------ codes

/** SEC-AU-8: 6 digits from a CSPRNG. */
export const newOtpCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten recovery codes "xxxxx-xxxxx" (52 AuthenticationMethod: one row per code, stored as HMAC). */
export function newRecoveryCodes(n = 10): string[] {
  const one = () => Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)]).join('');
  return Array.from({ length: n }, () => {
    const c = one();
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}

/** Recovery codes are compared without the dash and case-insensitively. */
export const normalizeRecoveryCode = (code: string): string => code.replace(/[\s-]/g, '').toLowerCase();

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ PKCE

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 S256: base64url(SHA-256(code_verifier)) equals the code challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  return constantTimeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

// ------------------------------------------------------------------ proof of work

/** Leading zero bits of SHA-256(prefix + nonce) (SEC-BF-7 hashcash). */
export function leadingZeroBits(prefix: string, nonce: string): number {
  const h = createHash('sha256')
    .update(prefix + nonce)
    .digest();
  let bits = 0;
  for (const byte of h) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** Finds a nonce (client side; tests). */
export function solvePow(prefix: string, difficultyBits: number): string {
  for (let i = 0; ; i++) if (leadingZeroBits(prefix, String(i)) >= difficultyBits) return String(i);
}

// ------------------------------------------------------------------ passwords

/**
 * Breached-password check (SEC-AU-7). Lite mode has no breached-password
 * corpus, so this refuses well-known passwords of the allowed length and
 * trivial patterns; full mode should consult a k-anonymity range service.
 */
const COMMON = new Set([
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  '123456789012',
  '1234567890123',
  '12345678901234',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwerty123456',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
  'carpalcarpal',
  'carpal123456',
  '1q2w3e4r5t6y',
  'abcdefghijkl',
  'abcd12345678',
]);

export function isBreachedPassword(password: string): boolean {
  const p = password.normalize('NFC').toLowerCase();
  if (COMMON.has(p)) return true;
  if (/^(.)\1+$/u.test(p)) return true; // one repeated character
  if (/^\d+$/.test(p) && '01234567890123456789012345678901234567890'.includes(p)) return true; // digit run
  return false;
}
