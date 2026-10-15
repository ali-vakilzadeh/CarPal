// Reports and moderation (40 §22 reports.create, §23.4; 52 ContentReport,
// ModerationCase, ModerationAction; MVP Module M). Users report content,
// profiles, listings, wrong locations, accounts and AI output; staff triage
// reports into cases and take actions on the case target. Content actions
// (approve, hide, remove, restore, request changes) are applied by the module
// that owns the record (ModerationTargets); account and badge actions go
// through the identity and trust interfaces. Every action is appended to the
// moderation log with an audit entry and publishes moderation.action.taken
// (W2 reindexes, W3 recomputes trust, W5 tells the owner).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { MembershipDirectory } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AccountAdmin } from '#modules/identity/interface/identity.js';
import { TrustAdmin } from '#modules/trust/interface/trust.js';
import { toAction, toCase, toReport, type CaseRow, type ReportRow } from '../api/projections.js';
import {
  auditStaffRead,
  FourEyes,
  ModerationLog,
  ModerationTargets,
  StaffNames,
  staffOf,
  type ContentAction,
  type ModerationTargetHandler,
} from '../interface/admin.js';
import { afterId, exactlyOne, failIf, notFoundAt, pageOf } from './common.js';

const OPEN_CASE = ['open', 'investigating', 'escalated'];
const CONTENT_ACTIONS: ContentAction[] = ['approve', 'hide', 'remove', 'restore', 'request_changes'];
/** Actions recorded by their own operations (verification, review approval, location, assisted onboarding). */
const DEDICATED: Record<string, string> = {
  verify_organization: 'admin.verification_decide',
  reject_verification: 'admin.verification_decide',
  confirm_review_approval: 'admin.review_approval_decide',
  reject_review_approval: 'admin.review_approval_decide',
  request_evidence: 'admin.review_approval_decide',
  correct_location: 'admin.location_correct',
  assist_onboarding: 'admin.assist_session_start',
};
const PENALTY_TTL_MS = 365 * 86_400_000;

type ReportCreate = { target_type: string; target_id: string; reason: string; details?: string };

@Injectable()
@Operation('reports.create')
export class ReportsCreateHandler implements OperationHandler {
  constructor(private readonly targets: ModerationTargets) {}

  async handle(ctx: OperationContext<ReportCreate>): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const b = ctx.body;
    const handler = this.targets.get(b.target_type);
    const body = await ctx.tx(async (scope) => {
      // A user reports what they can see (public content, their own records; accounts and organizations by their cards).
      if (!handler || !(await handler.exists(scope, b.target_id))) throw notFoundAt('/target_id');
      const row = await scope.db
        .insertInto('admin.content_reports')
        .values({
          reporter_user_id: userId,
          target_type: b.target_type,
          target_id: b.target_id,
          reason: b.reason,
          details: b.details ?? null,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      if (b.target_type === 'review')
        await publishEvent(scope, {
          type: 'review.reported',
          aggregateType: 'review',
          aggregateId: b.target_id,
          payload: { report_id: row.id, reason: b.reason },
        });
      return { report_id: row.id, status: 'open' as const };
    });
    return created(body, `/v1/reports/${body.report_id}`);
  }
}

async function reportViews(scope: TxScope, names: StaffNames, rows: ReportRow[], locale: string) {
  const n = await names.names(
    scope,
    rows.map((r) => r.reporter_user_id),
    locale,
  );
  return rows.map((r) => toReport(r, n.get(r.reporter_user_id)!));
}

@Injectable()
@Operation('admin.reports_list')
export class ReportsListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, { status?: string; target_type?: string; reason?: string; limit: number }>) {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db.selectFrom('admin.content_reports').selectAll().where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status);
        if (q.target_type) s = s.where('target_type', '=', q.target_type);
        if (q.reason) s = s.where('reason', '=', q.reason);
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await reportViews(scope, this.names, rows.slice(0, q.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

type Triage = { moderation_case_id?: string; open_case?: { severity: string }; dismiss?: boolean; reason: string };

@Injectable()
@Operation('admin.report_triage')
export class ReportTriageHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<Triage>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    exactlyOne(b, ['moderation_case_id', 'open_case', 'dismiss']);
    const body = await ctx.tx(async (scope) => {
      const r = await scope.db
        .selectFrom('admin.content_reports')
        .selectAll()
        .where('id', '=', ctx.params.report_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw new ApiError('NOT_FOUND');
      if (r.status !== 'open') throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      let caseId: string | null = null;
      if (b.moderation_case_id) {
        const c = await scope.db
          .selectFrom('admin.moderation_cases')
          .select(['id', 'status'])
          .where('id', '=', b.moderation_case_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!c) throw notFoundAt('/moderation_case_id');
        if (!OPEN_CASE.includes(c.status)) throw new ApiError('INVALID_TRANSITION', { detail: `case ${c.status}` });
        caseId = c.id;
      } else if (b.open_case) {
        const c = await scope.db
          .insertInto('admin.moderation_cases')
          .values({
            case_type: r.target_type,
            target_entity_type: r.target_type,
            target_entity_id: r.target_id,
            source: 'user_report',
            reason: r.reason,
            severity: b.open_case.severity,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        caseId = c.id;
      }
      // One case gathers every open report about the same target (the queue shows each target once).
      const ids = caseId
        ? (
            await scope.db
              .selectFrom('admin.content_reports')
              .select('id')
              .where('target_type', '=', r.target_type)
              .where('target_id', '=', r.target_id)
              .where('status', '=', 'open')
              .where('deleted_at', 'is', null)
              .execute()
          ).map((x) => x.id)
        : [r.id];
      await scope.db
        .updateTable('admin.content_reports')
        .set(caseId ? { status: 'triaged', moderation_case_id: caseId } : { status: 'dismissed' })
        .where('id', 'in', ids)
        .execute();
      await writeAudit(scope, {
        action: 'moderation.report_triaged',
        entityType: 'content_report',
        entityId: r.id,
        reason: b.reason,
        previous: 'open',
        next: caseId ? `triaged into case ${caseId}` : 'dismissed',
      });
      const row = await scope.db.selectFrom('admin.content_reports').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
      return (await reportViews(scope, this.names, [row], ctx.locale))[0]!;
    });
    return { body };
  }
}

/** Case views with assignee names and report counts. */
@Injectable()
export class CaseViews {
  constructor(private readonly names: StaffNames) {}

  async many(scope: TxScope, rows: CaseRow[], locale: string) {
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await scope.db
          .selectFrom('admin.content_reports')
          .select(['moderation_case_id', (eb) => eb.fn.countAll<string>().as('n')])
          .where('moderation_case_id', 'in', ids)
          .groupBy('moderation_case_id')
          .execute()
      : [];
    const n = new Map(counts.map((c) => [c.moderation_case_id!, Number(c.n)]));
    const names = await this.names.names(
      scope,
      rows.map((r) => r.assigned_to),
      locale,
    );
    return rows.map((r) => toCase(r, { assignee: r.assigned_to ? names.get(r.assigned_to)! : null, reportCount: n.get(r.id) ?? 0 }));
  }

  async one(scope: TxScope, row: CaseRow, locale: string) {
    return (await this.many(scope, [row], locale))[0]!;
  }
}

async function loadCase(scope: TxScope, id: string, lock = false): Promise<CaseRow> {
  const q = scope.db.selectFrom('admin.moderation_cases').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('admin.cases_list')
export class CasesListHandler implements OperationHandler {
  constructor(private readonly views: CaseViews) {}

  async handle(
    ctx: OperationContext<undefined, { status?: string; severity?: string; case_type?: string; assigned_to_me?: boolean; limit: number }>,
  ): Promise<OperationResult> {
    const s = staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let c = scope.db.selectFrom('admin.moderation_cases').selectAll().where('deleted_at', 'is', null);
        if (q.status) c = c.where('status', '=', q.status);
        if (q.severity) c = c.where('severity', '=', q.severity);
        if (q.case_type) c = c.where('case_type', '=', q.case_type);
        if (q.assigned_to_me !== undefined)
          c = q.assigned_to_me ? c.where('assigned_to', '=', s.userId) : c.where('assigned_to', 'is', null);
        if (after) c = c.where('id', '<', after);
        const rows = await c
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, q.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.case_get')
export class CaseGetHandler implements OperationHandler {
  constructor(
    private readonly views: CaseViews,
    private readonly targets: ModerationTargets,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const c = await loadCase(scope, ctx.params.case_id!);
      const actions = await scope.db
        .selectFrom('admin.moderation_actions')
        .selectAll()
        .where('moderation_case_id', '=', c.id)
        .orderBy('created_at')
        .limit(200)
        .execute();
      const names = await this.names.names(
        scope,
        actions.map((a) => a.actor_user_id),
        ctx.locale,
      );
      const snapshot = (await this.targets.get(c.target_entity_type)?.snapshot(scope, c.target_entity_id)) ?? null;
      await auditStaffRead(scope, s, 'moderation_case', c.id, `case target ${c.target_entity_type}`);
      return {
        case: await this.views.one(scope, c, ctx.locale),
        actions: actions.map((a) => toAction(a, names.get(a.actor_user_id)!)),
        target_snapshot: snapshot ?? { type: c.target_entity_type, id: c.target_entity_id, available: false },
      };
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.case_assign')
export class CaseAssignHandler implements OperationHandler {
  constructor(
    private readonly views: CaseViews,
    private readonly directory: MembershipDirectory,
  ) {}

  async handle(ctx: OperationContext<{ assignee_user_id?: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const assignee = ctx.body.assignee_user_id ?? s.userId;
    if (assignee !== s.userId) {
      const roles = await this.directory.platformRoles(assignee);
      if (!roles.some((r) => r === 'platform_moderator' || r === 'platform_admin')) throw notFoundAt('/assignee_user_id');
    }
    const body = await ctx.tx(async (scope) => {
      const c = await loadCase(scope, ctx.params.case_id!, true);
      if (!OPEN_CASE.includes(c.status)) throw new ApiError('INVALID_TRANSITION', { detail: c.status });
      const row = await scope.db
        .updateTable('admin.moderation_cases')
        .set({ assigned_to: assignee, status: c.status === 'open' ? 'investigating' : c.status })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'moderation.case_assigned',
        entityType: 'moderation_case',
        entityId: c.id,
        reason: ctx.body.reason,
        previous: c.assigned_to ?? 'unassigned',
        next: assignee,
      });
      return this.views.one(scope, row, ctx.locale);
    });
    return { body };
  }
}

type ActionInput = {
  action_type: string;
  target?: { type: string; id: string };
  reason: string;
  params?: { trust_penalty_points?: number; badge_id?: string; suspend_until?: string; merge_into_id?: string };
};

@Injectable()
@Operation('admin.case_action')
export class CaseActionHandler implements OperationHandler {
  constructor(
    private readonly targets: ModerationTargets,
    private readonly log: ModerationLog,
    private readonly accounts: AccountAdmin,
    private readonly trust: TrustAdmin,
    private readonly fourEyes: FourEyes,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<ActionInput>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    // AAL3(suspend_account, apply_trust_penalty, merge_duplicate): step-up for the heavy actions.
    if (ctx.access.conditionalAssurance?.when.includes(b.action_type)) ctx.requireAssurance('aal3');
    if (DEDICATED[b.action_type])
      throw new ApiError('INVALID_TRANSITION', { detail: `${b.action_type} is recorded by ${DEDICATED[b.action_type]}` });
    const body = await ctx.tx(async (scope) => {
      const c = await loadCase(scope, ctx.params.case_id!, true);
      if (!OPEN_CASE.includes(c.status)) throw new ApiError('INVALID_TRANSITION', { detail: `case ${c.status}` });
      const target = b.target ?? { type: c.target_entity_type, id: c.target_entity_id };
      const handler = this.targets.get(target.type);
      if (!handler || !(await handler.exists(scope, target.id))) throw notFoundAt('/target/id');
      const subjectOrg = target.type === 'organization' ? target.id : ((await handler.subjectOrganization?.(scope, target.id)) ?? null);
      const author = target.type === 'user' ? target.id : ((await handler.author?.(scope, target.id)) ?? null);
      // Separation of duties: staff never act on their own account or content.
      if (author === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own account or content' });
      const params: Record<string, unknown> = { ...(b.params ?? {}), ...(subjectOrg ? { subject_organization_id: subjectOrg } : {}) };
      await this.apply(scope, ctx, s.userId, b, target, handler, { subjectOrg, author, params, fake: c.reason === 'fake' });
      const id = await this.log.record(scope, {
        caseId: c.id,
        targetType: target.type,
        targetId: target.id,
        actionType: b.action_type,
        reason: b.reason,
        params,
        actorUserId: s.userId,
      });
      if (c.status === 'open')
        await scope.db.updateTable('admin.moderation_cases').set({ status: 'investigating' }).where('id', '=', c.id).execute();
      await writeAudit(scope, {
        action: 'moderation.action_taken',
        entityType: target.type,
        entityId: target.id,
        reason: b.reason,
        next: `${b.action_type} (case ${c.id})`,
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: 'moderation_action',
        aggregateId: id,
        payload: {
          case_id: c.id,
          action_type: b.action_type,
          target_type: target.type,
          target_id: target.id,
          organization_id: subjectOrg,
          user_id: author,
        },
      });
      const row = await scope.db.selectFrom('admin.moderation_actions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return toAction(row, await this.names.name(scope, s.userId, ctx.locale));
    });
    return created(body, `/v1/admin/moderation/cases/${ctx.params.case_id}/actions/${body.id}`);
  }

  private async apply(
    scope: TxScope,
    ctx: OperationContext<ActionInput>,
    staffId: string,
    b: ActionInput,
    target: { type: string; id: string },
    handler: ModerationTargetHandler,
    o: { subjectOrg: string | null; author: string | null; params: Record<string, unknown>; fake: boolean },
  ): Promise<void> {
    const a = b.action_type;
    if ((CONTENT_ACTIONS as string[]).includes(a)) {
      if (!handler.apply || !(await handler.apply(scope, target.id, a as ContentAction)))
        throw new ApiError('INVALID_TRANSITION', { detail: `${a} does not apply to this ${target.type}` });
      // A confirmed fake (case reason fake) removed from an organization's page carries the 54 §3.3 fake penalty.
      if (o.fake && (a === 'remove' || a === 'hide') && o.subjectOrg) o.params.fake = true;
      return;
    }
    switch (a) {
      case 'warn_user':
        if (!o.author) throw new ApiError('INVALID_TRANSITION', { detail: 'no user to warn' });
        o.params.user_id = o.author;
        return;
      case 'suspend_account':
      case 'reactivate_account': {
        if (!o.author) throw new ApiError('INVALID_TRANSITION', { detail: 'no account' });
        const until = b.params?.suspend_until;
        if (until && Date.parse(until) <= Date.now()) failIf([{ pointer: '/params/suspend_until', code: 'out_of_range' }]);
        await this.accounts.setStatus(scope, o.author, a === 'suspend_account' ? 'suspended' : 'active', {
          reason: b.reason,
          suspendUntil: until ?? null,
        });
        o.params.user_id = o.author;
        return;
      }
      case 'revoke_badge': {
        const badgeId = b.params?.badge_id ?? (target.type === 'badge' ? target.id : null);
        if (!badgeId) failIf([{ pointer: '/params/badge_id', code: 'conditional_required' }]);
        const r = await this.trust.revokeBadge(scope, badgeId!, b.reason);
        if (!r) throw notFoundAt('/params/badge_id');
        o.params.badge_id = badgeId;
        o.params.subject_organization_id = r.organizationId;
        return;
      }
      case 'apply_trust_penalty': {
        if (!b.params?.trust_penalty_points) failIf([{ pointer: '/params/trust_penalty_points', code: 'conditional_required' }]);
        if (!o.subjectOrg) throw new ApiError('INVALID_TRANSITION', { detail: 'no organization to penalize' });
        // 54 §3.3: penalties expire after 12 months unless the admin sets otherwise.
        o.params.expires_at = new Date(Date.now() + PENALTY_TTL_MS).toISOString();
        return;
      }
      case 'merge_duplicate': {
        const into = b.params?.merge_into_id;
        if (target.type !== 'organization') throw new ApiError('INVALID_TRANSITION', { detail: 'only organizations merge' });
        if (!into) failIf([{ pointer: '/params/merge_into_id', code: 'conditional_required' }]);
        // Merging needs a second approver (admin.org_merge, 4EYES): the action files the pending change.
        const pending = await this.fourEyes.request(
          scope,
          staffId,
          {
            opId: 'admin.org_merge',
            targetType: 'organization',
            targetId: target.id,
            payload: { org_id: target.id, into_organization_id: into, reason: b.reason },
            summary: `Merge organization ${target.id} into ${into} (moderation case)`,
            reason: b.reason,
            requiredRole: 'platform_admin',
          },
          ctx.locale,
        );
        o.params.pending_change_id = pending.change_id;
        return;
      }
      default:
        throw new ApiError('INVALID_TRANSITION', { detail: a });
    }
  }
}

@Injectable()
@Operation('admin.case_close')
export class CaseCloseHandler implements OperationHandler {
  constructor(private readonly views: CaseViews) {}

  async handle(ctx: OperationContext<{ status: 'action_taken' | 'dismissed' | 'escalated'; resolution: string; reason: string }>) {
    staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const c = await loadCase(scope, ctx.params.case_id!, true);
      if (!OPEN_CASE.includes(c.status) || c.status === b.status) throw new ApiError('INVALID_TRANSITION', { detail: c.status });
      const closing = b.status !== 'escalated';
      const row = await scope.db
        .updateTable('admin.moderation_cases')
        .set({ status: b.status, resolution: b.resolution, resolved_at: closing ? sql<Date>`now()` : null })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (closing)
        await scope.db
          .updateTable('admin.content_reports')
          .set({ status: b.status === 'action_taken' ? 'resolved' : 'dismissed' })
          .where('moderation_case_id', '=', c.id)
          .where('status', '=', 'triaged')
          .execute();
      await writeAudit(scope, {
        action: 'moderation.case_closed',
        entityType: 'moderation_case',
        entityId: c.id,
        reason: b.reason,
        previous: c.status,
        next: `${b.status}: ${b.resolution}`.slice(0, 2000),
      });
      return this.views.one(scope, row, ctx.locale);
    });
    return { body };
  }
}
