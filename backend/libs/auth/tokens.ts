// Access tokens (40 SEC-AU-2, RFC 9068): JWT, typ at+jwt, EdDSA only, kid
// required and known, no jku/x5u/jwk/x5c headers, iss/aud/exp/nbf/iat (skew
// <= 30 s), client_id, sid, acr, auth_time and cnf validated on every request.
// The issuer side is used by the auth server (S3) and the test harness.
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify, SignJWT, type JWK, type JWTHeaderParameters } from 'jose';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';
import type { JwtKeyRing } from './keys.js';
import type { Acr } from './principal.js';

export const ANONYMOUS_ACR = 'anonymous';
const CLOCK_SKEW_S = 30;
/** Longest accepted lifetime: anonymous tokens live 15 min, user tokens 5 min (40 §2.2). */
const MAX_TOKEN_LIFETIME_S = 15 * 60;

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  client_id: string;
  /** Session id; absent on anonymous tokens. */
  sid?: string;
  acr: Acr | typeof ANONYMOUS_ACR;
  auth_time?: number;
  scope: string;
  /** Proof-of-possession binding: DPoP key thumbprint or mTLS certificate thumbprint. */
  cnf?: { jkt?: string; 'x5t#S256'?: string };
}

export interface IssueOptions {
  subject: string;
  clientId: string;
  audience: string;
  sessionId?: string;
  acr: Acr | typeof ANONYMOUS_ACR;
  authTime?: number;
  scope: string;
  ttlSeconds: number;
  cnf?: AccessTokenClaims['cnf'];
  /** Override "now" (epoch seconds), tests only. */
  now?: number;
}

const unauthenticated = (detail: string, headers: Record<string, string> = {}): ApiError =>
  new ApiError('UNAUTHENTICATED', {
    detail,
    headers: { 'www-authenticate': 'DPoP error="invalid_token", Bearer error="invalid_token"', ...headers },
  });

export class TokenService {
  constructor(
    private readonly keys: JwtKeyRing,
    private readonly issuer: string,
  ) {}

  async issue(o: IssueOptions): Promise<string> {
    if (o.ttlSeconds <= 0 || o.ttlSeconds > MAX_TOKEN_LIFETIME_S) throw new Error(`token lifetime must be 1..${MAX_TOKEN_LIFETIME_S} s`);
    const now = o.now ?? Math.floor(Date.now() / 1000);
    const k = this.keys.active;
    const claims: Record<string, unknown> = { client_id: o.clientId, acr: o.acr, scope: o.scope };
    if (o.sessionId) claims.sid = o.sessionId;
    if (o.authTime !== undefined) claims.auth_time = o.authTime;
    if (o.cnf) claims.cnf = o.cnf;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: k.kid })
      .setIssuer(this.issuer)
      .setAudience(o.audience)
      .setSubject(o.subject)
      .setJti(uuidv7())
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + o.ttlSeconds)
      .sign(k.privateKey);
  }

  /**
   * OIDC ID token (OpenID Connect Core §2): EdDSA, audience = client_id,
   * nonce from the authorization request. Carries no roles and no contact data.
   */
  async issueIdToken(o: {
    subject: string;
    clientId: string;
    nonce: string;
    authTime: number;
    acr: Acr;
    sessionId: string;
    ttlSeconds: number;
    now?: number;
  }): Promise<string> {
    const now = o.now ?? Math.floor(Date.now() / 1000);
    const k = this.keys.active;
    return new SignJWT({ nonce: o.nonce, auth_time: o.authTime, acr: o.acr, sid: o.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: k.kid })
      .setIssuer(this.issuer)
      .setAudience(o.clientId)
      .setSubject(o.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + o.ttlSeconds)
      .sign(k.privateKey);
  }

  /** Verifies signature and registered claims; throws 401 UNAUTHENTICATED on any failure. */
  async verify(token: string, audience: string, now?: number): Promise<AccessTokenClaims> {
    let payload: AccessTokenClaims;
    try {
      const res = await jwtVerify(
        token,
        (header: JWTHeaderParameters) => {
          if (header.alg !== 'EdDSA') throw new Error('alg');
          for (const forbidden of ['jku', 'x5u', 'jwk', 'x5c'] as const) if (forbidden in header) throw new Error(`header ${forbidden}`);
          const key = header.kid ? this.keys.publicKey(header.kid) : undefined;
          if (!key) throw new Error('kid');
          return key;
        },
        {
          algorithms: ['EdDSA'],
          typ: 'at+jwt',
          issuer: this.issuer,
          audience,
          clockTolerance: CLOCK_SKEW_S,
          requiredClaims: ['iss', 'aud', 'sub', 'exp', 'nbf', 'iat', 'jti', 'client_id', 'acr', 'scope'],
          ...(now !== undefined ? { currentDate: new Date(now * 1000) } : {}),
        },
      );
      payload = res.payload as unknown as AccessTokenClaims;
    } catch (err) {
      throw unauthenticated(`token rejected: ${(err as Error).message}`);
    }
    const t = now ?? Math.floor(Date.now() / 1000);
    if (payload.iat > t + CLOCK_SKEW_S) throw unauthenticated('iat in the future');
    if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_S) throw unauthenticated('token lifetime too long');
    if (typeof payload.client_id !== 'string' || typeof payload.scope !== 'string') throw unauthenticated('claims');
    const anonymous = payload.acr === ANONYMOUS_ACR;
    if (!anonymous && !['aal1', 'aal2', 'aal3'].includes(payload.acr)) throw unauthenticated('acr');
    if (!anonymous && (typeof payload.sid !== 'string' || typeof payload.auth_time !== 'number')) throw unauthenticated('sid/auth_time');
    return payload;
  }
}

// ------------------------------------------------------------------ DPoP

export interface DpopCheck {
  proof: string;
  method: string;
  /** Request URL without query and fragment (scheme, host, path). */
  htu: string;
  /** Access token the proof is bound to (ath); absent at the token endpoint. */
  accessToken?: string;
  /** Thumbprint the token is bound to (cnf.jkt); absent where the proof creates the binding (token endpoint). */
  expectedJkt?: string;
  /** Server nonce the proof must carry (DPoP-Nonce; required at /oauth/token in strict mode). */
  nonce?: string;
  now?: number;
}

/**
 * DPoP proof (40 SEC-AU-6, RFC 9449): typ dpop+jwt, ES256 device key embedded
 * in the header, htm/htu match, iat within ±60 s, jti unique per key for
 * 5 min, ath = base64url(SHA-256(access token)), key thumbprint = cnf.jkt.
 */
export async function verifyDpopProof(c: DpopCheck, kv: KeyValueStore): Promise<string> {
  let payload: Record<string, unknown>;
  let jwk: JWK;
  try {
    const res = await jwtVerify(c.proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ['ES256'] });
    payload = res.payload as Record<string, unknown>;
    jwk = res.protectedHeader.jwk!;
  } catch (err) {
    throw unauthenticated(`DPoP proof rejected: ${(err as Error).message}`);
  }
  const now = c.now ?? Math.floor(Date.now() / 1000);
  if (payload.htm !== c.method) throw unauthenticated('DPoP htm');
  if (payload.htu !== c.htu) throw unauthenticated('DPoP htu');
  if (typeof payload.iat !== 'number' || Math.abs(payload.iat - now) > 60) throw unauthenticated('DPoP iat');
  if (c.accessToken !== undefined && payload.ath !== createHash('sha256').update(c.accessToken).digest('base64url'))
    throw unauthenticated('DPoP ath');
  if (c.nonce !== undefined && payload.nonce !== c.nonce) throw unauthenticated('DPoP nonce');
  if (typeof payload.jti !== 'string' || payload.jti.length > 128) throw unauthenticated('DPoP jti');
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  if (c.expectedJkt !== undefined && jkt !== c.expectedJkt) throw unauthenticated('DPoP key does not match cnf.jkt');
  const fresh = await kv.set(`auth:dpop-jti:${jkt}:${payload.jti}`, '1', { ttlMs: 5 * 60_000, mode: 'NX' });
  if (!fresh) throw unauthenticated('DPoP proof replayed');
  return jkt;
}
