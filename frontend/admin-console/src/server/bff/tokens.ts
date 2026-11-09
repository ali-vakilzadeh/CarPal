// The staff member's tokens (AC3.T2), adapted from pwa/src/server/bff/tokens.ts (GD-03): cp-web-admin tokens only (no
// anonymous token, no cp-ssr). Refresh is single-flight per session (two parallel calls never both spend the refresh
// token, which would trip reuse detection); a refresh refused with invalid_grant ends the session. Every refresh also
// re-reads admin.staff_me, so roles and the backend's session end follow changes made meanwhile (AC2 notes_for_next).
import type { JWK } from 'jose';
import { REFRESH_SKEW_MS, type BffConfig } from './config';
import { loadStaffProfile, type StaffFetch } from './staff';
import { TokenEndpointError, type TokenClient, type TokenResponse } from './oauth/token-client';
import type { SessionManager } from './session/manager';
import type { SessionRecord, UserTokens } from './session/types';

export interface Credential {
  accessToken: string;
  scheme: 'Bearer' | 'DPoP';
  /** Present when the token is DPoP-bound: every admin-api call carries a proof made with it. */
  dpopKey?: JWK;
}

/** The staff session ended (refresh refused, session revoked) or never existed: the browser must sign in again. */
export class SessionEndedError extends Error {
  constructor(readonly reason: 'refresh_refused' | 'revoked' | 'missing') {
    super(`session ended: ${reason}`);
  }
}

/** The signed-in staff member's credential: bound tokens carry the session's DPoP key on every call. */
export function userCredential(r: SessionRecord, user: UserTokens): Credential {
  return user.bound && r.dpopKey
    ? { accessToken: user.accessToken, scheme: 'DPoP', dpopKey: r.dpopKey }
    : { accessToken: user.accessToken, scheme: 'Bearer' };
}

export class SessionTokens {
  readonly #inflight = new Map<string, Promise<UserTokens>>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly client: TokenClient,
    private readonly config: Pick<BffConfig, 'clientId'>,
    private readonly staff: StaffFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The credential for a session's next admin-api call; refreshes the access token shortly before it expires. */
  async credential(r: SessionRecord): Promise<Credential> {
    if (!r.user) throw new SessionEndedError('missing');
    const user = r.user.accessExpiresAt - REFRESH_SKEW_MS > this.now() ? r.user : await this.refresh(r.id);
    return userCredential(r, user);
  }

  /**
   * Rotates the refresh token once per session at a time. `force` refreshes even an unexpired access token (the API
   * answered 401). invalid_grant (expired, reused or revoked family) drops the staff member from the session.
   */
  refresh(id: string, force = false): Promise<UserTokens> {
    const existing = this.#inflight.get(id);
    if (existing) return existing;
    const p = this.#refresh(id, force).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, p);
    return p;
  }

  async #refresh(id: string, force: boolean): Promise<UserTokens> {
    const r = await this.sessions.get(id);
    if (!r?.user) throw new SessionEndedError('missing');
    if (!force && r.user.accessExpiresAt - REFRESH_SKEW_MS > this.now()) return r.user;
    let t: TokenResponse;
    try {
      t = await this.client.refresh(this.config.clientId, r.user.refreshToken, r.user.bound ? r.dpopKey : undefined);
    } catch (err) {
      if (err instanceof TokenEndpointError && err.invalidGrant) {
        await this.endUser(id);
        throw new SessionEndedError('refresh_refused');
      }
      throw err;
    }
    const profile = await loadStaffProfile(t.access_token, r.user.bound ? r.dpopKey : undefined, this.staff);
    let updated: UserTokens | undefined;
    // A refresh is not activity: the idle deadline stays where the last API call put it.
    await this.sessions.update(
      id,
      (s) => {
        if (!s.user) return;
        s.user = {
          ...s.user,
          accessToken: t.access_token,
          accessExpiresAt: this.now() + t.expires_in * 1000,
          refreshToken: t.refresh_token ?? s.user.refreshToken,
          scope: t.scope,
        };
        if (profile) {
          s.staff = profile;
          s.absoluteExpiresAt = Math.min(s.absoluteExpiresAt, profile.sessionExpiresAt);
        }
        updated = s.user;
      },
      { activity: false },
    );
    if (!updated) throw new SessionEndedError('missing');
    return updated;
  }

  /** Signs the staff member out of this session record but keeps the record (its CSRF secret). */
  async endUser(id: string): Promise<void> {
    await this.sessions.update(
      id,
      (s) => {
        delete s.user;
        delete s.staff;
        delete s.dpopKey;
      },
      { activity: false },
    );
  }
}
