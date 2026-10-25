// Server-to-server client of the authorization server (40 §6.2): discovery and JWKS (cached), the token endpoint
// (authorization_code, refresh_token, the anonymous grant, client_credentials for cp-ssr), revocation and the PoW
// challenge. The BFF calls the auth host directly (GD-05). Strict-mode seams (P2.T10): a pluggable client
// authentication, DPoP proofs whose htu is the issuer's token endpoint (DI-17), and a PoW hook for ATT grants.
import { SignJWT, createLocalJWKSet, importJWK, jwtVerify, type JWK, type JSONWebKeySet } from 'jose';
import { randomToken } from '../crypto';
import { dpopProof } from './dpop';
import { powHeader, solvePow, type PowChallenge } from './pow';

export interface Discovery {
  issuer: string;
  token_endpoint: string;
  authorization_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'DPoP' | 'Bearer';
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

/**
 * A failed call to the auth host. `error` is the RFC 6749 error (invalid_grant, invalid_client, use_dpop_nonce …) for
 * ProtocolError JSON, or the contract code (ATTESTATION_REQUIRED, RATE_LIMITED …) for problem+json (BA-12).
 */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly kind: 'oauth' | 'problem' | 'network',
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(`token endpoint: ${status} ${error}`);
  }

  /** The grant is dead (expired, reused or revoked refresh token, used code): the session ends. */
  get invalidGrant(): boolean {
    return this.kind === 'oauth' && this.error === 'invalid_grant';
  }
}

/** How the BFF authenticates to /oauth/token (none in lite; private_key_jwt over mTLS in strict mode, NI-01). */
export interface ClientAuthentication {
  readonly method: 'none' | 'private_key_jwt';
  apply(form: URLSearchParams, o: { clientId: string; tokenEndpoint: string }): Promise<void>;
}

export const noClientAuthentication: ClientAuthentication = {
  method: 'none',
  async apply(form, o) {
    form.set('client_id', o.clientId);
  },
};

/** RFC 7523 client assertion (60 s, single jti) signed with the client's private key. mTLS is a transport concern. */
export function privateKeyJwt(key: JWK & { kid: string }, alg: 'EdDSA' | 'ES256' = 'EdDSA'): ClientAuthentication {
  return {
    method: 'private_key_jwt',
    async apply(form, o) {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ jti: randomToken(16) })
        .setProtectedHeader({ alg, kid: key.kid })
        .setIssuer(o.clientId)
        .setSubject(o.clientId)
        .setAudience(o.tokenEndpoint)
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(await importJWK(key, alg));
      form.set('client_id', o.clientId);
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', assertion);
    },
  };
}

export interface TokenClientOptions {
  authUrl: string;
  clientHeader: (clientId: string) => string;
  fetch?: typeof fetch;
  clientAuth?: (clientId: string) => ClientAuthentication;
  /** Strict mode: solve PoW before ATT grants instead of waiting for a 403 ATTESTATION_REQUIRED. */
  powUpFront?: boolean;
  now?: () => number;
}

const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 600_000;
export const ANONYMOUS_GRANT = 'urn:carpal:params:oauth:grant-type:anonymous';

export class TokenClient {
  readonly #o: TokenClientOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #discovery: { value: Discovery; until: number } | undefined;
  #jwks: { value: ReturnType<typeof createLocalJWKSet>; until: number } | undefined;
  #dpopNonce: string | undefined;

  constructor(o: TokenClientOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
  }

  async discovery(): Promise<Discovery> {
    if (this.#discovery && this.#discovery.until > this.#now()) return this.#discovery.value;
    const value = (await this.#getJson('/.well-known/openid-configuration')) as unknown as Discovery;
    if (typeof value.issuer !== 'string' || typeof value.token_endpoint !== 'string')
      throw new TokenEndpointError(502, 'bad_discovery', 'network');
    this.#discovery = { value, until: this.#now() + DISCOVERY_TTL_MS };
    return value;
  }

  /** Verifies an ID token: EdDSA, kid in the JWKS (fetched from the internal auth URL), iss, aud = client, exp, nonce. */
  async verifyIdToken(idToken: string, o: { clientId: string; nonce: string }): Promise<Record<string, unknown>> {
    const { issuer } = await this.discovery();
    const verify = async (jwks: ReturnType<typeof createLocalJWKSet>) =>
      jwtVerify(idToken, jwks, {
        issuer,
        audience: o.clientId,
        algorithms: ['EdDSA'],
        clockTolerance: 30,
        currentDate: new Date(this.#now()),
      });
    let result;
    try {
      result = await verify(await this.#keys(false));
    } catch (err) {
      // A key rotated since the last fetch: refetch the JWKS once.
      if ((err as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw err;
      result = await verify(await this.#keys(true));
    }
    if (result.payload.nonce !== o.nonce) throw new Error('id_token nonce mismatch');
    return result.payload as Record<string, unknown>;
  }

  async #keys(force: boolean) {
    if (!force && this.#jwks && this.#jwks.until > this.#now()) return this.#jwks.value;
    const set = (await this.#getJson('/.well-known/jwks.json')) as unknown as JSONWebKeySet;
    this.#jwks = { value: createLocalJWKSet(set), until: this.#now() + JWKS_TTL_MS };
    return this.#jwks.value;
  }

  authorizationCode(clientId: string, o: { code: string; redirectUri: string; verifier: string }): Promise<TokenResponse> {
    return this.#token(clientId, {
      grant_type: 'authorization_code',
      code: o.code,
      redirect_uri: o.redirectUri,
      code_verifier: o.verifier,
    });
  }

  refresh(clientId: string, refreshToken: string, dpopKey?: JWK): Promise<TokenResponse> {
    return this.#token(clientId, { grant_type: 'refresh_token', refresh_token: refreshToken }, { dpopKey });
  }

  /** SEC-AU-14 anonymous grant, DPoP-bound with the pre-session's key (DI-17). ATT: PoW when the server asks. */
  anonymous(clientId: string, dpopKey: JWK): Promise<TokenResponse> {
    return this.#token(clientId, { grant_type: ANONYMOUS_GRANT }, { dpopKey, att: 'anonymous' });
  }

  clientCredentials(clientId: string, scope = 'public.read'): Promise<TokenResponse> {
    return this.#token(clientId, { grant_type: 'client_credentials', scope });
  }

  /** RFC 7009: always 200 from the server; network failures are reported to the caller. */
  async revoke(clientId: string, token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
    const form = new URLSearchParams({ token, token_type_hint: hint });
    await this.#form('/oauth/revoke', clientId, form, {});
  }

  /** auth.pow_challenge + solve: the CarPal-PoW header value. */
  async pow(clientId: string, purpose: 'anonymous' | 'signup' | 'signin' | 'review' | 'invitation'): Promise<string> {
    const res = await this.#fetch(`${this.#o.authUrl}/oauth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'carpal-client': this.#o.clientHeader(clientId) },
      body: JSON.stringify({ purpose }),
    });
    if (!res.ok) throw await errorOf(res);
    const c = (await res.json()) as PowChallenge;
    return powHeader(c.challenge_id, await solvePow(c));
  }

  async #token(
    clientId: string,
    fields: Record<string, string>,
    o: { dpopKey?: JWK | undefined; att?: 'anonymous' } = {},
  ): Promise<TokenResponse> {
    const attempt = async (pow?: string, nonceRetry = true): Promise<TokenResponse> => {
      try {
        return (await this.#form('/oauth/token', clientId, new URLSearchParams(fields), {
          dpopKey: o.dpopKey,
          pow,
        })) as unknown as TokenResponse;
      } catch (err) {
        if (!(err instanceof TokenEndpointError)) throw err;
        // Strict mode: a fresh DPoP nonce is required at /oauth/token (SEC-AU-6); the error carried it.
        if (err.error === 'use_dpop_nonce' && nonceRetry) return attempt(pow, false);
        // ATT without attestation: solve the server's proof of work once (DI-22).
        if (err.error === 'ATTESTATION_REQUIRED' && o.att && !pow) return attempt(await this.pow(clientId, o.att), nonceRetry);
        throw err;
      }
    };
    return attempt(o.att && this.#o.powUpFront ? await this.pow(clientId, o.att) : undefined);
  }

  async #form(
    path: string,
    clientId: string,
    form: URLSearchParams,
    o: { dpopKey?: JWK | undefined; pow?: string | undefined },
  ): Promise<Record<string, unknown>> {
    const d = await this.discovery();
    const endpoint = path === '/oauth/token' ? d.token_endpoint : d.revocation_endpoint;
    await (this.#o.clientAuth?.(clientId) ?? noClientAuthentication).apply(form, { clientId, tokenEndpoint: endpoint });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'carpal-client': this.#o.clientHeader(clientId),
    };
    // The proof names the public token endpoint (issuer URL), not the internal host the BFF connects to (DI-17).
    if (o.dpopKey && path === '/oauth/token')
      headers.dpop = await dpopProof(o.dpopKey, { method: 'POST', url: endpoint, ...(this.#dpopNonce ? { nonce: this.#dpopNonce } : {}) });
    if (o.pow) headers['carpal-pow'] = o.pow;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#o.authUrl}${path}`, { method: 'POST', headers, body: form.toString() });
    } catch {
      throw new TokenEndpointError(502, 'auth_host_unreachable', 'network');
    }
    const nonce = res.headers.get('dpop-nonce');
    if (nonce) this.#dpopNonce = nonce;
    if (!res.ok) throw await errorOf(res);
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async #getJson(path: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#o.authUrl}${path}`, { headers: { accept: 'application/json' } });
    } catch {
      throw new TokenEndpointError(502, 'auth_host_unreachable', 'network');
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Maps a failed auth-host response: RFC 6749 JSON ({error}) or problem+json ({code}). */
export async function errorOf(res: Response): Promise<TokenEndpointError> {
  const requestId = res.headers.get('carpal-request-id') ?? undefined;
  const retry = Number(res.headers.get('carpal-retry-after-ms') ?? NaN);
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty or non-JSON body
  }
  const retryAfterMs = Number.isFinite(retry) ? retry : undefined;
  if (typeof body.error === 'string') return new TokenEndpointError(res.status, body.error, 'oauth', requestId, retryAfterMs);
  if (typeof body.code === 'string') return new TokenEndpointError(res.status, body.code, 'problem', requestId, retryAfterMs);
  return new TokenEndpointError(res.status, `http_${res.status}`, 'network', requestId, retryAfterMs);
}
