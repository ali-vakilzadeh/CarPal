// CarPal-Forwarded-Client (AC14b.T7, Docs/40 1.5.0 §1.3, backend S26c.T2, NI-19): the BFF states its visitor's IP
// address on every call it makes for a browser (admin-api through the forwarder, the auth host through the /id proxy),
// so the backend's per-IP rate limits and audit IP prefixes see each staff member instead of the console server.
// A compact JWS signed with the cp-web-admin private_key_jwt key (the key the backend knows from
// CARPAL_OAUTH_CLIENT_JWKS): typ carpal-fwd+jwt; iss = sub = cp-web-admin; aud = the host's URL (the admin API
// audience, or the issuer on the auth host); htm and htu of the request as in DPoP (htu without query); cip; iat; exp
// 60 s later (backend libs/http-pipeline/client-address.ts verifies exactly this). The header is optional: without a
// key (lite dev), without a usable address, or when signing fails, it is left out and the request goes on.
//
// The visitor's address: Next.js has no request.ip; its server fills X-Forwarded-For with the socket address only when
// the header is absent. In production the console listens on loopback behind nginx, which sets
// `X-Forwarded-For $proxy_add_x_forwarded_for` (the address it saw is appended last), so the last hop is the visitor
// and anything a browser sent is to its left (AC11 deploy kit). Without nginx (dev, E2E) the last hop is the socket
// address or what the client sent; there the statement only feeds rate limits of a test backend.
import { isIP } from 'node:net';
import { importJWK, SignJWT, type JWK } from 'jose';

export const FORWARDED_CLIENT_HEADER = 'carpal-forwarded-client';
export const FORWARDED_CLIENT_TYP = 'carpal-fwd+jwt';
/** The backend refuses a statement that lives longer than 60 s. */
export const FORWARDED_CLIENT_LIFETIME_S = 60;

export interface ForwardedStatement {
  /** The host's URL: the admin API audience, or the issuer for the auth host. */
  audience: string;
  /** Upper-case HTTP method of the call. */
  method: string;
  /** audience + path, without the query. */
  htu: string;
  /** The visitor's IPv4 or IPv6 address. */
  ip: string;
}

export type ForwardedClientSigner = (s: ForwardedStatement) => Promise<string>;

/** A signer with the client's private key; the key is imported once, on first use. */
export function forwardedClientSigner(
  key: JWK & { kid: string },
  alg: 'EdDSA' | 'ES256',
  clientId: string,
  now: () => number = Date.now,
): ForwardedClientSigner {
  let imported: ReturnType<typeof importJWK> | null = null;
  return async (s) => {
    imported ??= importJWK(key, alg);
    imported.catch(() => (imported = null));
    const iat = Math.floor(now() / 1000);
    return new SignJWT({ htm: s.method, htu: s.htu, cip: s.ip })
      .setProtectedHeader({ alg, typ: FORWARDED_CLIENT_TYP, kid: key.kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(s.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + FORWARDED_CLIENT_LIFETIME_S)
      .sign(await imported);
  };
}

/** An IP literal in canonical form (IPv4-mapped IPv6 as IPv4, brackets dropped), or null. */
export function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  let a = raw.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  return isIP(a) ? a : null;
}

/** The visitor's address: the last X-Forwarded-For hop (the one nginx, or Next.js itself, appended); null if unusable. */
export function visitorIp(request: Request): string | null {
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return null;
  return normalizeIp(xff.split(',').at(-1));
}

/** The header value for this call, or null (no signer, no usable address, or signing failed: never fails the call). */
export async function forwardedClientHeader(
  signer: ForwardedClientSigner | undefined,
  request: Request,
  s: Omit<ForwardedStatement, 'ip'>,
): Promise<string | null> {
  if (!signer) return null;
  const ip = visitorIp(request);
  if (!ip) return null;
  try {
    return await signer({ ...s, ip });
  } catch {
    return null;
  }
}
