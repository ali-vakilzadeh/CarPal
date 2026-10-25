// Random identifiers, PKCE (RFC 7636 S256) and constant-time comparison for the BFF. WebCrypto only, so the code
// runs unchanged in any standard runtime (GD-03).

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256 random bits, base64url (43 characters): session ids, CSRF secrets, state, nonce, PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64url(input: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A fresh PKCE pair: a 43-character verifier and its S256 challenge. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256Base64url(verifier) };
}

/** Compares two strings without an early exit on the first differing character. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, variant 10, random rest. */
export function uuidv7(now = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
