// Memberships, sessions and second factors of the caller (40 §6.3):
// me.memberships_list / membership_leave, me.sessions_list / session_revoke /
// sessions_revoke_all, me.mfa_list / mfa_totp_enroll / mfa_confirm /
// mfa_remove / recovery_codes_regenerate. SEC-AU-4: password, MFA and
// "sign out everywhere" changes end the other sessions at once.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { SessionStore } from '#libs/auth/index.js';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { toMfaMethod, toSession } from '../api/projections.js';
import { newTotpSecret, otpauthUri } from '../domain/credentials.js';
import { activeSecondFactors, getUser, methods, platformRoles } from '../infrastructure/accounts.js';
import { caller, MeReader } from './common.js';
import { MfaService } from './mfa-service.js';

type Position = { id?: string; o?: number } | undefined;

@Injectable()
@Operation('me.memberships_list')
export class MembershipsListHandler implements OperationHandler {
  constructor(private readonly reader: MeReader) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const after = (ctx.cursor as Position)?.id;
    const { items, more } = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('identity.role_memberships').selectAll().where('user_id', '=', userId).where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        return { items: await this.reader.membershipViews(scope, rows.slice(0, ctx.query.limit)), more: rows.length > ctx.query.limit };
      },
      { readOnly: true },
    );
    return { body: ctx.page(items, more ? { id: items.at(-1)!.id } : null) };
  }
}

const OWNER_ROLES = ['provider_owner', 'vendor_owner', 'fleet_owner'];

@Injectable()
@Operation('me.membership_leave')
export class MembershipLeaveHandler implements OperationHandler {
  constructor(private readonly authorizer: Authorizer) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    await ctx.tx(async (scope) => {
      const m = await scope.db
        .selectFrom('identity.role_memberships')
        .selectAll()
        .where('id', '=', ctx.params.membership_id!)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!m || m.status === 'removed') throw new ApiError('NOT_FOUND');
      // Only organization memberships can be left; the individual and platform roles cannot.
      if (!m.organization_id) throw new ApiError('INVALID_TRANSITION', { detail: 'not an organization membership' });
      // The organization's other members are visible once the context is switched to it (policy self_or_org).
      await scope.setOrganization(m.organization_id, m.role);
      if (OWNER_ROLES.includes(m.role) && m.status === 'active') {
        const others = await scope.db
          .selectFrom('identity.role_memberships')
          .select('id')
          .where('organization_id', '=', m.organization_id)
          .where('role', 'in', OWNER_ROLES)
          .where('status', '=', 'active')
          .where('id', '<>', m.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!others) throw new ApiError('INVALID_TRANSITION', { detail: 'last_owner' });
      }
      await scope.db.updateTable('identity.role_memberships').set({ status: 'removed' }).where('id', '=', m.id).execute();
      await scope.db
        .updateTable('identity.user_preferences')
        .set({ default_role_membership_id: null })
        .where('user_id', '=', userId)
        .where('default_role_membership_id', '=', m.id)
        .execute();
      await writeAudit(scope, { action: 'membership.left', entityType: 'role_membership', entityId: m.id, previous: m.role });
      // SEC-AU-3: a removed role stops working at once.
      scope.afterCommit(() => this.authorizer.invalidateUser(userId));
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.sessions_list')
export class SessionsListHandler implements OperationHandler {
  constructor(private readonly sessions: SessionStore) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const p = caller(ctx);
    const all = (await this.sessions.list(p.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sid.localeCompare(a.sid));
    const offset = (ctx.cursor as Position)?.o ?? 0;
    const items = all.slice(offset, offset + ctx.query.limit).map((s) => toSession(s, p.sessionId));
    return { body: ctx.page(items, offset + ctx.query.limit < all.length ? { o: offset + ctx.query.limit } : null) };
  }
}

@Injectable()
@Operation('me.session_revoke')
export class SessionRevokeHandler implements OperationHandler {
  constructor(private readonly sessions: SessionStore) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const p = caller(ctx);
    const s = await this.sessions.get(ctx.params.session_id!);
    if (!s || s.userId !== p.userId) throw new ApiError('NOT_FOUND');
    await this.sessions.revoke(s.sid);
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.sessions_revoke_all')
export class SessionsRevokeAllHandler implements OperationHandler {
  constructor(private readonly sessions: SessionStore) {}

  async handle(ctx: OperationContext<{ keep_current: boolean }>): Promise<OperationResult> {
    const p = caller(ctx);
    const revoked = await this.sessions.revokeAll(p.userId, ctx.body.keep_current ? p.sessionId : undefined);
    await ctx.tx((scope) =>
      writeAudit(scope, { action: 'user.sessions_revoked', entityType: 'user_account', entityId: p.userId, next: `revoked=${revoked}` }),
    );
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.mfa_list')
export class MfaListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const after = (ctx.cursor as Position)?.id;
    const rows = await ctx.tx(
      async (scope) => (await methods(scope, userId, ['totp_mfa', 'webauthn'])).filter((m) => (after ? m.id > after : true)),
      { readOnly: true },
    );
    const page = rows.slice(0, ctx.query.limit);
    return { body: ctx.page(page.map(toMfaMethod), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null) };
  }
}

@Injectable()
@Operation('me.mfa_totp_enroll')
export class MfaTotpEnrollHandler implements OperationHandler {
  constructor(private readonly mfa: MfaService) {}

  async handle(ctx: OperationContext<{ label: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const { method, uri } = await ctx.tx(async (scope) => {
      const user = await getUser(scope, userId);
      if (!user) throw new ApiError('NOT_FOUND');
      // One pending enrolment at a time: an unconfirmed earlier one is discarded.
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'disabled', deleted_at: sql`now()` })
        .where('user_id', '=', userId)
        .where('method_type', '=', 'totp_mfa')
        .where('status', '=', 'pending')
        .where('deleted_at', 'is', null)
        .execute();
      const id = uuidv7();
      const secret = newTotpSecret();
      const row = await scope.db
        .insertInto('identity.authentication_methods')
        .values({
          id,
          user_id: userId,
          method_type: 'totp_mfa',
          identifier: id,
          label: ctx.body.label,
          credential_reference: this.mfa.sealSecret(id, secret),
          status: 'pending',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { method: row, uri: otpauthUri(secret, user.email) };
    });
    // The provisioning URI is returned once; it is never readable again.
    return created({ method: toMfaMethod(method), otpauth_uri: uri }, `/v1/me/mfa-methods/${method.id}`);
  }
}

@Injectable()
@Operation('me.mfa_confirm')
export class MfaConfirmHandler implements OperationHandler {
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionStore,
  ) {}

  async handle(ctx: OperationContext<{ code?: string; attestation?: unknown }>): Promise<OperationResult> {
    const p = caller(ctx);
    const result = await ctx.tx(async (scope) => {
      const [m] = (await methods(scope, p.userId, ['totp_mfa', 'webauthn'], true)).filter((x) => x.id === ctx.params.method_id);
      if (!m) throw new ApiError('NOT_FOUND');
      if (m.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: `method is ${m.status}` });
      // "C: one per method type": TOTP takes a code, WebAuthn an attestation (WebAuthn is not supported yet, S3 deviation).
      if (m.method_type === 'totp_mfa') {
        if (ctx.body.attestation !== undefined) throw ApiError.validation([{ pointer: '/attestation', code: 'conditional_forbidden' }]);
        if (ctx.body.code === undefined) throw ApiError.validation([{ pointer: '/code', code: 'conditional_required' }]);
        if (!(await this.mfa.checkTotp(scope, m, ctx.body.code))) throw new ApiError('CODE_INVALID');
      } else {
        throw new ApiError('INVALID_TRANSITION', { detail: 'WebAuthn credentials are not supported yet' });
      }
      const first = (await activeSecondFactors(scope, p.userId)).length === 0;
      const method = await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'active', verified_at: sql`now()` })
        .where('id', '=', m.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await scope.db.updateTable('identity.user_accounts').set({ mfa_enabled: true }).where('id', '=', p.userId).execute();
      const codes = first ? await this.mfa.issueRecoveryCodes(scope, p.userId) : undefined;
      await writeAudit(scope, { action: 'user.mfa_enabled', entityType: 'authentication_method', entityId: m.id, next: m.method_type });
      return { method, codes };
    });
    // SEC-AU-4 (MFA change): other sessions end; this one has just proven the second factor.
    await this.sessions.revokeAll(p.userId, p.sessionId);
    await this.sessions.update(p.sessionId, { acr: 'aal2', authTime: Math.floor(Date.now() / 1000), mfaEnrolled: true });
    return { body: { method: toMfaMethod(result.method), ...(result.codes ? { recovery_codes: result.codes } : {}) } };
  }
}

@Injectable()
@Operation('me.mfa_remove')
export class MfaRemoveHandler implements OperationHandler {
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionStore,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const p = caller(ctx);
    const remaining = await ctx.tx(async (scope) => {
      const all = await methods(scope, p.userId, ['totp_mfa', 'webauthn'], true);
      const m = all.find((x) => x.id === ctx.params.method_id);
      if (!m) throw new ApiError('NOT_FOUND');
      const rest = all.filter((x) => x.id !== m.id && x.status === 'active');
      // SEC-AU-9: staff must keep a WebAuthn credential.
      if (
        m.method_type === 'webauthn' &&
        !rest.some((x) => x.method_type === 'webauthn') &&
        (await platformRoles(scope, p.userId)).length > 0
      )
        throw new ApiError('INVALID_TRANSITION', { detail: 'last WebAuthn credential of a staff account' });
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'disabled', deleted_at: sql`now()` })
        .where('id', '=', m.id)
        .execute();
      if (rest.length === 0) {
        await scope.db.updateTable('identity.user_accounts').set({ mfa_enabled: false }).where('id', '=', p.userId).execute();
        await this.mfa.disableRecoveryCodes(scope, p.userId);
      }
      await writeAudit(scope, { action: 'user.mfa_removed', entityType: 'authentication_method', entityId: m.id, previous: m.method_type });
      return rest.length;
    });
    await this.sessions.revokeAll(p.userId, p.sessionId);
    if (remaining === 0) await this.sessions.update(p.sessionId, { mfaEnrolled: false });
    return { body: ACK };
  }
}

@Injectable()
@Operation('me.recovery_codes_regenerate')
export class RecoveryCodesRegenerateHandler implements OperationHandler {
  constructor(private readonly mfa: MfaService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const codes = await ctx.tx(async (scope) => {
      if ((await activeSecondFactors(scope, userId)).length === 0)
        throw new ApiError('INVALID_TRANSITION', { detail: 'no active second factor' });
      const out = await this.mfa.issueRecoveryCodes(scope, userId);
      await writeAudit(scope, { action: 'user.recovery_codes_regenerated', entityType: 'user_account', entityId: userId });
      return out;
    });
    return { body: { recovery_codes: codes } };
  }
}
