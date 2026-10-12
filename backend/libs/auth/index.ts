// L3 auth (41 §2.2, 40 SEC-AU): JWT (EdDSA) validation and issuing, key ring
// and JWKS, server-side sessions, step-up, anonymous tokens, and strict-mode
// DPoP / mTLS / attestation hooks (GD-06).
export { JwtKeyRing, type PublicJwk, type SigningKey } from './keys.js';
export { TokenService, verifyDpopProof, ANONYMOUS_ACR, type AccessTokenClaims, type IssueOptions, type DpopCheck } from './tokens.js';
export { SessionStore, type Session } from './sessions.js';
export {
  Authenticator,
  STEP_UP_MAX_AGE_S,
  type AuthRequest,
  type AuthenticatorOptions,
  type AttestationVerifier,
  type TokenHost,
} from './authenticator.js';
export {
  isUser,
  principalKey,
  type Acr,
  type AnonymousPrincipal,
  type NoPrincipal,
  type Principal,
  type UserPrincipal,
} from './principal.js';

const H = 3_600_000;
const D = 24 * H;

/**
 * Registered OAuth clients (40 §2.2): access-token lifetime, refresh-token
 * idle (sliding) and absolute lifetimes (= session lifetime), client kind and
 * token binding. Redirect URIs are configuration (CARPAL_OAUTH_REDIRECT_URIS).
 */
export const CLIENTS = {
  'cp-mobile': { accessTtlS: 300, refreshIdleMs: 30 * D, sessionAbsoluteMs: 90 * D, kind: 'public', binding: 'dpop', audience: 'api' },
  'cp-web-consumer': {
    accessTtlS: 300,
    refreshIdleMs: 12 * H,
    sessionAbsoluteMs: 7 * D,
    kind: 'confidential',
    binding: 'mtls',
    audience: 'api',
  },
  'cp-web-portal': {
    accessTtlS: 300,
    refreshIdleMs: 8 * H,
    sessionAbsoluteMs: 7 * D,
    kind: 'confidential',
    binding: 'mtls',
    audience: 'api',
  },
  'cp-web-admin': {
    accessTtlS: 300,
    refreshIdleMs: 30 * 60_000,
    sessionAbsoluteMs: 8 * H,
    kind: 'confidential',
    binding: 'mtls',
    audience: 'admin-api',
  },
  'cp-ssr': { accessTtlS: 300, refreshIdleMs: 0, sessionAbsoluteMs: 0, kind: 'confidential', binding: 'mtls', audience: 'api' },
} as const;
export type ClientId = keyof typeof CLIENTS;
export const isClientId = (v: unknown): v is ClientId => typeof v === 'string' && Object.hasOwn(CLIENTS, v);
export const ANONYMOUS_TOKEN_TTL_S = 15 * 60;
