// Token providers (GD-07, P2.T5): (a) the signed-in user's cp-web-consumer tokens, refreshed single-flight per
// session (a refresh rejected with invalid_grant ends the session, BA-12); (b) the guest's anonymous token, granted
// lazily per pre-session and DPoP-bound to the pre-session's key so its anonymous principal survives renewals
// (DI-17); (c) the process-wide cp-ssr client-credentials token for server rendering, with a server-held anonymous
// token as fallback when cp-ssr is refused (DI-14).
import type { JWK } from 'jose';
import { REFRESH_SKEW_MS, type BffConfig } from './config';
import { generateDpopKey } from './oauth/dpop';
import { TokenEndpointError, type TokenClient, type TokenResponse } from './oauth/token-client';
import type { SessionManager } from './session/manager';
import type { SessionRecord, UserTokens } from './session/types';

export interface Credential {
  kind: 'user' | 'anonymous' | 'ssr';
  accessToken: string;
  scheme: 'Bearer' | 'DPoP';
  /** Present when the token is DPoP-bound: every API call carries a proof made with it. */
  dpopKey?: JWK;
}

/** The user's session ended (refresh refused, session revoked): the browser must sign in again. */
export class SessionEndedError extends Error {
  constructor(readonly reason: 'refresh_refused' | 'revoked' | 'missing') {
    super(`session ended: ${reason}`);
  }
}

export class SessionTokens {
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly client: TokenClient,
    private readonly config: Pick<BffConfig, 'clientId'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The credential for a session's next API call: the user's token when signed in, else the anonymous one. */
  async credential(r: SessionRecord): Promise<Credential> {
    if (r.user) {
      const user = r.user.accessExpiresAt - REFRESH_SKEW_MS > this.now() ? r.user : await this.refresh(r.id);
      return { kind: 'user', accessToken: user.accessToken, scheme: 'Bearer' };
    }
    const anon =
      r.anonymous && r.anonymous.expiresAt - REFRESH_SKEW_MS > this.now() && r.dpopKey
        ? { token: r.anonymous, key: r.dpopKey }
        : await this.anonymous(r.id);
    return { kind: 'anonymous', accessToken: anon.token.accessToken, scheme: 'DPoP', dpopKey: anon.key };
  }

  /**
   * Rotates the refresh token once per session at a time. `force` refreshes even an unexpired access token (the API
   * answered 401). invalid_grant (expired, reused or revoked family) drops the user from the session.
   */
  refresh(id: string, force = false): Promise<UserTokens> {
    return this.#single(`user:${id}`, async () => {
      const r = await this.sessions.get(id);
      if (!r?.user) throw new SessionEndedError('missing');
      if (!force && r.user.accessExpiresAt - REFRESH_SKEW_MS > this.now()) return r.user;
      let t: TokenResponse;
      try {
        t = await this.client.refresh(this.config.clientId, r.user.refreshToken);
      } catch (err) {
        if (err instanceof TokenEndpointError && err.invalidGrant) {
          await this.endUser(id);
          throw new SessionEndedError('refresh_refused');
        }
        throw err;
      }
      let updated: UserTokens | undefined;
      await this.sessions.update(id, (s) => {
        if (!s.user) return;
        s.user = {
          ...s.user,
          accessToken: t.access_token,
          accessExpiresAt: this.now() + t.expires_in * 1000,
          refreshToken: t.refresh_token ?? s.user.refreshToken,
          scope: t.scope,
        };
        updated = s.user;
      });
      if (!updated) throw new SessionEndedError('missing');
      return updated;
    });
  }

  /** A fresh anonymous token for a pre-session, bound to its DPoP key (created on first use). */
  anonymous(id: string): Promise<{ token: NonNullable<SessionRecord['anonymous']>; key: JWK }> {
    return this.#single(`anon:${id}`, async () => {
      let key = (await this.sessions.get(id))?.dpopKey;
      if (!key) {
        const fresh = await generateDpopKey();
        const r = await this.sessions.update(id, (s) => {
          s.dpopKey ??= fresh;
        });
        if (!r?.dpopKey) throw new SessionEndedError('missing');
        key = r.dpopKey;
      }
      const t = await this.client.anonymous(this.config.clientId, key);
      const token = { accessToken: t.access_token, expiresAt: this.now() + t.expires_in * 1000 };
      await this.sessions.update(id, (s) => {
        s.anonymous = token;
      });
      return { token, key };
    });
  }

  /** Signs the user out of this session record but keeps the pre-session (CSRF secret, intents). */
  async endUser(id: string): Promise<void> {
    await this.sessions.update(id, (s) => {
      delete s.user;
    });
  }

  #single<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }
}

/** Server-rendering credentials: cp-ssr (public.read), or a server-held anonymous token when cp-ssr is refused (DI-14). */
export class SsrTokens {
  #ssr: { token: string; until: number } | undefined;
  #anon: { token: string; until: number } | undefined;
  #key: JWK | undefined;
  #inflight: Promise<Credential> | undefined;
  #anonInflight: Promise<Credential> | undefined;

  constructor(
    private readonly client: TokenClient,
    private readonly config: Pick<BffConfig, 'clientId' | 'ssrClientId'>,
    private readonly now: () => number = Date.now,
  ) {}

  async ssr(force = false): Promise<Credential> {
    if (!force && this.#ssr && this.#ssr.until > this.now()) return { kind: 'ssr', accessToken: this.#ssr.token, scheme: 'Bearer' };
    this.#inflight ??= this.client
      .clientCredentials(this.config.ssrClientId)
      .then((t) => {
        this.#ssr = { token: t.access_token, until: this.now() + t.expires_in * 1000 - REFRESH_SKEW_MS };
        return { kind: 'ssr', accessToken: t.access_token, scheme: 'Bearer' } as Credential;
      })
      .finally(() => (this.#inflight = undefined));
    return this.#inflight;
  }

  async anonymous(force = false): Promise<Credential> {
    if (!force && this.#anon && this.#anon.until > this.now() && this.#key)
      return { kind: 'anonymous', accessToken: this.#anon.token, scheme: 'DPoP', dpopKey: this.#key };
    this.#anonInflight ??= (async () => {
      this.#key ??= await generateDpopKey();
      const t = await this.client.anonymous(this.config.clientId, this.#key);
      this.#anon = { token: t.access_token, until: this.now() + t.expires_in * 1000 - REFRESH_SKEW_MS };
      return { kind: 'anonymous', accessToken: t.access_token, scheme: 'DPoP', dpopKey: this.#key } as Credential;
    })().finally(() => (this.#anonInflight = undefined));
    return this.#anonInflight;
  }
}
