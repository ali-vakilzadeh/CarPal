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

/** Registered OAuth clients (40 §2.2) with access-token and session lifetimes. */
export const CLIENTS = {
  'cp-mobile': { accessTtlS: 300, sessionAbsoluteMs: 90 * 86_400_000 },
  'cp-web-consumer': { accessTtlS: 300, sessionAbsoluteMs: 7 * 86_400_000 },
  'cp-web-portal': { accessTtlS: 300, sessionAbsoluteMs: 7 * 86_400_000 },
  'cp-web-admin': { accessTtlS: 300, sessionAbsoluteMs: 8 * 3_600_000 },
  'cp-ssr': { accessTtlS: 300, sessionAbsoluteMs: 0 },
} as const;
export type ClientId = keyof typeof CLIENTS;
export const ANONYMOUS_TOKEN_TTL_S = 15 * 60;
