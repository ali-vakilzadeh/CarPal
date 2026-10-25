// DPoP (RFC 9449) for the BFF: one ES256 key pair per pre-session binds its anonymous tokens, so the backend's
// anonymous key (HMAC of cnf.jkt) stays the same across the 15-minute renewals (DI-17, GD-07 amendment).
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { randomToken, sha256Base64url } from '../crypto';

/** A new exportable key pair, kept as a private JWK in the session record. */
export async function generateDpopKey(): Promise<JWK> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return exportJWK(privateKey);
}

export function publicJwk(privateJwk: JWK): JWK {
  const { kty, crv, x, y } = privateJwk;
  return { kty, crv, x, y } as JWK;
}

export async function jwkThumbprint(privateJwk: JWK): Promise<string> {
  return calculateJwkThumbprint(publicJwk(privateJwk), 'sha256');
}

/**
 * One proof: htm and htu (scheme, host, path; no query), iat, a fresh jti, and `ath` when it accompanies an access
 * token (SEC-AU-6). `nonce` only when the server asked for one (DPoP-Nonce).
 */
export async function dpopProof(
  privateJwk: JWK,
  o: { method: string; url: string; accessToken?: string; nonce?: string; now?: number },
): Promise<string> {
  const key = await importJWK(privateJwk, 'ES256');
  const u = new URL(o.url);
  const claims: Record<string, unknown> = {
    htm: o.method.toUpperCase(),
    htu: `${u.protocol}//${u.host}${u.pathname}`,
    jti: randomToken(16),
  };
  if (o.accessToken) claims.ath = await sha256Base64url(o.accessToken);
  if (o.nonce) claims.nonce = o.nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk(privateJwk) })
    .setIssuedAt(o.now === undefined ? undefined : Math.floor(o.now / 1000))
    .sign(key);
}
