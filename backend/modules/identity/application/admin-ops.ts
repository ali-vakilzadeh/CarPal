// Identity on the admin plane (40 §23.2 users, §23.5 data subject requests;
// SEC-ADM). Staff find users by exactly one identifier for an item in their
// queue (PURP, every read audited as pii.read), suspend or reactivate
// accounts (sessions revoked at once), sign users out, grant platform roles
// with a second approver (4EYES) and revoke them immediately, reset
// onboarding flows, and move data subject requests through verification and
// processing: the export bundle is built by W8 across every module's
// PersonalData handler, deletion runs after a second approver in the worker
// (user.deletion.requested → identity.dsr_deletion → user.deletion.completed).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { SessionStore } from '#libs/auth/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { acceptedJob, JobService } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, FourEyes, headerReasonOf, ModerationLog, staffOf } from '#modules/admin/interface/admin.js';
import { SubscriptionReader } from '#modules/billing/interface/billing.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { TrustAdmin } from '#modules/trust/interface/trust.js';
import { iso, isoOrNull } from '#libs/http-pipeline/index.js';
import { toDataSubjectRequest, toMembership, toOnboarding } from '../api/projections.js';
import { normalizeEmail, type UserRow } from '../infrastructure/accounts.js';
import { AccountAdmin, UserCards } from '../interface/identity.js';
import { DsrViews } from './privacy-ops.js';

export const DSR_EXPORT_QUEUE = 'identity.dsr_export';
const PLATFORM_ROLES = ['platform_admin', 'platform_moderator', 'platform_support', 'platform_community_reviewer'];
const DSR_NEXT: Record<string, string[]> = {
  received: ['verifying_identity', 'rejected'],
  verifying_identity: ['in_progress', 'rejected'],
  in_progress: ['completed', 'rejected'],
};

/** 40 StaffUserView (no credentials, tokens or consent internals). */
@Injectable()
export class StaffUserViews {
  constructor(
    private readonly orgs: OrgCards,
    private readonly subscriptions: SubscriptionReader,
    private readonly trust: TrustAdmin,
    private readonly moderation: ModerationLog,
  ) {}

  async view(scope: TxScope, u: UserRow) {
    const memberships = await scope.db
      .selectFrom('identity.role_memberships')
      .selectAll()
      .where('user_id', '=', u.id)
      .where('status', 'in', ['active', 'invited', 'suspended'])
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .limit(50)
      .execute();
    const cards = await this.orgs.cards(
      scope,
      memberships.map((m) => m.organization_id).filter((x): x is string => !!x),
    );
    const [subscription, counts, reports] = await Promise.all([
      this.subscriptions.staffSummaryForUser(scope, u.id),
      this.trust.userCounts(scope, u.id),
      this.moderation.reportsAgainst(scope, 'user', u.id),
    ]);
    return {
      id: u.id,
      full_name: u.full_name,
      display_name: u.display_name,
      email: u.email,
      phone: u.phone,
      status: u.status,
      email_verified_at: isoOrNull(u.email_verified_at),
      phone_verified_at: isoOrNull(u.phone_verified_at),
      mfa_enabled: u.mfa_enabled,
      created_at: iso(u.created_at),
      last_active_at: isoOrNull(u.last_active_at),
      memberships: memberships.map((m) => toMembership(m, cards)),
      subscription,
      trusted_user: u.trusted_user,
      counts: { reviews: counts.reviews, reports_against: reports, open_disputes: counts.openDisputes },
    };
  }
}

async function loadUser(scope: TxScope, id: string, lock = false): Promise<UserRow> {
  const q = scope.db.selectFrom('identity.user_accounts').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const u = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!u) throw new ApiError('NOT_FOUND');
  return u;
}

type UserSearch = { email?: string; phone?: string; name?: string; user_id?: string };

@Injectable()
@Operation('admin.users_search')
export class AdminUsersSearchHandler implements OperationHandler {
  constructor(private readonly views: StaffUserViews) {}

  async handle(ctx: OperationContext<UserSearch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const given = (['email', 'phone', 'name', 'user_id'] as const).filter((k) => b[k] !== undefined);
    if (given.length !== 1)
      throw ApiError.validation(
        given.length === 0
          ? [{ pointer: '/email', code: 'conditional_required' }]
          : [{ pointer: `/${given[1]}`, code: 'conditional_forbidden' }],
      );
    const body = await ctx.tx(async (scope) => {
      let q = scope.db.selectFrom('identity.user_accounts').selectAll().where('deleted_at', 'is', null);
      if (b.email) q = q.where('email', '=', normalizeEmail(b.email));
      else if (b.phone) q = q.where('phone', '=', b.phone);
      else if (b.user_id) q = q.where('id', '=', b.user_id);
      else q = q.where('full_name', 'ilike', `%${b.name!.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const rows = await q.orderBy('id').limit(20).execute();
      // SEC-LOG-4: every user shown is a staff read of personal data; an empty search is audited too.
      if (rows.length === 0) await auditStaffRead(scope, s, 'user_search', ctx.access.purpose!.id, `search by ${given[0]}`);
      for (const r of rows) await auditStaffRead(scope, s, 'user', r.id, `account view (search by ${given[0]})`);
      const items = [];
      for (const r of rows) items.push(await this.views.view(scope, r));
      return ctx.page(items, null);
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.user_get')
export class AdminUserGetHandler implements OperationHandler {
  constructor(private readonly views: StaffUserViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const u = await loadUser(scope, ctx.params.user_id!);
      await auditStaffRead(scope, s, 'user', u.id, 'account view');
      return this.views.view(scope, u);
    });
    return { body };
  }
}

@Injectable()
export class DbAccountAdmin extends AccountAdmin {
  constructor(
    private readonly sessions: SessionStore,
    private readonly authorizer: Authorizer,
  ) {
    super();
  }

  async setStatus(
    scope: TxScope,
    userId: string,
    status: 'active' | 'suspended' | 'deactivated',
    o: { reason: string; suspendUntil?: string | null },
  ): Promise<{ previous: string; next: string }> {
    const u = await loadUser(scope, userId, true);
    if (u.status === 'deleted') throw new ApiError('NOT_FOUND');
    if (status === 'active' && !u.email_verified_at && !u.phone_verified_at)
      throw new ApiError('INVALID_TRANSITION', { detail: 'no verified contact' });
    if (u.status !== status) await scope.db.updateTable('identity.user_accounts').set({ status }).where('id', '=', u.id).execute();
    await writeAudit(scope, {
      action: 'user.status_changed',
      entityType: 'user',
      entityId: u.id,
      reason: o.reason,
      previous: u.status,
      next: o.suspendUntil ? `${status} until ${o.suspendUntil}` : status,
    });
    scope.afterCommit(async () => {
      if (status !== 'active') await this.sessions.revokeAll(u.id);
      await this.authorizer.invalidateUser(u.id);
    });
    return { previous: u.status, next: status };
  }

  async facts(scope: TxScope, userId: string): Promise<{ createdAt: Date; verifiedContact: boolean } | null> {
    const u = await scope.db
      .selectFrom('identity.user_accounts')
      .select(['created_at', 'email_verified_at', 'phone_verified_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    return u ? { createdAt: u.created_at, verifiedContact: !!(u.email_verified_at || u.phone_verified_at) } : null;
  }
}

@Injectable()
@Operation('admin.user_status')
export class AdminUserStatusHandler implements OperationHandler {
  constructor(
    private readonly accounts: AccountAdmin,
    private readonly moderation: ModerationLog,
    private readonly views: StaffUserViews,
  ) {}

  async handle(ctx: OperationContext<{ status: 'active' | 'suspended' | 'deactivated'; reason: string; suspend_until?: string }>) {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (ctx.params.user_id === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own account' });
    if (b.suspend_until && (b.status !== 'suspended' || Date.parse(b.suspend_until) <= Date.now()))
      throw ApiError.validation([{ pointer: '/suspend_until', code: b.status !== 'suspended' ? 'conditional_forbidden' : 'out_of_range' }]);
    const body = await ctx.tx(async (scope) => {
      const change = await this.accounts.setStatus(scope, ctx.params.user_id!, b.status, {
        reason: b.reason,
        suspendUntil: b.suspend_until ?? null,
      });
      const action = b.status === 'active' ? 'reactivate_account' : 'suspend_account';
      const id = await this.moderation.record(scope, {
        targetType: 'user',
        targetId: ctx.params.user_id!,
        actionType: action,
        reason: b.reason,
        params: { status: b.status, ...(b.suspend_until ? { suspend_until: b.suspend_until } : {}), previous: change.previous },
        actorUserId: s.userId,
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: 'moderation_action',
        aggregateId: id,
        payload: { action_type: action, target_type: 'user', target_id: ctx.params.user_id, user_id: ctx.params.user_id, status: b.status },
      });
      return this.views.view(scope, await loadUser(scope, ctx.params.user_id!));
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.user_sessions_revoke')
export class AdminUserSessionsRevokeHandler implements OperationHandler {
  constructor(private readonly sessions: SessionStore) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    staffOf(ctx);
    await ctx.tx(async (scope) => {
      const u = await loadUser(scope, ctx.params.user_id!);
      await writeAudit(scope, {
        action: 'user.sessions_revoked',
        entityType: 'user',
        entityId: u.id,
        reason: ctx.body.reason,
        next: 'all sessions',
      });
      scope.afterCommit(async () => void (await this.sessions.revokeAll(u.id)));
    });
    return { body: { ok: true } };
  }
}

/** Applies an approved platform role grant (four-eyes executor of admin.platform_role_grant). */
export async function grantPlatformRole(
  scope: TxScope,
  authorizer: Authorizer,
  userId: string,
  role: string,
  reason: string,
): Promise<void> {
  const u = await loadUser(scope, userId);
  if (u.status !== 'active') throw new ApiError('INVALID_TRANSITION', { detail: `account ${u.status}` });
  const existing = await scope.db
    .selectFrom('identity.role_memberships')
    .select(['id', 'status'])
    .where('user_id', '=', userId)
    .where('role', '=', role)
    .where('organization_id', 'is', null)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (existing?.status === 'active') throw new ApiError('DUPLICATE', { detail: 'role already held' });
  if (existing)
    await scope.db
      .updateTable('identity.role_memberships')
      .set({ status: 'active', joined_at: sql<Date>`now()` })
      .where('id', '=', existing.id)
      .execute();
  else
    await scope.db
      .insertInto('identity.role_memberships')
      .values({ user_id: userId, role, status: 'active', joined_at: sql<Date>`now()` })
      .execute();
  await writeAudit(scope, { action: 'user.platform_role_granted', entityType: 'user', entityId: userId, reason, next: role });
  scope.afterCommit(() => authorizer.invalidateUser(userId));
}

@Injectable()
@Operation('admin.platform_role_grant')
export class AdminPlatformRoleGrantHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<{ role: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const u = await loadUser(scope, ctx.params.user_id!);
      if (u.status !== 'active') throw new ApiError('INVALID_TRANSITION', { detail: `account ${u.status}` });
      const held = await scope.db
        .selectFrom('identity.role_memberships')
        .select('id')
        .where('user_id', '=', u.id)
        .where('role', '=', b.role)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (held) throw new ApiError('DUPLICATE', { detail: 'role already held' });
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.platform_role_grant',
          targetType: 'user',
          targetId: u.id,
          payload: { user_id: u.id, role: b.role },
          summary: `Grant ${b.role} to user ${u.id}`,
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

@Injectable()
@Operation('admin.platform_role_revoke')
export class AdminPlatformRoleRevokeHandler implements OperationHandler {
  constructor(private readonly authorizer: Authorizer) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const reason = headerReasonOf(ctx);
    const role = ctx.params.role!;
    if (!PLATFORM_ROLES.includes(role)) throw new ApiError('NOT_FOUND');
    await ctx.tx(async (scope) => {
      const m = await scope.db
        .selectFrom('identity.role_memberships')
        .select(['id'])
        .where('user_id', '=', ctx.params.user_id!)
        .where('role', '=', role)
        .where('organization_id', 'is', null)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!m) throw new ApiError('NOT_FOUND');
      // The platform keeps at least one administrator.
      if (role === 'platform_admin') {
        const { rows } = await sql<{ n: string }>`
          SELECT count(*) AS n FROM identity.role_memberships
           WHERE role = 'platform_admin' AND status = 'active' AND organization_id IS NULL AND deleted_at IS NULL`.execute(scope.db);
        if (Number(rows[0]!.n) <= 1) throw new ApiError('INVALID_TRANSITION', { detail: 'last_admin' });
      }
      await scope.db.updateTable('identity.role_memberships').set({ status: 'removed' }).where('id', '=', m.id).execute();
      await writeAudit(scope, {
        action: 'user.platform_role_revoked',
        entityType: 'user',
        entityId: ctx.params.user_id!,
        reason,
        previous: role,
      });
      scope.afterCommit(() => this.authorizer.invalidateUser(ctx.params.user_id!));
    });
    return { body: { ok: true } };
  }
}

@Injectable()
@Operation('admin.onboarding_reset')
export class AdminOnboardingResetHandler implements OperationHandler {
  constructor(private readonly cards: UserCards) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const row = await scope.db
        .selectFrom('identity.onboarding_progress')
        .selectAll()
        .where('user_id', '=', ctx.params.user_id!)
        .where('flow_type', '=', ctx.params.flow_type!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      const updated = await scope.db
        .updateTable('identity.onboarding_progress')
        .set({ status: 'reset', reset_by: s.userId, current_step: 'start', completed_steps: [], completed_at: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'onboarding.reset',
        entityType: 'onboarding_progress',
        entityId: row.id,
        reason: ctx.body.reason,
        previous: `${row.status} at ${row.current_step}`,
        next: 'reset',
      });
      const assisted = updated.assisted_by_user_id
        ? (await this.cards.cards(scope, [updated.assisted_by_user_id])).get(updated.assisted_by_user_id)
        : undefined;
      return toOnboarding(updated, assisted?.displayName ?? null);
    });
    return { body };
  }
}

// ------------------------------------------------------------------ DSR

type DsrRow = Awaited<ReturnType<typeof loadDsr>>;

async function loadDsr(scope: TxScope, id: string, lock = false) {
  const q = scope.db.selectFrom('identity.data_subject_requests').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

const staffDsr = async (scope: TxScope, views: DsrViews, d: DsrRow) => ({
  ...toDataSubjectRequest(d, await views.available(scope, d)),
  user_id: d.user_id,
});

@Injectable()
@Operation('admin.dsr_queue')
export class AdminDsrQueueHandler implements OperationHandler {
  constructor(private readonly views: DsrViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; request_type?: string; due_before?: string; limit: number }>) {
    staffOf(ctx);
    const q = ctx.query;
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db.selectFrom('identity.data_subject_requests').selectAll().where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status);
        if (q.request_type) s = s.where('request_type', '=', q.request_type);
        if (q.due_before) s = s.where('due_at', '<', new Date(`${q.due_before}T00:00:00Z`));
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const items = [];
        for (const d of page) items.push(await staffDsr(scope, this.views, d));
        return ctx.page(items, rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.dsr_update')
export class AdminDsrUpdateHandler implements OperationHandler {
  constructor(private readonly views: DsrViews) {}

  async handle(ctx: OperationContext<{ status: string; rejection_reason?: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (b.status === 'rejected' && !b.rejection_reason)
      throw ApiError.validation([{ pointer: '/rejection_reason', code: 'conditional_required' }]);
    if (b.status !== 'rejected' && b.rejection_reason)
      throw ApiError.validation([{ pointer: '/rejection_reason', code: 'conditional_forbidden' }]);
    const body = await ctx.tx(async (scope) => {
      const d = await loadDsr(scope, ctx.params.request_id!, true);
      if (!(DSR_NEXT[d.status] ?? []).includes(b.status)) throw new ApiError('INVALID_TRANSITION', { detail: `${d.status} → ${b.status}` });
      // A deletion completes only through its execution; an export needs its bundle first.
      if (b.status === 'completed' && d.request_type === 'deletion')
        throw new ApiError('INVALID_TRANSITION', { detail: 'use execute-deletion' });
      if (b.status === 'completed' && d.request_type === 'export' && !d.export_media_asset_id)
        throw new ApiError('INVALID_TRANSITION', { detail: 'export_missing' });
      const row = await scope.db
        .updateTable('identity.data_subject_requests')
        .set({
          status: b.status,
          handled_by: s.userId,
          rejection_reason: b.rejection_reason ?? null,
          completed_at: b.status === 'completed' ? sql<Date>`now()` : null,
        })
        .where('id', '=', d.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'dsr.status_changed',
        entityType: 'data_subject_request',
        entityId: d.id,
        reason: b.reason,
        previous: d.status,
        next: b.status,
        accessPurpose: s.purpose,
      });
      return toDataSubjectRequest(row, await this.views.available(scope, row));
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.dsr_export')
export class AdminDsrExportHandler implements OperationHandler {
  constructor(private readonly jobs: JobService) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const job = await ctx.tx(async (scope) => {
      const d = await loadDsr(scope, ctx.params.request_id!);
      // Identity verified first (status in_progress); an export or a deletion request may need the bundle.
      if (d.status !== 'in_progress' || !['export', 'deletion'].includes(d.request_type))
        throw new ApiError('INVALID_TRANSITION', { detail: `${d.request_type} ${d.status}` });
      const row = await this.jobs.create(scope, {
        kind: 'data_export',
        ownerUserId: s.userId,
        owningModule: 'identity',
        inputSummary: { data_subject_request_id: d.id },
        queue: DSR_EXPORT_QUEUE,
      });
      await writeAudit(scope, {
        action: 'dsr.export_started',
        entityType: 'data_subject_request',
        entityId: d.id,
        reason: ctx.body.reason,
        next: `job ${row.id}`,
        accessPurpose: s.purpose,
      });
      return row;
    });
    return acceptedJob(job);
  }
}

@Injectable()
@Operation('admin.dsr_execute_deletion')
export class AdminDsrExecuteDeletionHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const d = await loadDsr(scope, ctx.params.request_id!);
      if (d.request_type !== 'deletion' || d.status !== 'in_progress')
        throw new ApiError('INVALID_TRANSITION', { detail: `${d.request_type} ${d.status}` });
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.dsr_execute_deletion',
          targetType: 'data_subject_request',
          targetId: d.id,
          payload: { request_id: d.id, user_id: d.user_id },
          summary: `Delete the account and personal data of user ${d.user_id} (DSR ${d.id})`,
          reason: ctx.body.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Four-eyes executor of admin.dsr_execute_deletion: the worker erases (user.deletion.requested). */
export async function startDeletion(scope: TxScope, requestId: string, approvedBy: string): Promise<void> {
  const d = await loadDsr(scope, requestId, true);
  if (d.request_type !== 'deletion' || d.status !== 'in_progress') throw new ApiError('INVALID_TRANSITION', { detail: d.status });
  await scope.db.updateTable('identity.data_subject_requests').set({ handled_by: approvedBy }).where('id', '=', d.id).execute();
  await publishEvent(scope, {
    type: 'user.deletion.requested',
    aggregateType: 'data_subject_request',
    aggregateId: d.id,
    payload: { user_id: d.user_id },
  });
}
