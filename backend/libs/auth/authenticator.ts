// L3 authentication (41 §5 step 4, 40 §2.3): token signature and claims,
// audience per host, CarPal-Client = token client_id, live session (sid) on
// every request, aal3 on the admin plane, step-up windows. DPoP, mTLS binding
// and app attestation are enforced only with CARPAL_STRICT_AUTH=1 (GD-06);
// otherwise they are skipped and the deviation is logged at startup.
import { ApiError } from '#libs/contract/index.js';
import type { Hmac } from '#libs/crypto/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';
import type { Acr, Principal, UserPrincipal } from './principal.js';
import type { SessionStore } from './sessions.js';
import { ANONYMOUS_ACR, verifyDpopProof, type TokenService } from './tokens.js';

export type TokenHost = 'api' | 'admin-api';

export interface AuthRequest {
  host: TokenHost;
  authorization: string | undefined;
  dpop: string | undefined;
  /** client_id of the CarPal-Client header (already format-checked). */
  clientId: string | undefined;
  method: string;
  /** Request URL without query (DPoP htu). */
  htu: string;
  /** SHA-256 thumbprint (base64url) of the client certificate, from the TLS terminator (mTLS, RFC 8705). */
  clientCertThumbprint?: string;
}

/** App attestation / proof-of-work check (SEC-MOB-3, SEC-BF-7); implemented by the auth server (S3). */
export interface AttestationVerifier {
  verify(input: { attestation?: string; pow?: string; clientId?: string; opId: string }): Promise<boolean>;
}

export interface AuthenticatorOptions {
  tokens: TokenService;
  sessions: SessionStore;
  kv: KeyValueStore;
  hmac: Hmac;
  audiences: Record<TokenHost, string>;
  strict: boolean;
  attestation?: AttestationVerifier;
}

/** Step-up window (SEC-AU-10): the session must have authenticated at the level within 10 minutes. */
export const STEP_UP_MAX_AGE_S = 600;
const ACR_RANK: Record<Acr, number> = { aal1: 1, aal2: 2, aal3: 3 };

const challenge = (acr: Acr, maxAge: number): Record<string, string> => ({
  'www-authenticate': `DPoP error="insufficient_user_authentication", acr_values="${acr}", max_age=${maxAge}`,
});

export class Authenticator {
  constructor(private readonly o: AuthenticatorOptions) {}

  get strict(): boolean {
    return this.o.strict;
  }

  async authenticate(req: AuthRequest): Promise<Principal> {
    const header = req.authorization?.trim();
    if (!header)
      throw new ApiError('UNAUTHENTICATED', {
        detail: 'no Authorization header',
        headers: { 'www-authenticate': 'DPoP algs="ES256", Bearer' },
      });
    const m = /^(Bearer|DPoP) ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
    if (!m)
      throw new ApiError('UNAUTHENTICATED', {
        detail: 'unsupported Authorization scheme',
        headers: { 'www-authenticate': 'DPoP algs="ES256", Bearer' },
      });
    const scheme = m[1]!.toLowerCase();
    const token = m[2]!;
    const claims = await this.o.tokens.verify(token, this.o.audiences[req.host]);

    if (!req.clientId || claims.client_id !== req.clientId) {
      throw new ApiError('UNAUTHENTICATED', { detail: 'CarPal-Client does not match the token client_id' });
    }

    if (this.o.strict) await this.#checkBinding(req, scheme, token, claims.cnf);

    if (claims.acr === ANONYMOUS_ACR) {
      if (req.host === 'admin-api') throw new ApiError('UNAUTHENTICATED', { detail: 'anonymous token on the admin plane' });
      const deviceKey = claims.cnf?.jkt ?? claims.sub;
      return {
        kind: 'anonymous',
        clientId: claims.client_id,
        tokenId: claims.jti,
        anonKey: this.o.hmac.digest('anon-key', deviceKey).toString('hex').slice(0, 32),
        scopes: claims.scope.split(' ').filter(Boolean),
      };
    }

    const session = await this.o.sessions.get(claims.sid!);
    if (!session || session.userId !== claims.sub || session.clientId !== claims.client_id) {
      throw new ApiError('UNAUTHENTICATED', {
        detail: 'session revoked or unknown',
        headers: { 'www-authenticate': 'DPoP error="invalid_token"' },
      });
    }
    const principal: UserPrincipal = {
      kind: req.host === 'admin-api' ? 'staff' : 'user',
      userId: claims.sub,
      clientId: claims.client_id,
      sessionId: session.sid,
      // The session may have been stepped up after the token was issued.
      acr: ACR_RANK[session.acr] > ACR_RANK[claims.acr as Acr] ? session.acr : (claims.acr as Acr),
      authTime: Math.max(session.authTime, claims.auth_time ?? 0),
      tokenId: claims.jti,
      scopes: claims.scope.split(' ').filter(Boolean),
    };
    if (req.host === 'admin-api') {
      // SEC-ADM-2: staff sessions are aal3 (hardware-bound WebAuthn) on every request.
      if (!session.staff) throw new ApiError('UNAUTHENTICATED', { detail: 'not a staff session' });
      if (principal.acr !== 'aal3') throw new ApiError('STEP_UP_REQUIRED', { headers: challenge('aal3', STEP_UP_MAX_AGE_S) });
    }
    return principal;
  }

  /** AAL2 / AAL3 tags (SEC-AU-10): 401 STEP_UP_REQUIRED with the RFC 9470 challenge. */
  requireAssurance(principal: Principal, level: Acr, maxAgeSeconds = STEP_UP_MAX_AGE_S, now = Math.floor(Date.now() / 1000)): void {
    if (principal.kind !== 'user' && principal.kind !== 'staff') throw new ApiError('UNAUTHENTICATED', { detail: 'step-up needs a user' });
    if (ACR_RANK[principal.acr] < ACR_RANK[level] || now - principal.authTime > maxAgeSeconds) {
      throw new ApiError('STEP_UP_REQUIRED', { headers: challenge(level, maxAgeSeconds) });
    }
  }

  /** ATT tag (SEC-MOB-3, SEC-BF-7). Enforced in strict mode only. */
  async checkAttestation(input: { attestation?: string; pow?: string; clientId?: string; opId: string }): Promise<void> {
    if (!this.o.strict) return;
    const ok = !!(input.attestation || input.pow) && (await this.o.attestation?.verify(input)) === true;
    if (!ok) throw new ApiError('ATTESTATION_REQUIRED');
  }

  async #checkBinding(
    req: AuthRequest,
    scheme: string,
    token: string,
    cnf: { jkt?: string; 'x5t#S256'?: string } | undefined,
  ): Promise<void> {
    if (cnf?.jkt) {
      if (scheme !== 'dpop' || !req.dpop)
        throw new ApiError('UNAUTHENTICATED', { detail: 'DPoP proof required', headers: { 'www-authenticate': 'DPoP algs="ES256"' } });
      await verifyDpopProof({ proof: req.dpop, method: req.method, htu: req.htu, accessToken: token, expectedJkt: cnf.jkt }, this.o.kv);
      return;
    }
    if (cnf?.['x5t#S256']) {
      if (scheme !== 'bearer' || req.clientCertThumbprint !== cnf['x5t#S256'])
        throw new ApiError('UNAUTHENTICATED', { detail: 'mTLS binding failed' });
      return;
    }
    throw new ApiError('UNAUTHENTICATED', { detail: 'token is not sender-constrained' });
  }
}
