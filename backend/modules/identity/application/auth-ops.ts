// Authorization server operations (40 §6.2) on id.carpal.app: OIDC discovery
// and JWKS, authorization code + PKCE through the hosted sign-in interaction,
// the token endpoint (code, refresh rotation, client credentials, anonymous
// grant), revocation, sign-up, password and one-time-code sign-in, second
// factor, email verification, password reset and the proof-of-work
// challenge. Transactions run in the system context (carpal_auth).
// Enumeration resistance (SEC-AU-11): sign-up, sign-in, OTP and reset start
// answer the same way, after the same minimum latency, whatever the account.
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ANONYMOUS_TOKEN_TTL_S, Authenticator, CLIENTS, isClientId, JwtKeyRing, SessionStore, type ClientId } from '#libs/auth/index.js';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import {
  ACK,
  iso,
  Operation,
  ProtocolError,
  redirect,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { LinkTokens, consumeFailure } from '#libs/link-tokens/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { constantTimeEqual, isBreachedPassword, newOtpCode, pkceMatches } from '../domain/credentials.js';
import {
  consumeVerificationToken,
  findAccount,
  getUser,
  methods,
  normalizeEmail,
  revokeVerificationTokens,
  type UserRow,
} from '../infrastructure/accounts.js';
import { OTP_MAX_ATTEMPTS, OTP_RESEND_MS, OTP_TTL_MS } from '../infrastructure/auth-state.js';
import { IdentityMessages } from '../infrastructure/messages.js';
import { AuthServer, completePasskeySignin, type AuthNext } from './auth-server.js';
import { CHALLENGE_TTL_MS, WebAuthnService } from './webauthn.js';
import { withMinLatency } from './common.js';
import { MfaService } from './mfa-service.js';

const ALLOWED_SCOPES = new Set(['openid', 'offline_access', 'profile', 'email']);
const deviceLabel = (ctx: OperationContext): string =>
  ctx.client ? `${ctx.client.clientId} (${ctx.client.os} ${ctx.client.osVersion})` : 'unknown device';

/** First verification of a contact activates the account and emits user.registered (40 §6.2). */
async function markContactVerified(scope: TxScope, user: UserRow, contact: 'email' | 'phone'): Promise<void> {
  const column = contact === 'email' ? 'email_verified_at' : 'phone_verified_at';
  const firstActivation = user.status === 'pending_verification';
  await scope.db
    .updateTable('identity.user_accounts')
    .set({ [column]: sql`coalesce(${sql.ref(column)}, now())`, ...(firstActivation ? { status: 'active' } : {}) })
    .where('id', '=', user.id)
    .execute();
  if (firstActivation)
    await publishEvent(scope, {
      type: 'user.registered',
      aggregateType: 'user_account',
      aggregateId: user.id,
      payload: { locale: user.locale },
    });
}

// ------------------------------------------------------------------ discovery

@Injectable()
@Operation('auth.discovery')
export class DiscoveryHandler implements OperationHandler {
  constructor(private readonly auth: AuthServer) {}

  handle(): OperationResult {
    const iss = this.auth.config.http.issuer;
    return {
      body: {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        revocation_endpoint: `${iss}/oauth/revoke`,
        jwks_uri: `${iss}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: [
          'authorization_code',
          'refresh_token',
          'client_credentials',
          'urn:carpal:params:oauth:grant-type:anonymous',
        ],
        code_challenge_methods_supported: ['S256'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['EdDSA'],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt', 'tls_client_auth'],
        dpop_signing_alg_values_supported: ['ES256'],
        tls_client_certificate_bound_access_tokens: true,
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [...ALLOWED_SCOPES],
        acr_values_supported: ['aal1', 'aal2', 'aal3'],
        ui_locales_supported: ['en', 'fa'],
        claims_supported: ['sub', 'acr', 'auth_time', 'nonce', 'sid'],
      },
      cache: { public: 3600 },
    };
  }
}

@Injectable()
@Operation('auth.jwks')
export class JwksHandler implements OperationHandler {
  constructor(private readonly keys: JwtKeyRing) {}

  handle(): OperationResult {
    // During rotation both keys are listed (SEC-CR); cacheable for 10 min.
    return { body: this.keys.jwks(), cache: { public: 600 } };
  }
}

// ------------------------------------------------------------------ authorize

type AuthorizeQuery = {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  acr_values?: 'aal1' | 'aal2' | 'aal3';
  ui_locales?: string;
  prompt?: 'login' | 'none';
};

@Injectable()
@Operation('auth.authorize')
export class AuthorizeHandler implements OperationHandler {
  constructor(private readonly auth: AuthServer) {}

  async handle(ctx: OperationContext<undefined, AuthorizeQuery>): Promise<OperationResult> {
    const q = ctx.query;
    // SEC-AU-1: exact redirect_uri match per registered client; errors never redirect to an unregistered URI.
    if (!isClientId(q.client_id) || q.client_id === 'cp-ssr') throw new ApiError('MALFORMED_REQUEST', { detail: 'unknown client_id' });
    if (!(this.auth.config.auth.redirectUris[q.client_id] ?? []).includes(q.redirect_uri))
      throw new ApiError('MALFORMED_REQUEST', { detail: 'redirect_uri not registered' });
    const back = (params: Record<string, string>, extra: Record<string, string> = {}): OperationResult => {
      const url = new URL(q.redirect_uri);
      for (const [k, v] of Object.entries({ ...params, state: q.state, iss: this.auth.config.http.issuer })) url.searchParams.set(k, v);
      return { ...redirect(url.toString()), headers: { location: url.toString(), ...extra } };
    };
    if (q.scope.split(' ').some((s) => !ALLOWED_SCOPES.has(s))) return back({ error: 'invalid_scope' });

    // Resume: the hosted UI comes back with the same request once the interaction is complete.
    const cookie = this.auth.cookieFrom(ctx);
    const existing = cookie ? await this.auth.state.interaction(cookie) : null;
    const same =
      existing &&
      existing.clientId === q.client_id &&
      existing.redirectUri === q.redirect_uri &&
      existing.state === q.state &&
      existing.nonce === q.nonce &&
      existing.codeChallenge === q.code_challenge;
    if (same && q.prompt !== 'login') {
      if (existing.completed && existing.userId && existing.acr && existing.authTime) {
        const mfaEnrolled = existing.mfaEnrolled ?? true;
        const code = await this.auth.state.issueCode({
          clientId: existing.clientId,
          redirectUri: existing.redirectUri,
          codeChallenge: existing.codeChallenge,
          userId: existing.userId,
          acr: existing.acr,
          authTime: existing.authTime,
          nonce: existing.nonce,
          scope: existing.scope,
          mfaEnrolled,
        });
        await this.auth.state.dropInteraction(existing.id);
        return back({ code }, { 'set-cookie': this.auth.cookie(null) });
      }
      if (q.prompt !== 'none') return this.#toSignin(existing.id, q.ui_locales);
    }
    if (q.prompt === 'none') return back({ error: 'login_required' });
    const i = await this.auth.state.createInteraction({
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      scope: q.scope,
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      ...(q.acr_values ? { acrValues: q.acr_values } : {}),
      ...(q.ui_locales ? { uiLocales: q.ui_locales } : {}),
    });
    return this.#toSignin(i.id, q.ui_locales);
  }

  #toSignin(interactionId: string, locale?: string): OperationResult {
    const url = new URL(this.auth.config.http.signinUrl);
    url.searchParams.set('interaction_id', interactionId);
    if (locale) url.searchParams.set('ui_locales', locale);
    return { status: 302, headers: { location: url.toString(), 'set-cookie': this.auth.cookie(interactionId) } };
  }
}

// ------------------------------------------------------------------ token, revoke

@Injectable()
@Operation('auth.token')
export class TokenHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly authenticator: Authenticator,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<Record<string, string>>): Promise<OperationResult> {
    const f = ctx.body;
    const grant = f.grant_type;
    const clientId = f.client_id;
    if (!grant) throw new ProtocolError(400, 'invalid_request', { description: 'grant_type required' });
    if (!isClientId(clientId)) throw new ProtocolError(401, 'invalid_client');
    // CarPal-Client must name the same client (40 §1.3).
    if (ctx.client && ctx.client.clientId !== clientId) throw new ProtocolError(401, 'invalid_client');
    const att = {
      ...(typeof ctx.headers['carpal-attestation'] === 'string' ? { attestation: ctx.headers['carpal-attestation'] } : {}),
      ...(typeof ctx.headers['carpal-pow'] === 'string' ? { pow: ctx.headers['carpal-pow'] } : {}),
      clientId,
      opId: 'auth.token',
    };
    let body: unknown;
    switch (grant) {
      case 'authorization_code':
        // ATT(cp-mobile code grant)
        if (clientId === 'cp-mobile') await this.authenticator.checkAttestation(att);
        body = await this.#code(ctx, f, clientId);
        break;
      case 'refresh_token': {
        if (!f.refresh_token) throw new ProtocolError(400, 'invalid_request', { description: 'refresh_token required' });
        const jkt = await this.auth.dpop(ctx, clientId);
        body = await ctx.tx((scope) =>
          this.auth.refresh(scope, f.refresh_token!, clientId, jkt, async (userId) => {
            // SEC-AU-5: the user is told (critical security notice): an email now, and a critical
            // system_announcement in-app through the notification worker (S6). The token request fails and
            // rolls its transaction back, so the event is written in a transaction of its own.
            const user = await getUser(scope, userId);
            if (user) await this.messages.email(user.email, 'identity.security_alert', user.locale, { kind: 'refresh_token_reuse' });
            await ctx.tx((s) =>
              publishEvent(s, {
                type: 'user.security_alert',
                aggregateType: 'user',
                aggregateId: userId,
                payload: { user_id: userId, kind: 'refresh_token_reuse' },
              }),
            );
          }),
        );
        break;
      }
      case 'client_credentials':
        body = await this.#clientCredentials(f, clientId);
        break;
      case 'urn:carpal:params:oauth:grant-type:anonymous':
        // ATT(anonymous grant), SEC-AU-14
        await this.authenticator.checkAttestation(att);
        body = await this.#anonymous(ctx, clientId);
        break;
      default:
        throw new ProtocolError(400, 'unsupported_grant_type');
    }
    return { body, headers: { pragma: 'no-cache' } };
  }

  async #code(ctx: OperationContext, f: Record<string, string>, clientId: ClientId) {
    if (!f.code || !f.redirect_uri || !f.code_verifier) throw new ProtocolError(400, 'invalid_request');
    const used = await this.auth.state.consumeCode(f.code);
    if (!used) throw new ProtocolError(400, 'invalid_grant');
    if ('replayed' in used) {
      // A code presented twice: the tokens issued from it are revoked (RFC 6749 §4.1.2).
      if (used.replayed) await this.auth.revokeSession(used.replayed);
      throw new ProtocolError(400, 'invalid_grant', { description: 'code already used' });
    }
    const g = used.grant;
    if (g.clientId !== clientId || g.redirectUri !== f.redirect_uri || !pkceMatches(f.code_verifier, g.codeChallenge))
      throw new ProtocolError(400, 'invalid_grant');
    const jkt = await this.auth.dpop(ctx, clientId);
    const { tokens, sid } = await ctx.tx(async (scope) => {
      const user = await getUser(scope, g.userId);
      if (!user || user.status !== 'active') throw new ProtocolError(400, 'invalid_grant');
      return this.auth.issueForSession(scope, {
        userId: g.userId,
        clientId,
        acr: g.acr,
        authTime: g.authTime,
        scope: g.scope,
        nonce: g.nonce,
        mfaEnrolled: g.mfaEnrolled,
        ...(jkt ? { cnfJkt: jkt } : {}),
        deviceLabel: deviceLabel(ctx),
      });
    });
    await this.auth.state.markCodeUsed(f.code, sid);
    return tokens;
  }

  async #clientCredentials(f: Record<string, string>, clientId: ClientId) {
    // Only the SEO renderer, scope public.read (40 §2.2). Its client authentication (private_key_jwt over mTLS) is a strict-mode item.
    if (clientId !== 'cp-ssr') throw new ProtocolError(400, 'unauthorized_client');
    if (f.scope && f.scope !== 'public.read') throw new ProtocolError(400, 'invalid_scope');
    const access = await this.auth.tokensService().issue({
      subject: clientId,
      clientId,
      audience: this.auth.config.http.audiences.api,
      acr: 'anonymous',
      scope: 'public.read',
      ttlSeconds: CLIENTS[clientId].accessTtlS,
    });
    return { access_token: access, token_type: 'Bearer' as const, expires_in: CLIENTS[clientId].accessTtlS, scope: 'public.read' };
  }

  async #anonymous(ctx: OperationContext, clientId: ClientId) {
    // SEC-AU-14: the app (and the consumer BFF for visitors) gets a 15-minute, DPoP-bound, refresh-less token.
    if (clientId !== 'cp-mobile' && clientId !== 'cp-web-consumer') throw new ProtocolError(400, 'unauthorized_client');
    const jkt = await this.auth.dpop(ctx, clientId);
    const access = await this.auth.tokensService().issue({
      subject: uuidv7(),
      clientId,
      audience: this.auth.config.http.audiences.api,
      acr: 'anonymous',
      scope: 'public.read search',
      ttlSeconds: ANONYMOUS_TOKEN_TTL_S,
      ...(jkt ? { cnf: { jkt } } : {}),
    });
    return {
      access_token: access,
      token_type: jkt ? ('DPoP' as const) : ('Bearer' as const),
      expires_in: ANONYMOUS_TOKEN_TTL_S,
      scope: 'public.read search',
    };
  }
}

@Injectable()
@Operation('auth.revoke')
export class RevokeHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly sessions: SessionStore,
  ) {}

  async handle(ctx: OperationContext<Record<string, string>>): Promise<OperationResult> {
    const token = ctx.body.token ?? '';
    // Always 200, so token validity cannot be probed (RFC 7009).
    if (token.startsWith('cprt_')) {
      const r = await this.auth.state.peekRefresh(token);
      if (r) await this.sessions.revoke(r.sid);
    } else if (token.split('.').length === 3) {
      const tokens = this.auth.tokensService();
      for (const aud of Object.values(this.auth.config.http.audiences)) {
        const claims = await tokens.verify(token, aud).catch(() => null);
        if (claims?.sid) {
          await this.sessions.revoke(claims.sid);
          break;
        }
      }
    }
    return {};
  }
}

@Injectable()
@Operation('auth.pow_challenge')
export class PowChallengeHandler implements OperationHandler {
  constructor(private readonly auth: AuthServer) {}

  async handle(ctx: OperationContext<{ purpose: string }>): Promise<OperationResult> {
    const id = uuidv7();
    const prefix = randomBytes(18).toString('base64url');
    // Difficulty: configured base; risk-adapted difficulty per IP prefix and device is a later refinement.
    const bits = this.auth.config.auth.powDifficultyBits;
    await this.auth.state.putPow(id, { prefix, bits, purpose: ctx.body.purpose });
    return { body: { challenge_id: id, prefix, difficulty_bits: bits, expires_at: iso(new Date(Date.now() + 5 * 60_000)) } };
  }
}

// ------------------------------------------------------------------ sign-up and sign-in

type SignupBody = {
  interaction_id: string;
  full_name: string;
  email: string;
  password?: string;
  phone?: string;
  locale: 'en' | 'fa';
  terms_version: string;
  privacy_policy_version: string;
};

@Injectable()
@Operation('auth.signup')
export class SignupHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly crypto: CryptoServices,
    private readonly links: LinkTokens,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<SignupBody>): Promise<OperationResult> {
    const b = ctx.body;
    const email = normalizeEmail(b.email);
    await this.auth.interaction(ctx, b.interaction_id);
    if (b.password !== undefined && isBreachedPassword(b.password)) throw ApiError.validation([{ pointer: '/password', code: 'pattern' }]);
    await ctx.rateLimit('auth.signin', 'account', email);
    await withMinLatency(this.auth.config.auth.minLatencyMs, async () => {
      const hash = b.password !== undefined ? await this.crypto.passwords.hash(b.password) : null;
      const outcome = await ctx.tx(async (scope) => {
        if (await findAccount(scope, { email })) return { exists: true as const };
        // A phone already used by another account is not stored (it would reveal that account).
        const phone = b.phone && !(await findAccount(scope, { phone: b.phone })) ? b.phone : null;
        const id = uuidv7();
        await scope.db
          .insertInto('identity.user_accounts')
          .values({
            id,
            full_name: b.full_name,
            email,
            phone,
            locale: b.locale,
            status: 'pending_verification',
            terms_version: b.terms_version,
            privacy_policy_version: b.privacy_policy_version,
          })
          .execute();
        if (hash)
          await scope.db
            .insertInto('identity.authentication_methods')
            .values({ user_id: id, method_type: 'email_password', identifier: email, credential_reference: hash, status: 'active' })
            .execute();
        const link = this.links.issue('ev');
        await scope.db
          .insertInto('identity.verification_tokens')
          .values({
            user_id: id,
            token_type: 'email_verification',
            token_hash: link.hash,
            target_email: email,
            expires_at: link.expiresAt!,
          })
          .execute();
        return { exists: false as const, token: link.token };
      });
      // SEC-AU-11: an existing address gets a notice instead of a second account; the response is the same.
      if (outcome.exists) await this.messages.email(email, 'identity.account_exists', b.locale);
      else await this.messages.email(email, 'identity.email_verification', b.locale, { link: this.links.link('ev', outcome.token) });
    });
    return { body: { next: 'verify_email' } satisfies AuthNext };
  }
}

@Injectable()
@Operation('auth.signin_password')
export class SigninPasswordHandler implements OperationHandler {
  /** Verified when no account matches, so every failure costs the same Argon2id work. */
  #dummyHash: Promise<string> | null = null;

  constructor(
    private readonly auth: AuthServer,
    private readonly crypto: CryptoServices,
  ) {}

  async handle(ctx: OperationContext<{ interaction_id: string; email: string; password: string }>): Promise<OperationResult> {
    const email = normalizeEmail(ctx.body.email);
    const i = await this.auth.interaction(ctx, ctx.body.interaction_id);
    await ctx.rateLimit('auth.signin', 'account', email);
    const next = await withMinLatency(this.auth.config.auth.minLatencyMs, () =>
      ctx.tx(async (scope) => {
        const user = await findAccount(scope, { email });
        const [method] = user ? (await methods(scope, user.id, ['email_password'])).filter((m) => m.status === 'active') : [];
        this.#dummyHash ??= this.crypto.passwords.hash(randomBytes(16).toString('hex'));
        const ok = await this.crypto.passwords.verify(ctx.body.password, method?.credential_reference ?? (await this.#dummyHash));
        // Every failure is the same 401 (SEC-AU-11), including suspended accounts.
        if (!user || !method || !ok || (user.status !== 'active' && user.status !== 'pending_verification'))
          throw new ApiError('INVALID_CREDENTIALS');
        if (this.crypto.passwords.needsRehash(method.credential_reference!))
          await scope.db
            .updateTable('identity.authentication_methods')
            .set({ credential_reference: await this.crypto.passwords.hash(ctx.body.password) })
            .where('id', '=', method.id)
            .execute();
        await scope.db
          .updateTable('identity.authentication_methods')
          .set({ last_used_at: sql`now()` })
          .where('id', '=', method.id)
          .execute();
        if (user.status === 'pending_verification') return { next: 'verify_email' } satisfies AuthNext;
        return this.auth.afterFirstFactor(scope, i, user, 'pwd');
      }),
    );
    return { body: next };
  }
}

type OtpStart = { interaction_id: string; channel: 'email' | 'sms'; destination: string; purpose: 'signin' | 'verify' };

@Injectable()
@Operation('auth.otp_start')
export class OtpStartHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly region: RegionConfigService,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<OtpStart>): Promise<OperationResult> {
    const b = ctx.body;
    const isPhone = /^\+[1-9]\d{6,14}$/.test(b.destination);
    if ((b.channel === 'sms') !== isPhone) throw ApiError.validation([{ pointer: '/destination', code: 'type' }]);
    if (isPhone && !this.region.smsAllowed(b.destination)) throw ApiError.validation([{ pointer: '/destination', code: 'enum' }]);
    const destination = isPhone ? b.destination : normalizeEmail(b.destination);
    const i = await this.auth.interaction(ctx, b.interaction_id);
    await ctx.rateLimit('auth.otp', 'destination', destination);
    await withMinLatency(this.auth.config.auth.minLatencyMs, async () => {
      // SEC-AU-8: resend only after 60 s.
      if (i.otp && i.otp.destination === destination && Date.now() - i.otp.sentAt < OTP_RESEND_MS) return;
      const user = await ctx.tx((scope) => findAccount(scope, isPhone ? { phone: destination } : { email: destination }), {
        readOnly: true,
      });
      const verified = user && (isPhone ? user.phone_verified_at : user.email_verified_at);
      // signin: an active account with this verified contact; verify: an account whose contact is not verified yet.
      const live = !!user && (b.purpose === 'signin' ? !!verified && user.status === 'active' : !verified && user.status !== 'suspended');
      const code = newOtpCode();
      i.otp = {
        channel: b.channel,
        destination,
        purpose: b.purpose,
        codeHash: live ? this.auth.state.otpHash(code, i.id) : randomBytes(32).toString('hex'),
        attempts: 0,
        expiresAt: Date.now() + OTP_TTL_MS,
        sentAt: Date.now(),
        live,
      };
      await this.auth.state.saveInteraction(i);
      if (!live) return;
      if (isPhone) await this.messages.sms(destination, 'identity.otp_code', user!.locale, { code });
      else await this.messages.email(destination, 'identity.otp_code', user!.locale, { code });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('auth.otp_verify')
export class OtpVerifyHandler implements OperationHandler {
  constructor(private readonly auth: AuthServer) {}

  async handle(ctx: OperationContext<{ interaction_id: string; code: string }>): Promise<OperationResult> {
    const i = await this.auth.interaction(ctx, ctx.body.interaction_id);
    const otp = i.otp;
    if (!otp || otp.expiresAt < Date.now() || otp.attempts >= OTP_MAX_ATTEMPTS) throw new ApiError('CODE_INVALID');
    await ctx.rateLimit('auth.signin', 'account', otp.destination);
    if (!otp.live || !constantTimeEqual(this.auth.state.otpHash(ctx.body.code, i.id), otp.codeHash)) {
      otp.attempts += 1;
      // Five wrong codes invalidate the code (SEC-AU-8).
      if (otp.attempts >= OTP_MAX_ATTEMPTS) delete i.otp;
      await this.auth.state.saveInteraction(i);
      throw new ApiError('CODE_INVALID');
    }
    delete i.otp;
    const next = await ctx.tx(async (scope) => {
      const isPhone = otp.channel === 'sms';
      const user = await findAccount(scope, isPhone ? { phone: otp.destination } : { email: otp.destination }, true);
      if (!user || user.status === 'suspended') throw new ApiError('CODE_INVALID');
      if (otp.purpose === 'verify') await markContactVerified(scope, user, isPhone ? 'phone' : 'email');
      const fresh = (await getUser(scope, user.id))!;
      return this.auth.afterFirstFactor(scope, i, fresh, 'otp');
    });
    return { body: next };
  }
}

/** auth.webauthn_options: request options for sign-in (passkey), the second factor or step-up (challenge 5 min). */
@Injectable()
@Operation('auth.webauthn_options')
export class WebAuthnOptionsHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly webauthn: WebAuthnService,
  ) {}

  async handle(ctx: OperationContext<{ interaction_id: string; purpose: 'signin' | 'mfa' | 'step_up' }>): Promise<OperationResult> {
    const b = ctx.body;
    const i = await this.auth.interaction(ctx, b.interaction_id);
    // The second factor and step-up follow a first factor; a passkey sign-in starts before one.
    if (b.purpose !== 'signin' && (!i.userId || !i.mfaPending)) throw new ApiError('INVALID_CREDENTIALS');
    if (b.purpose === 'signin' && i.userId) throw new ApiError('INVALID_CREDENTIALS');
    await ctx.rateLimit('auth.signin', 'account', i.userId ?? i.id);
    const options = await ctx.tx((scope) => this.webauthn.authenticationOptions(scope, i.userId ?? null), { readOnly: true });
    i.webauthn = { challenge: options.challenge, purpose: b.purpose, expiresAt: Date.now() + CHALLENGE_TTL_MS };
    await this.auth.state.saveInteraction(i);
    return { body: options };
  }
}

type MfaVerify = {
  interaction_id: string;
  method: 'totp_mfa' | 'webauthn' | 'recovery_code';
  code?: string;
  recovery_code?: string;
  assertion?: unknown;
};

@Injectable()
@Operation('auth.mfa_verify')
export class MfaVerifyHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly mfa: MfaService,
    private readonly webauthn: WebAuthnService,
  ) {}

  async handle(ctx: OperationContext<MfaVerify>): Promise<OperationResult> {
    const b = ctx.body;
    // "C: one per method".
    const needed = b.method === 'totp_mfa' ? 'code' : b.method === 'recovery_code' ? 'recovery_code' : 'assertion';
    for (const f of ['code', 'recovery_code', 'assertion'] as const) {
      if (f === needed && b[f] === undefined) throw ApiError.validation([{ pointer: `/${f}`, code: 'conditional_required' }]);
      if (f !== needed && b[f] !== undefined) throw ApiError.validation([{ pointer: `/${f}`, code: 'conditional_forbidden' }]);
    }
    const i = await this.auth.interaction(ctx, b.interaction_id);
    const ceremony = i.webauthn && i.webauthn.expiresAt > Date.now() ? i.webauthn : null;
    // A passkey as the only factor (auth.webauthn_options purpose signin, GD-31): the credential names the account.
    const passkeySignin = !i.userId && b.method === 'webauthn' && ceremony?.purpose === 'signin';
    if (!passkeySignin && (!i.userId || !i.mfaPending)) throw new ApiError('INVALID_CREDENTIALS');
    await ctx.rateLimit('auth.signin', 'account', i.userId ?? i.id);
    const result = await ctx.tx(async (scope) => {
      if (b.method === 'totp_mfa')
        return (await this.mfa.verifyAnyTotp(scope, i.userId!, b.code!)) ? { deviceBound: false, userId: i.userId! } : null;
      if (b.method === 'recovery_code')
        return (await this.mfa.useRecoveryCode(scope, i.userId!, b.recovery_code!)) ? { deviceBound: false, userId: i.userId! } : null;
      if (!ceremony) return null;
      const v = await this.webauthn.verifyAssertion(scope, b.assertion, ceremony.challenge, i.userId ?? null);
      if (!v) return null;
      if (passkeySignin) {
        const user = await getUser(scope, v.userId);
        if (!user || user.status === 'suspended' || user.status === 'deleted') return null;
      }
      return v;
    });
    // SEC-ADM-2: the admin client accepts device-bound WebAuthn only (aal3).
    if (!result || (i.clientId === 'cp-web-admin' && (b.method !== 'webauthn' || !result.deviceBound))) {
      i.mfaFailures += 1;
      delete i.webauthn;
      // Too many wrong second factors end the interaction.
      if (i.mfaFailures >= OTP_MAX_ATTEMPTS) await this.auth.state.dropInteraction(i.id);
      else await this.auth.state.saveInteraction(i);
      throw new ApiError('INVALID_CREDENTIALS');
    }
    if (passkeySignin) return { body: await completePasskeySignin(this.auth.state, i, result.userId, result.deviceBound) };
    delete i.webauthn;
    if (b.method === 'webauthn')
      return { body: await this.auth.afterSecondFactor(i, result.deviceBound ? 'hwk' : 'swk', result.deviceBound ? 'aal3' : 'aal2') };
    return { body: await this.auth.afterSecondFactor(i, b.method === 'totp_mfa' ? 'otp' : 'rc') };
  }
}

// ------------------------------------------------------------------ links: email verification, password reset

@Injectable()
@Operation('auth.email_verify')
export class EmailVerifyHandler implements OperationHandler {
  constructor(private readonly links: LinkTokens) {}

  async handle(ctx: OperationContext<{ token: string }>): Promise<OperationResult> {
    const { hash } = this.links.parse(ctx.body.token, 'ev');
    await ctx.tx(async (scope) => {
      const used = await consumeVerificationToken(scope, hash, 'email_verification');
      if (!used.ok) throw consumeFailure(used.usedAt === undefined ? undefined : { used_at: used.usedAt });
      const user = await getUser(scope, used.userId, true);
      if (!user || user.status === 'deleted') throw new ApiError('LINK_EXPIRED');
      const target = used.targetEmail!;
      if (target === user.email) {
        await markContactVerified(scope, user, 'email');
        return;
      }
      // Email change (me.email_change): applied now that the new address is proven.
      const taken = await findAccount(scope, { email: target });
      if (taken && taken.id !== user.id) throw new ApiError('DUPLICATE', { detail: 'email in use' });
      await scope.db
        .updateTable('identity.user_accounts')
        .set({ email: target, email_verified_at: sql`now()` })
        .where('id', '=', user.id)
        .execute();
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ identifier: target })
        .where('user_id', '=', user.id)
        .where('method_type', '=', 'email_password')
        .where('deleted_at', 'is', null)
        .execute();
      await writeAudit(scope, { action: 'user.email_changed', entityType: 'user_account', entityId: user.id });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('auth.password_reset_start')
export class PasswordResetStartHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly links: LinkTokens,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ email: string }>): Promise<OperationResult> {
    const email = normalizeEmail(ctx.body.email);
    await ctx.rateLimit('auth.otp', 'destination', email);
    await withMinLatency(this.auth.config.auth.minLatencyMs, async () => {
      const sent = await ctx.tx(async (scope) => {
        const user = await findAccount(scope, { email });
        if (!user || (user.status !== 'active' && user.status !== 'pending_verification')) return null;
        await revokeVerificationTokens(scope, user.id, 'password_reset');
        const link = this.links.issue('pr');
        await scope.db
          .insertInto('identity.verification_tokens')
          .values({ user_id: user.id, token_type: 'password_reset', token_hash: link.hash, expires_at: link.expiresAt! })
          .execute();
        return { token: link.token, locale: user.locale };
      });
      // Nothing is sent for unknown addresses; the response never says which (SEC-AU-11).
      if (sent) await this.messages.email(email, 'identity.password_reset', sent.locale, { link: this.links.link('pr', sent.token) });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('auth.password_reset_complete')
export class PasswordResetCompleteHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly crypto: CryptoServices,
    private readonly sessions: SessionStore,
  ) {}

  async handle(ctx: OperationContext<{ token: string; new_password: string }>): Promise<OperationResult> {
    const { hash } = this.links.parse(ctx.body.token, 'pr');
    if (isBreachedPassword(ctx.body.new_password)) throw ApiError.validation([{ pointer: '/new_password', code: 'pattern' }]);
    const newHash = await this.crypto.passwords.hash(ctx.body.new_password);
    const userId = await ctx.tx(async (scope) => {
      const used = await consumeVerificationToken(scope, hash, 'password_reset');
      if (!used.ok) throw consumeFailure(used.usedAt === undefined ? undefined : { used_at: used.usedAt });
      const user = await getUser(scope, used.userId, true);
      if (!user || user.status === 'deleted') throw new ApiError('LINK_EXPIRED');
      const [method] = (await methods(scope, user.id, ['email_password'], true)).filter((m) => m.status === 'active');
      if (method)
        await scope.db
          .updateTable('identity.authentication_methods')
          .set({ credential_reference: newHash })
          .where('id', '=', method.id)
          .execute();
      else
        await scope.db
          .insertInto('identity.authentication_methods')
          .values({
            user_id: user.id,
            method_type: 'email_password',
            identifier: user.email,
            credential_reference: newHash,
            status: 'active',
          })
          .execute();
      await writeAudit(scope, { action: 'user.password_reset', entityType: 'user_account', entityId: user.id });
      return user.id;
    });
    // "revokes every session and refresh token of the account" (refresh families die with their sessions).
    await this.sessions.revokeAll(userId);
    return { body: ACK };
  }
}
