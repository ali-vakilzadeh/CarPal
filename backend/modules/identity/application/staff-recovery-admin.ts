// Staff account recovery on the admin plane (backend S16b, contract 1.4.0 §23.2; admin console BR-19; owner decisions
// DQ-04 and DQ-15): the administrators' queue of recovery requests and their decisions. Two different administrators,
// neither the requester nor under the post-recovery restriction, each with a fresh aal3, approve after an out-of-band
// check of the person (a call to a known number, in person, a video call, other with a note); any administrator can
// reject, which ends the request. The request's life on the auth host is in staff-recovery.ts.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import {
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { StaffNames, staffOf } from '#modules/admin/interface/admin.js';
import { getUser } from '../infrastructure/accounts.js';
import { IdentityMessages } from '../infrastructure/messages.js';
import { StaffRestrictions } from '../interface/identity.js';
import { STAFF_FRESH_AAL3_S } from './staff-security.js';
import { maskEmail } from './staff-ops.js';
import {
  approvalsOf,
  consoleUrl,
  effectiveStatus,
  RECOVERY_APPROVALS,
  recoverable,
  type RecoveryRow,
  type RecoveryStatus,
} from './staff-recovery.js';

const ROLE_ORDER = ['platform_admin', 'platform_moderator', 'platform_support', 'platform_community_reviewer'];
type ListStatus = Exclude<RecoveryStatus, 'awaiting_email_code'>;

/** 40 StaffRecoveryRequest for each row (one query per kind for the page): never codes, handles or contact data. */
async function views(scope: TxScope, names: StaffNames, rows: RecoveryRow[], callerId: string, locale: string) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const [decisions, roles, users] = await Promise.all([
    scope.db
      .selectFrom('identity.staff_recovery_approvals')
      .selectAll()
      .where('request_id', 'in', ids)
      .where('deleted_at', 'is', null)
      .orderBy('decided_at')
      .orderBy('id')
      .execute(),
    scope.db
      .selectFrom('identity.role_memberships')
      .select(['user_id', 'role'])
      .where('user_id', 'in', userIds)
      .where('organization_id', 'is', null)
      .where('role', 'like', 'platform\\_%')
      .where('status', 'in', ['active', 'suspended'])
      .where('deleted_at', 'is', null)
      .execute(),
    scope.db.selectFrom('identity.user_accounts').select(['id', 'email']).where('id', 'in', userIds).execute(),
  ]);
  const display = await names.names(scope, [...userIds, ...decisions.map((d) => d.approver_id)], locale);
  const email = new Map(users.map((u) => [u.id, u.email]));
  return rows.map((r) => {
    const own = decisions.filter((d) => d.request_id === r.id);
    const approvals = own.filter((d) => d.decision === 'approve');
    const held = roles.filter((m) => m.user_id === r.user_id).map((m) => m.role);
    return {
      id: r.id,
      user_id: r.user_id,
      display_name: display.get(r.user_id)!.slice(0, 50),
      email_masked: maskEmail(email.get(r.user_id) ?? ''),
      platform_roles: ROLE_ORDER.filter((x) => held.includes(x)),
      status: effectiveStatus(r) as ListStatus,
      password_forgotten: r.password_forgotten,
      requested_at: iso(r.created_at),
      expires_at: iso(r.expires_at),
      ip_country: r.ip_country,
      approvals: Math.min(RECOVERY_APPROVALS, approvals.length),
      approved_by_me: approvals.some((d) => d.approver_id === callerId),
      decisions: own.slice(0, 20).map((d) => ({
        decided_by_display: display.get(d.approver_id)!.slice(0, 50),
        decision: d.decision as 'approve' | 'reject',
        reason: d.reason,
        verification_method: d.verification_method,
        note: d.note,
        decided_at: iso(d.decided_at),
      })),
      completed_at: isoOrNull(r.completed_at),
      restricted_until: isoOrNull(r.restricted_until),
    };
  });
}

/** A request the queue shows (its emailed code was checked); 404 otherwise. */
async function loadRequest(scope: TxScope, id: string, lock = false): Promise<RecoveryRow> {
  const q = scope.db.selectFrom('identity.staff_recovery_requests').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const r = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!r || r.email_verified_at === null) throw new ApiError('NOT_FOUND');
  return r;
}

@Injectable()
@Operation('admin.staff_recoveries_list')
export class AdminStaffRecoveriesListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, { status?: ListStatus; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const status = ctx.query.status ?? 'awaiting_approvals';
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('identity.staff_recovery_requests')
          .selectAll()
          .where('deleted_at', 'is', null)
          // Requests whose emailed code was never checked are not the administrators' business.
          .where('email_verified_at', 'is not', null);
        // Overdue open requests count as expired before the W15 rule marks them.
        if (status === 'awaiting_approvals' || status === 'approved')
          q = q.where('status', '=', status).where('expires_at', '>', sql<Date>`now()`);
        else if (status === 'expired')
          q = q.where((eb) =>
            eb.or([
              eb('status', '=', 'expired'),
              eb.and([eb('status', 'in', ['awaiting_approvals', 'approved']), eb('expires_at', '<=', sql<Date>`now()`)]),
            ]),
          );
        else q = q.where('status', '=', status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return ctx.page(
          await views(scope, this.names, page, s.userId, ctx.locale),
          rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.staff_recovery_get')
export class AdminStaffRecoveryGetHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(
      async (scope) => (await views(scope, this.names, [await loadRequest(scope, ctx.params.request_id!)], s.userId, ctx.locale))[0],
      { readOnly: true },
    );
    return { body };
  }
}

type ApproveBody = { reason: string; verification_method: 'phone_known_number' | 'in_person' | 'video_call' | 'other'; note?: string };

@Injectable()
@Operation('admin.staff_recovery_approve')
export class AdminStaffRecoveryApproveHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly restrictions: StaffRestrictions,
    private readonly messages: IdentityMessages,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {}

  async handle(ctx: OperationContext<ApproveBody>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    // SEC-ADM-2: a sign-in at aal3 within the last 5 minutes.
    ctx.requireAssurance('aal3', STAFF_FRESH_AAL3_S);
    if (b.verification_method === 'other' && b.note === undefined)
      throw ApiError.validation([{ pointer: '/note', code: 'conditional_required' }]);
    const out = await ctx.tx(async (scope) => {
      await this.restrictions.assertNotRestricted(scope, s.userId);
      const r = await loadRequest(scope, ctx.params.request_id!, true);
      if (r.user_id === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own request' });
      const status = effectiveStatus(r);
      if (status === 'expired') throw new ApiError('INVALID_TRANSITION', { detail: 'expired' });
      if (status !== 'awaiting_approvals') throw new ApiError('INVALID_TRANSITION', { detail: 'not_awaiting_approvals' });
      const mine = await scope.db
        .selectFrom('identity.staff_recovery_approvals')
        .select('id')
        .where('request_id', '=', r.id)
        .where('approver_id', '=', s.userId)
        .where('decision', '=', 'approve')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (mine) throw new ApiError('INVALID_TRANSITION', { detail: 'already_approved' });
      // Disabled meanwhile (admin.staff_disable): a disabled member never comes back through a recovery.
      const user = await getUser(scope, r.user_id);
      if (!(await recoverable(scope, user))) throw new ApiError('INVALID_TRANSITION', { detail: 'requester_disabled' });
      await scope.db
        .insertInto('identity.staff_recovery_approvals')
        .values({
          request_id: r.id,
          approver_id: s.userId,
          decision: 'approve',
          reason: b.reason,
          verification_method: b.verification_method,
          note: b.note ?? null,
        })
        .execute();
      const n = await approvalsOf(scope, r.id);
      const approved = n >= RECOVERY_APPROVALS;
      const row = approved
        ? await scope.db
            .updateTable('identity.staff_recovery_requests')
            .set({ status: 'approved', approved_at: sql<Date>`now()` })
            .where('id', '=', r.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : r;
      await writeAudit(scope, {
        action: 'staff.recovery_approved',
        entityType: 'staff_recovery_request',
        entityId: r.id,
        reason: b.reason,
        previous: 'awaiting_approvals',
        next: `approval ${n} of ${RECOVERY_APPROVALS} (${b.verification_method})${approved ? '; request approved' : ''}`,
      });
      return { view: (await views(scope, this.names, [row], s.userId, ctx.locale))[0], approved, user: user! };
    });
    if (out.approved)
      await this.messages.email(out.user.email, 'identity.staff_recovery_approved', out.user.locale, {
        console_url: consoleUrl(this.config),
      });
    return { body: out.view };
  }
}

@Injectable()
@Operation('admin.staff_recovery_reject')
export class AdminStaffRecoveryRejectHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const out = await ctx.tx(async (scope) => {
      const r = await loadRequest(scope, ctx.params.request_id!, true);
      const status = effectiveStatus(r);
      if (status === 'expired') throw new ApiError('INVALID_TRANSITION', { detail: 'expired' });
      // An approved request not completed yet can still be stopped.
      if (status !== 'awaiting_approvals' && status !== 'approved') throw new ApiError('INVALID_TRANSITION', { detail: 'not_open' });
      await scope.db
        .insertInto('identity.staff_recovery_approvals')
        .values({ request_id: r.id, approver_id: s.userId, decision: 'reject', reason: ctx.body.reason })
        .execute();
      const row = await scope.db
        .updateTable('identity.staff_recovery_requests')
        .set({ status: 'rejected', rejected_at: sql<Date>`now()` })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'staff.recovery_rejected',
        entityType: 'staff_recovery_request',
        entityId: r.id,
        reason: ctx.body.reason,
        previous: status,
        next: 'rejected',
      });
      return { view: (await views(scope, this.names, [row], s.userId, ctx.locale))[0], user: await getUser(scope, r.user_id) };
    });
    if (out.user) await this.messages.email(out.user.email, 'identity.staff_recovery_rejected', out.user.locale);
    return { body: out.view };
  }
}
