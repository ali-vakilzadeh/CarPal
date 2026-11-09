// The admin BFF session record (AC3.T2), adapted from pwa/src/server/bff/session/types.ts (GD-03). The browser holds
// only its id in __Host-cpa_sid; everything below stays on the server. A record starts as a pre-session (CSRF secret
// and the pending sign-in) and becomes a staff session at the OAuth callback, under a new id (no session fixation).
// No guest state: no anonymous token and no cp-ssr credential (GD-03).
import type { JWK } from 'jose';
import type { StaffRole } from '@/lib/api/generated';

export type Acr = 'aal1' | 'aal2' | 'aal3';

export interface UserTokens {
  accessToken: string;
  /** Epoch ms; refreshed a little before (REFRESH_SKEW_MS). */
  accessExpiresAt: number;
  refreshToken: string;
  /** Subject (user id), auth-server session id, assurance level and auth time (epoch s) from the ID token. */
  sub: string;
  sid: string;
  acr: Acr;
  authTime: number;
  scope: string;
  /** The tokens are DPoP-bound to the record's dpopKey (always, against a strict backend). */
  bound?: boolean;
}

/** What admin.staff_me returned (AC2 notes_for_next): kept for /bff/session, refreshed with every token refresh. */
export interface StaffProfile {
  userId: string;
  displayName: string;
  locale: string;
  timezone: string;
  /** Contract role codes (GD-09): ADM, MOD, SUP, CRV. */
  roles: StaffRole[];
  /** Epoch ms when the backend ends the session (8 h after sign-in). */
  sessionExpiresAt: number;
}

/** An authorization request waiting for its callback (state → PKCE verifier, nonce, where to go back). */
export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** /bff/reauth: prompt=login for an action that needs a fresh aal3 (GD-11); the same staff member must come back. */
  stepUp?: boolean;
  /** The saved action this sign-in is for (replayed once after it, GD-11). */
  intentId?: string;
  createdAt: number;
}

/** A gated action saved before a step-up sign-in and replayed once after it (GD-11; PWA GD-06 'intent survives sign-in'). */
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
  /** Epoch ms after which the record is dropped whatever its activity (8 h, or the backend's session end if sooner). */
  absoluteExpiresAt: number;
  csrf: string;
  locale?: string;
  /** ES256 key pair (private JWK) that binds this session's tokens; made at sign-in. */
  dpopKey?: JWK;
  user?: UserTokens;
  staff?: StaffProfile;
  logins: PendingLogin[];
  intents: PendingIntent[];
}
