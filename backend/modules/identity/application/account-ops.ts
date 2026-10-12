// Account operations (40 §6.3): me.get, me.update, me.email_change,
// me.phone_change_start / verify, me.password_change, me.preferences_get /
// update. api host, user RLS context (policies self_read / self_update /
// self_all on identity.*).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { SessionStore } from '#libs/auth/index.js';
import { writeAudit } from '#libs/audit/index.js';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { ConsentType } from '#libs/contract/generated/enums.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { toPreference } from '../api/projections.js';
import { constantTimeEqual, isBreachedPassword, newOtpCode } from '../domain/credentials.js';
import { getPreferences, getUser, methods, normalizeEmail, revokeVerificationTokens } from '../infrastructure/accounts.js';
import { AuthState, OTP_MAX_ATTEMPTS, OTP_RESEND_MS, OTP_TTL_MS } from '../infrastructure/auth-state.js';
import { IdentityMessages } from '../infrastructure/messages.js';
import { caller, checkTimezone, MeReader } from './common.js';

@Injectable()
@Operation('me.get')
export class MeGetHandler implements OperationHandler {
  constructor(private readonly reader: MeReader) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    return { body: await ctx.tx((scope) => this.reader.me(scope, userId)) };
  }
}

type MeUpdate = {
  full_name?: string;
  display_name?: string | null;
  locale?: string;
  timezone?: string;
  preferred_contact_channel?: string | null;
};

@Injectable()
@Operation('me.update')
export class MeUpdateHandler implements OperationHandler {
  constructor(private readonly reader: MeReader) {}

  async handle(ctx: OperationContext<MeUpdate>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const b = ctx.body;
    if (b.timezone !== undefined) checkTimezone(b.timezone, '/timezone');
    const body = await ctx.tx(async (scope) => {
      const user = await getUser(scope, userId, true);
      if (!user) throw new ApiError('NOT_FOUND');
      if (user.version !== ctx.ifMatch) throw new ApiError('VERSION_MISMATCH');
      const patch = Object.fromEntries(
        (['full_name', 'display_name', 'locale', 'timezone', 'preferred_contact_channel'] as const)
          .filter((k) => b[k] !== undefined)
          .map((k) => [k, b[k]]),
      );
      if (Object.keys(patch).length) await scope.db.updateTable('identity.user_accounts').set(patch).where('id', '=', userId).execute();
      return this.reader.me(scope, userId);
    });
    return { body };
  }
}

@Injectable()
@Operation('me.email_change')
export class MeEmailChangeHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ new_email: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const newEmail = normalizeEmail(ctx.body.new_email);
    await ctx.rateLimit('auth.otp', 'destination', newEmail);
    await ctx.tx(async (scope) => {
      const user = await getUser(scope, userId);
      if (!user) throw new ApiError('NOT_FOUND');
      await writeAudit(scope, { action: 'user.email_change_requested', entityType: 'user_account', entityId: userId });
      if (newEmail === user.email) return;
      // The change applies only when the link sent to the new address is used (auth.email_verify);
      // whether the address is taken is decided there, so this response reveals nothing.
      await revokeVerificationTokens(scope, userId, 'email_verification');
      const link = this.links.issue('ev');
      await scope.db
        .insertInto('identity.verification_tokens')
        .values({
          user_id: userId,
          token_type: 'email_verification',
          token_hash: link.hash,
          target_email: newEmail,
          expires_at: link.expiresAt!,
        })
        .execute();
      scope.afterCommit(async () => {
        await this.messages.email(newEmail, 'identity.email_verification', user.locale, { link: this.links.link('ev', link.token) });
        await this.messages.email(user.email, 'identity.email_change_notice', user.locale);
      });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.phone_change_start')
export class MePhoneChangeStartHandler implements OperationHandler {
  constructor(
    private readonly state: AuthState,
    private readonly region: RegionConfigService,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ phone: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const phone = ctx.body.phone;
    // SEC-AU-8: SMS only to country codes on the region allowlist (anti SMS pumping).
    if (!this.region.smsAllowed(phone)) throw ApiError.validation([{ pointer: '/phone', code: 'enum' }]);
    await ctx.rateLimit('auth.otp', 'destination', phone);
    const pending = await this.state.phoneChange(userId);
    if (pending && pending.destination === phone && Date.now() - pending.sentAt < OTP_RESEND_MS) return { body: ACK };
    const user = await ctx.tx((scope) => getUser(scope, userId), { readOnly: true });
    const code = newOtpCode();
    const now = Date.now();
    await this.state.putPhoneChange(userId, {
      channel: 'sms',
      destination: phone,
      purpose: 'verify',
      codeHash: this.state.otpHash(code, `phone:${userId}`),
      attempts: 0,
      expiresAt: now + OTP_TTL_MS,
      sentAt: now,
      live: true,
    });
    await this.messages.sms(phone, 'identity.otp_code', user?.locale ?? ctx.locale, { code });
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.phone_change_verify')
export class MePhoneChangeVerifyHandler implements OperationHandler {
  constructor(
    private readonly state: AuthState,
    private readonly reader: MeReader,
  ) {}

  async handle(ctx: OperationContext<{ code: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    await ctx.rateLimit('auth.signin', 'account', userId);
    const pending = await this.state.phoneChange(userId);
    if (!pending || pending.expiresAt < Date.now() || pending.attempts >= OTP_MAX_ATTEMPTS) throw new ApiError('CODE_INVALID');
    if (!constantTimeEqual(this.state.otpHash(ctx.body.code, `phone:${userId}`), pending.codeHash)) {
      pending.attempts += 1;
      // Five wrong codes invalidate the code (SEC-AU-8); no remaining-attempts count is disclosed.
      await this.state.savePhoneChange(userId, pending.attempts >= OTP_MAX_ATTEMPTS ? null : pending);
      throw new ApiError('CODE_INVALID');
    }
    const body = await ctx.tx(async (scope) => {
      await scope.db
        .updateTable('identity.user_accounts')
        .set({ phone: pending.destination, phone_verified_at: sql`now()` })
        .where('id', '=', userId)
        .execute();
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ identifier: pending.destination })
        .where('user_id', '=', userId)
        .where('method_type', '=', 'phone_otp')
        .where('deleted_at', 'is', null)
        .execute();
      await writeAudit(scope, { action: 'user.phone_changed', entityType: 'user_account', entityId: userId });
      return this.reader.me(scope, userId);
    });
    await this.state.savePhoneChange(userId, null);
    return { body };
  }
}

@Injectable()
@Operation('me.password_change')
export class MePasswordChangeHandler implements OperationHandler {
  constructor(
    private readonly crypto: CryptoServices,
    private readonly sessions: SessionStore,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ current_password: string; new_password: string }>): Promise<OperationResult> {
    const p = caller(ctx);
    await ctx.rateLimit('auth.signin', 'account', p.userId);
    if (isBreachedPassword(ctx.body.new_password)) throw ApiError.validation([{ pointer: '/new_password', code: 'pattern' }]);
    const email = await ctx.tx(async (scope) => {
      const [method] = (await methods(scope, p.userId, ['email_password'], true)).filter((m) => m.status === 'active');
      if (!method || !(await this.crypto.passwords.verify(ctx.body.current_password, method.credential_reference ?? '')))
        throw new ApiError('INVALID_CREDENTIALS');
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ credential_reference: await this.crypto.passwords.hash(ctx.body.new_password) })
        .where('id', '=', method.id)
        .execute();
      await writeAudit(scope, { action: 'user.password_changed', entityType: 'user_account', entityId: p.userId });
      return (await getUser(scope, p.userId))!;
    });
    // SEC-AU-4: every other session (and its refresh-token family) ends.
    await this.sessions.revokeAll(p.userId, p.sessionId);
    await this.messages.email(email.email, 'identity.password_changed', email.locale);
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.preferences_get')
export class MePreferencesGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    return { body: toPreference(await ctx.tx((scope) => getPreferences(scope, userId), { readOnly: true })) };
  }
}

type PreferenceUpdate = Partial<{
  default_role_membership_id: string | null;
  calendar_system: string;
  digit_style: string;
  distance_unit: string;
  navigation_app_key: string | null;
  preferred_currency: string | null;
  profile_visibility: string;
  show_vehicles_on_profile: boolean;
  ai_personalization_enabled: boolean;
  ai_suggestions_enabled: boolean;
  critical_alerts_only: boolean;
  marketing_opt_in: boolean;
}>;

/** Preferences that may be true only with an active consent (52 UserPreference). */
const CONSENT_GATED: [keyof PreferenceUpdate, ConsentType][] = [
  ['ai_personalization_enabled', 'ai_personalization'],
  ['marketing_opt_in', 'marketing'],
];

@Injectable()
@Operation('me.preferences_update')
export class MePreferencesUpdateHandler implements OperationHandler {
  constructor(
    private readonly consents: ConsentChecker,
    private readonly region: RegionConfigService,
  ) {}

  async handle(ctx: OperationContext<PreferenceUpdate>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    const region = this.region.forLocale(ctx.locale);
    if (b.navigation_app_key != null && !region.navigation_apps.some((a) => a.key === b.navigation_app_key))
      errors.push({ pointer: '/navigation_app_key', code: 'enum' });
    if (b.preferred_currency != null && b.preferred_currency !== region.currency)
      errors.push({ pointer: '/preferred_currency', code: 'enum' });
    if (errors.length) throw ApiError.validation(errors);
    const row = await ctx.tx(async (scope) => {
      const pref = await scope.db
        .selectFrom('identity.user_preferences')
        .selectAll()
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!pref) throw new ApiError('NOT_FOUND');
      if (pref.version !== ctx.ifMatch) throw new ApiError('VERSION_MISMATCH');
      if (b.default_role_membership_id) {
        // SEC-AZ-4: only the caller's own active membership.
        const m = await scope.db
          .selectFrom('identity.role_memberships')
          .select('id')
          .where('id', '=', b.default_role_membership_id)
          .where('user_id', '=', userId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!m) throw ApiError.validation([{ pointer: '/default_role_membership_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      }
      for (const [field, consentType] of CONSENT_GATED) {
        if (b[field] === true && !pref[field]) {
          const granted = await this.consents.isGranted(scope, {
            consentType,
            subject: { type: 'user', id: userId },
            grantee: { type: 'platform' },
          });
          if (!granted) throw new ApiError('CONSENT_REQUIRED', { detail: `consent ${consentType}` });
        }
      }
      const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length === 0) return pref;
      return scope.db
        .updateTable('identity.user_preferences')
        .set(patch)
        .where('id', '=', pref.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toPreference(row) };
  }
}
