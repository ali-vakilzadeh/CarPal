// The caller's address for rate limits and audit IP prefixes (backend S26c.T2, NI-19; 40 §1.3, §2.8).
//   1. A confidential BFF client (cp-web-consumer, cp-web-admin, cp-ssr) may state its visitor's address in
//      CarPal-Forwarded-Client: a compact JWS signed with its private_key_jwt key (CARPAL_OAUTH_CLIENT_JWKS), bound
//      to the host, method and URL like a DPoP proof, valid for at most 60 s. A header that does not verify is
//      ignored (and logged): it never fails the request.
//   2. Otherwise X-Forwarded-For counts only when the connection comes from a trusted proxy (CARPAL_TRUSTED_PROXIES):
//      the last address that is not a trusted proxy is the client (nginx appends the address it saw).
//   3. Otherwise the connection's own address.
import { isIP } from 'node:net';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { CLIENTS, type ClientId } from '#libs/auth/index.js';

export const FORWARDED_CLIENT_HEADER = 'carpal-forwarded-client';
export const FORWARDED_CLIENT_TYP = 'carpal-fwd+jwt';
const MAX_LIFETIME_S = 60;
const SKEW_S = 30;

/** An IP literal in canonical form (lower case, IPv4-mapped IPv6 as IPv4), or undefined. */
export function normalizeIp(address: string | undefined): string | undefined {
  if (!address) return undefined;
  let a = address.trim().toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  return isIP(a) ? a : undefined;
}

/** The client behind trusted proxies: X-Forwarded-For read from the right, skipping trusted proxies. */
export function forwardedFor(peer: string | undefined, xff: string | undefined, trusted: ReadonlySet<string>): string | undefined {
  const p = normalizeIp(peer);
  if (!p || !trusted.has(p) || !xff) return p;
  const hops = xff.split(',');
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    if (!hop) return p; // a malformed hop: trust nothing to its left
    if (!trusted.has(hop)) return hop;
  }
  return p;
}

export interface ForwardedClient {
  clientId: ClientId;
  ip: string;
}

export interface ForwardedCheck {
  /** The host's URL: the issuer on the auth host, the API audience on api and admin-api. */
  audience: string;
  method: string;
  /** The request URL without query (audience + path). */
  htu: string;
}

/** Verifies CarPal-Forwarded-Client statements of the confidential clients with registered keys. */
export class ForwardedClientVerifier {
  readonly #keys = new Map<string, JWTVerifyGetKey>();

  constructor(clientJwks: Readonly<Record<string, { keys: Record<string, unknown>[] }>>) {
    for (const [id, set] of Object.entries(clientJwks))
      if (id in CLIENTS && CLIENTS[id as ClientId].kind === 'confidential')
        this.#keys.set(id, createLocalJWKSet(set as unknown as JSONWebKeySet));
  }

  /** The stated client and address, or the reason the statement was refused. */
  async verify(token: string, c: ForwardedCheck): Promise<ForwardedClient | { refused: string }> {
    let iss: unknown;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      return { refused: 'malformed' };
    }
    const keys = typeof iss === 'string' ? this.#keys.get(iss) : undefined;
    if (!keys) return { refused: 'unknown client' };
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['EdDSA', 'ES256'],
        typ: FORWARDED_CLIENT_TYP,
        issuer: iss as string,
        subject: iss as string,
        audience: c.audience,
        clockTolerance: SKEW_S,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'htm', 'htu', 'cip'],
      });
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp! - payload.iat! > MAX_LIFETIME_S || payload.exp! - now > MAX_LIFETIME_S + SKEW_S) return { refused: 'lifetime' };
      if (payload.htm !== c.method || payload.htu !== c.htu) return { refused: 'htm/htu' };
      const ip = normalizeIp(typeof payload.cip === 'string' ? payload.cip : undefined);
      if (!ip) return { refused: 'cip' };
      return { clientId: iss as ClientId, ip };
    } catch (err) {
      return { refused: (err as Error).message.slice(0, 120) };
    }
  }
}
