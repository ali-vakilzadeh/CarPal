// Auth server core (40 §6.2, SEC-AU): hosted sign-in interactions, the
// transition from first factor to second factor to "complete", DPoP at the
// token endpoint, and token issuance (access token, refresh-token family =
// server-side session, ID token). Used by the auth-host handlers.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { decodeJwt } from 'jose';
import { CLIENTS, SessionStore, TokenService, verifyDpopProof, type Acr, type ClientId } from '#libs/auth/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { ProtocolError, type OperationContext } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectConfig, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { activeSecondFactors, platformRoles, type UserRow } from '../infrastructure/accounts.js';
import { AuthState, type Interaction } from '../infrastructure/auth-state.js';

export const INTERACTION_COOKIE = '__Host-cp_ia';

export type AuthNext = {
  next: 'verify_email' | 'verify_phone' | 'mfa' | 'complete' | 'consent';
  mfa_methods?: ('totp_mfa' | 'webauthn')[];
};

export interface IssuedTokens {
  access_token: string;
  token_type: 'DPoP' | 'Bearer';
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

const cookieValue = (header: string | string[] | undefined, name: string): string | undefined => {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
};

@Injectable()
export class AuthServer {
  constructor(
    readonly state: AuthState,
    private readonly tokens: TokenService,
    private readonly sessions: SessionStore,
    @InjectConfig() readonly config: CarpalConfig,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------- interactions

  /**
   * The interaction of a /v1/auth/* call: it must exist, and when the browser
   * sends the __Host-cp_ia cookie it must name the same interaction (strict
   * mode requires the cookie). Unknown or expired: 410 LINK_EXPIRED.
   */
  async interaction(ctx: OperationContext, interactionId: string): Promise<Interaction> {
    const cookie = cookieValue(ctx.headers.cookie, INTERACTION_COOKIE);
    if ((cookie !== undefined && cookie !== interactionId) || (this.config.strictAuth && cookie === undefined))
      throw new ApiError('LINK_EXPIRED', { detail: 'interaction cookie mismatch' });
    const i = await this.state.interaction(interactionId);
    if (!i) throw new ApiError('LINK_EXPIRED', { detail: 'interaction unknown or expired' });
    return i;
  }

  cookie(interactionId: string | null): string {
    return interactionId
      ? `${INTERACTION_COOKIE}=${interactionId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800`
      : `${INTERACTION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  cookieFrom(ctx: OperationContext): string | undefined {
    return cookieValue(ctx.headers.cookie, INTERACTION_COOKIE);
  }

  /**
   * After a first factor (password or one-time code): a second factor is next
   * when the account has one (and always for the admin client, which needs
   * aal3 WebAuthn); otherwise the interaction is complete at aal1.
   */
  async afterFirstFactor(scope: TxScope, i: Interaction, user: UserRow, amr: string): Promise<AuthNext> {
    i.userId = user.id;
    i.amr = [amr];
    i.acr = 'aal1';
    i.authTime = Math.floor(Date.now() / 1000);
    const factors = await activeSecondFactors(scope, user.id);
    i.mfaEnrolled = factors.length > 0;
    if (i.clientId === 'cp-web-admin') {
      // SEC-ADM-2: staff complete every sign-in with a device-bound WebAuthn credential (aal3, auth.mfa_verify).
      i.mfaPending = true;
      await this.state.saveInteraction(i);
      return { next: 'mfa', mfa_methods: ['webauthn'] };
    }
    if (factors.length > 0) {
      i.mfaPending = true;
      await this.state.saveInteraction(i);
      return { next: 'mfa', mfa_methods: [...new Set(factors.map((f) => f.method_type as 'totp_mfa' | 'webauthn'))].slice(0, 2) };
    }
    i.completed = true;
    await this.state.saveInteraction(i);
    return { next: 'complete' };
  }

  /** A second factor proven: aal2, or aal3 for a device-bound WebAuthn credential (SEC-AU-10). */
  async afterSecondFactor(i: Interaction, amr: string, acr: 'aal2' | 'aal3' = 'aal2'): Promise<AuthNext> {
    i.mfaPending = false;
    i.acr = acr;
    i.amr = [...i.amr, amr];
    i.authTime = Math.floor(Date.now() / 1000);
    i.completed = true;
    await this.state.saveInteraction(i);
    return { next: 'complete' };
  }

  // ---------------------------------------------------------- DPoP (RFC 9449) at /oauth/token

  /**
   * Verifies the DPoP proof of a token request and returns its key thumbprint
   * (the new token's cnf.jkt). Strict mode: cp-mobile must send a proof, and
   * every proof must carry a fresh server nonce (400 use_dpop_nonce with a
   * DPoP-Nonce header otherwise, SEC-AU-6). Lite mode accepts requests
   * without a proof and issues Bearer-style tokens (GD-06).
   */
  async dpop(ctx: OperationContext, clientId: ClientId): Promise<string | undefined> {
    const proof = typeof ctx.headers.dpop === 'string' ? ctx.headers.dpop : undefined;
    const strict = this.config.strictAuth;
    if (!proof) {
      if (strict && CLIENTS[clientId].binding === 'dpop')
        throw new ProtocolError(400, 'invalid_dpop_proof', { description: 'DPoP proof required' });
      return undefined;
    }
    let nonce: string | undefined;
    if (strict) {
      try {
        const n = decodeJwt(proof).nonce;
        nonce = typeof n === 'string' ? n : undefined;
      } catch {
        throw new ProtocolError(400, 'invalid_dpop_proof');
      }
      if (!(await this.state.dpopNonceValid(nonce)))
        throw new ProtocolError(400, 'use_dpop_nonce', { headers: { 'dpop-nonce': await this.state.newDpopNonce() } });
    }
    try {
      return await verifyDpopProof(
        { proof, method: 'POST', htu: `${this.config.http.issuer}/oauth/token`, ...(nonce ? { nonce } : {}) },
        this.infra.kv,
      );
    } catch (err) {
      throw new ProtocolError(400, 'invalid_dpop_proof', { detail: (err as Error).message });
    }
  }

  // ---------------------------------------------------------- tokens

  /**
   * A new session (= refresh-token family) for an authenticated user, with an
   * access token, a refresh token (clients with refresh) and an ID token
   * (scope openid). The admin client needs a staff account at aal3.
   */
  async issueForSession(
    scope: TxScope,
    o: {
      userId: string;
      clientId: ClientId;
      acr: Acr;
      authTime: number;
      scope: string;
      nonce?: string;
      mfaEnrolled: boolean;
      cnfJkt?: string;
      deviceLabel: string;
    },
  ): Promise<{ tokens: IssuedTokens; sid: string }> {
    const client = CLIENTS[o.clientId];
    const staff = (await platformRoles(scope, o.userId)).length > 0;
    if (o.clientId === 'cp-web-admin' && (!staff || o.acr !== 'aal3'))
      throw new ProtocolError(400, 'invalid_grant', { description: 'staff aal3 required' });
    const sid = uuidv7();
    const now = new Date();
    await this.sessions.create(
      {
        sid,
        userId: o.userId,
        clientId: o.clientId,
        acr: o.acr,
        authTime: o.authTime,
        createdAt: now.toISOString(),
        staff: o.clientId === 'cp-web-admin' && staff,
        deviceLabel: o.deviceLabel.slice(0, 80),
        lastSeenAt: now.toISOString(),
        country: null,
        mfaEnrolled: o.mfaEnrolled,
      },
      client.sessionAbsoluteMs,
    );
    await scope.db
      .updateTable('identity.user_accounts')
      .set({ last_active_at: sql`now()` })
      .where('id', '=', o.userId)
      .execute();
    const tokens = await this.#tokens({ ...o, sid, absoluteExpiry: now.getTime() + client.sessionAbsoluteMs, withIdToken: true });
    return { tokens, sid };
  }

  async #tokens(o: {
    userId: string;
    clientId: ClientId;
    acr: Acr;
    authTime: number;
    scope: string;
    nonce?: string;
    cnfJkt?: string;
    sid: string;
    absoluteExpiry: number;
    withIdToken: boolean;
  }): Promise<IssuedTokens> {
    const client = CLIENTS[o.clientId];
    const access = await this.tokens.issue({
      subject: o.userId,
      clientId: o.clientId,
      audience: this.config.http.audiences[client.audience],
      sessionId: o.sid,
      acr: o.acr,
      authTime: o.authTime,
      scope: o.scope,
      ttlSeconds: client.accessTtlS,
      ...(o.cnfJkt ? { cnf: { jkt: o.cnfJkt } } : {}),
    });
    const out: IssuedTokens = {
      access_token: access,
      token_type: o.cnfJkt ? 'DPoP' : 'Bearer',
      expires_in: client.accessTtlS,
      scope: o.scope,
    };
    if (client.refreshIdleMs > 0)
      out.refresh_token = await this.state.issueRefresh(
        {
          sid: o.sid,
          userId: o.userId,
          clientId: o.clientId,
          scope: o.scope,
          ...(o.cnfJkt ? { cnfJkt: o.cnfJkt } : {}),
          absoluteExpiry: o.absoluteExpiry,
        },
        client.refreshIdleMs,
      );
    if (o.withIdToken && o.nonce && o.scope.split(' ').includes('openid'))
      out.id_token = await this.tokens.issueIdToken({
        subject: o.userId,
        clientId: o.clientId,
        nonce: o.nonce,
        authTime: o.authTime,
        acr: o.acr,
        sessionId: o.sid,
        ttlSeconds: client.accessTtlS,
      });
    return out;
  }

  /**
   * Refresh-token rotation (SEC-AU-5): single use; a reused token revokes its
   * family (the session) and the user is told (security alert).
   */
  async refresh(
    scope: TxScope,
    token: string,
    clientId: ClientId,
    cnfJkt: string | undefined,
    onReuse: (userId: string) => Promise<void>,
  ): Promise<IssuedTokens> {
    const used = await this.state.useRefresh(token);
    if (!used) throw new ProtocolError(400, 'invalid_grant');
    if ('reused' in used) {
      await this.sessions.revoke(used.reused.sid);
      this.logger.warn({ security_event: 'refresh_token_reuse', client_id: used.reused.clientId }, 'refresh token reuse: family revoked');
      await onReuse(used.reused.userId);
      throw new ProtocolError(400, 'invalid_grant', { description: 'refresh token reused' });
    }
    const r = used.record;
    if (r.clientId !== clientId) throw new ProtocolError(400, 'invalid_grant');
    // A DPoP-bound family stays bound to the same key (RFC 9449 §5).
    if (r.cnfJkt && cnfJkt && r.cnfJkt !== cnfJkt) throw new ProtocolError(400, 'invalid_grant', { description: 'DPoP key mismatch' });
    if (r.cnfJkt && !cnfJkt && this.config.strictAuth) throw new ProtocolError(400, 'invalid_dpop_proof');
    const session = await this.sessions.get(r.sid);
    if (!session || session.userId !== r.userId) throw new ProtocolError(400, 'invalid_grant');
    const user = await scope.db.selectFrom('identity.user_accounts').select(['status']).where('id', '=', r.userId).executeTakeFirst();
    if (!user || user.status !== 'active') {
      await this.sessions.revoke(r.sid);
      throw new ProtocolError(400, 'invalid_grant');
    }
    await this.sessions.update(r.sid, { lastSeenAt: new Date().toISOString() });
    return this.#tokens({
      userId: r.userId,
      clientId,
      acr: session.acr,
      authTime: session.authTime,
      scope: r.scope,
      ...(r.cnfJkt ? { cnfJkt: r.cnfJkt } : {}),
      sid: r.sid,
      absoluteExpiry: r.absoluteExpiry,
      withIdToken: false,
    });
  }

  async revokeSession(sid: string): Promise<void> {
    await this.sessions.revoke(sid);
  }

  tokensService(): TokenService {
    return this.tokens;
  }
}

/** A passkey used as the only factor (auth.webauthn_options purpose signin): aal2, aal3 when device-bound (SEC-AU-10). */
export async function completePasskeySignin(state: AuthState, i: Interaction, userId: string, deviceBound: boolean): Promise<AuthNext> {
  i.userId = userId;
  i.amr = [deviceBound ? 'hwk' : 'swk'];
  i.acr = deviceBound ? 'aal3' : 'aal2';
  i.authTime = Math.floor(Date.now() / 1000);
  i.mfaEnrolled = true;
  i.mfaPending = false;
  i.completed = true;
  delete i.webauthn;
  await state.saveInteraction(i);
  return { next: 'complete' };
}
