// The BFF session record (GD-08, P2.T1). The browser holds only its id in __Host-cp_sid; everything below stays on
// the server. A record starts as a guest pre-session (CSRF secret, anonymous token, DPoP key) and becomes a signed-in
// session at the OAuth callback, under a new id (no session fixation).
import type { JWK } from 'jose';

export type Acr = 'aal1' | 'aal2' | 'aal3';

export interface UserTokens {
  accessToken: string;
  /** Epoch ms; refreshed a little before (REFRESH_SKEW_MS). */
  accessExpiresAt: number;
  refreshToken: string;
  /** Subject (user id), auth-server session id, assurance level and auth time from the ID token. */
  sub: string;
  sid: string;
  acr: Acr;
  authTime: number;
  scope: string;
}

export interface AnonymousToken {
  accessToken: string;
  expiresAt: number;
}

/** An authorization request waiting for its callback (state → PKCE verifier, nonce, where to go back). */
export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  acrValues?: Acr;
  createdAt: number;
}

/** 'Intent survives sign-in' (GD-06): a gated action saved before the hosted sign-in, replayed once after it. */
export interface PendingIntent {
  id: string;
  type: string;
  target?: string;
  returnTo: string;
  draft?: unknown;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** Epoch ms after which the record is dropped whatever its activity (7 days for signed-in sessions). */
  absoluteExpiresAt: number;
  csrf: string;
  locale?: string;
  /** ES256 key pair (private JWK) that binds this pre-session's anonymous tokens (DI-17). */
  dpopKey?: JWK;
  anonymous?: AnonymousToken;
  user?: UserTokens;
  /** From me.get at sign-in: what /bff/session shows (never tokens). */
  profile?: { displayName: string; locale?: string };
  logins: PendingLogin[];
  intents: PendingIntent[];
}
