// Insights, suggestions and approvals (40 §21.4) and the provider's skill
// heatmap (§21.3 ai.skill_heatmap). An insight, suggestion or approval
// request belongs to an organization or to one user: the facade looks up the
// owner through the gateway's store, authorizes the caller for that
// organization (USR | ORG(ANY), ORG(by target), ORG(by approver_role)) and
// then reads and writes under the caller's RLS context. Internal insights
// never leave the admin plane. Accepting a suggestion applies it through the
// owning module's registered applier, as if the user had typed it; an
// approval is never decided by its requester (SELF_APPROVAL_FORBIDDEN, and
// the approval_requests_no_self_approval constraint).
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toApproval, toInsight, toSuggestion, type ApprovalRow, type SuggestionRow } from '../api/projections.js';
import { suggestionPayloadErrors } from '../domain/payloads.js';
import { AiStore } from '../infrastructure/ai-store.js';
import { SuggestionAppliers, type AiPrincipal } from '../interface/ai.js';
import { requireAiConsent } from './features.js';

const caller = (ctx: OperationContext): string => {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return ctx.principal.userId;
};

type Position = { id?: string } | undefined;
const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

/** Who owns an AI record: an organization, or one user. */
interface Owner {
  organizationId: string | null;
  ownerUserId: string | null;
}

/**
 * Fleet AI records are requested by FC/F+ and concern the whole fleet or any
 * of its vehicles, so fleet drivers never see them (SEC-AZ-7; a driver's
 * Help Me triage is personal). WP0 narrowing of ORG(ANY).
 */
const fleetDriver = (org: { type: string; role: string }): boolean => org.type === 'fleet' && org.role === 'fleet_driver';

/**
 * Authorizes the caller for an AI record's owner and switches the RLS context
 * to its organization: members of the organization (groups), or the owner
 * user of a personal record. Anything else is 404 (SEC-AZ-2).
 */
async function enterOwner(ctx: OperationContext, scope: TxScope, o: Owner | undefined, groups: string[]): Promise<{ role: string | null }> {
  const userId = caller(ctx);
  if (!o) throw new ApiError('NOT_FOUND');
  if (o.organizationId) {
    const org = await ctx.authorizeOrg(o.organizationId, groups);
    if (fleetDriver(org)) throw new ApiError('NOT_FOUND');
    await scope.setOrganization(org.id, org.role);
    return { role: org.role };
  }
  if (o.ownerUserId !== userId) throw new ApiError('NOT_FOUND');
  return { role: null };
}

@Injectable()
export class AiOwners {
  constructor(private readonly store: AiStore) {}

  insight(id: string, requestId: string): Promise<Owner | undefined> {
    return this.store.run(
      ({ db }) =>
        db
          .selectFrom('ai_mcp.ai_insights')
          .select(['organization_id as organizationId', 'owner_user_id as ownerUserId'])
          .where('id', '=', id)
          .where('visibility', '<>', 'internal')
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      requestId,
    );
  }

  suggestion(id: string, requestId: string): Promise<(Owner & { targetType: string }) | undefined> {
    return this.store.run(
      ({ db }) =>
        db
          .selectFrom('ai_mcp.ai_suggestions')
          .select(['organization_id as organizationId', 'owner_user_id as ownerUserId', 'target_entity_type as targetType'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      requestId,
    );
  }

  approval(id: string, requestId: string): Promise<(Owner & { approverRole: string }) | undefined> {
    return this.store.run(
      ({ db }) =>
        db
          .selectFrom('ai_mcp.approval_requests')
          .select(['organization_id as organizationId', 'owner_user_id as ownerUserId', 'approver_role as approverRole'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      requestId,
    );
  }
}

@Injectable()
@Operation('ai.insight_get')
export class AiInsightGetHandler implements OperationHandler {
  constructor(private readonly owners: AiOwners) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const id = ctx.params.insight_id!;
    const owner = await this.owners.insight(id, ctx.requestId);
    const body = await ctx.tx(async (scope) => {
      await enterOwner(ctx, scope, owner, ['ANY']);
      const i = await scope.db
        .selectFrom('ai_mcp.ai_insights')
        .selectAll()
        .where('id', '=', id)
        .where('visibility', '<>', 'internal')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!i) throw new ApiError('NOT_FOUND');
      return toInsight(i);
    });
    return { body };
  }
}

type Feedback = { feedback_type: string; rating?: number; comment?: string };

@Injectable()
@Operation('ai.insight_feedback')
export class AiInsightFeedbackHandler implements OperationHandler {
  constructor(private readonly owners: AiOwners) {}

  async handle(ctx: OperationContext<Feedback>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    if (b.feedback_type === 'rating' && b.rating === undefined) errors.push({ pointer: '/rating', code: 'conditional_required' });
    if (b.feedback_type !== 'rating' && b.rating !== undefined) errors.push({ pointer: '/rating', code: 'conditional_forbidden' });
    if (errors.length) throw ApiError.validation(errors);
    const id = ctx.params.insight_id!;
    const owner = await this.owners.insight(id, ctx.requestId);
    await ctx.tx(async (scope) => {
      await enterOwner(ctx, scope, owner, ['ANY']);
      await scope.db
        .insertInto('ai_mcp.ai_evaluation_records')
        .values({
          insight_id: id,
          feedback_type: b.feedback_type,
          rating: b.rating ?? null,
          comment: b.comment ?? null,
          actor_user_id: userId,
        })
        .execute();
    });
    return created(ACK, `/v1/insights/${id}`);
  }
}

@Injectable()
@Operation('ai.suggestions_list')
export class AiSuggestionsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; target_type?: string; limit: number }>): Promise<OperationResult> {
    const org = ctx.access.org;
    if (!org || fleetDriver(org)) throw new ApiError('NOT_FOUND');
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('ai_mcp.ai_suggestions')
          .selectAll()
          .where('organization_id', '=', org.id)
          .where('status', '=', q.status ?? 'pending')
          .where('deleted_at', 'is', null);
        if (q.target_type) s = s.where('target_entity_type', '=', q.target_type);
        const after = afterId(ctx);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, q.limit);
      },
      { readOnly: true },
    );
    return { body };
  }
}

function pageOf(ctx: OperationContext, rows: SuggestionRow[], limit: number) {
  const page = rows.slice(0, limit);
  return ctx.page(page.map(toSuggestion), rows.length > limit ? { id: page.at(-1)!.id } : null);
}

@Injectable()
@Operation('ai.suggestions_mine')
export class AiSuggestionsMineHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const userId = caller(ctx);
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('ai_mcp.ai_suggestions')
          .selectAll()
          .where('owner_user_id', '=', userId)
          .where('organization_id', 'is', null)
          .where('status', '=', q.status ?? 'pending')
          .where('deleted_at', 'is', null);
        const after = afterId(ctx);
        if (after) s = s.where('id', '>', after);
        return pageOf(
          ctx,
          await s
            .orderBy('id')
            .limit(q.limit + 1)
            .execute(),
          q.limit,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** ORG(by target): the roles that may decide a suggestion on each target type of an organization. */
const TARGET_GROUPS: Record<string, string[]> = {
  vehicle: ['FC'],
  maintenance_reminder: ['FC'],
  inventory_item: ['V*'],
  organization: ['P+', 'V+'],
};

type Decision = { decision: 'accept' | 'accept_with_edits' | 'reject'; edited_payload?: Record<string, unknown> };

@Injectable()
@Operation('ai.suggestion_decide')
export class AiSuggestionDecideHandler implements OperationHandler {
  constructor(
    private readonly owners: AiOwners,
    private readonly appliers: SuggestionAppliers,
  ) {}

  async handle(ctx: OperationContext<Decision>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    if (b.decision === 'accept_with_edits' && !b.edited_payload)
      throw ApiError.validation([{ pointer: '/edited_payload', code: 'conditional_required' }]);
    if (b.decision !== 'accept_with_edits' && b.edited_payload)
      throw ApiError.validation([{ pointer: '/edited_payload', code: 'conditional_forbidden' }]);
    const id = ctx.params.suggestion_id!;
    const owner = await this.owners.suggestion(id, ctx.requestId);
    const body = await ctx.tx(async (scope) => {
      await enterOwner(ctx, scope, owner, TARGET_GROUPS[owner?.targetType ?? ''] ?? ['M+']);
      const s = await scope.db
        .selectFrom('ai_mcp.ai_suggestions')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!s) throw new ApiError('NOT_FOUND');
      if (s.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
      const insight = await scope.db
        .selectFrom('ai_mcp.ai_insights')
        .select(['id', 'expires_at', 'human_approval_status'])
        .where('id', '=', s.insight_id)
        .executeTakeFirst();
      if (insight?.expires_at && new Date(insight.expires_at).getTime() < Date.now()) {
        await scope.db.updateTable('ai_mcp.ai_suggestions').set({ status: 'expired' }).where('id', '=', s.id).execute();
        throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
      }
      if (b.decision !== 'reject') {
        // A staff member's draft waits for its approval request (53 §14.2).
        const waiting = await scope.db
          .selectFrom('ai_mcp.approval_requests')
          .select('status')
          .where('insight_id', '=', s.insight_id)
          .where('status', 'in', ['pending', 'rejected'])
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (waiting)
          throw new ApiError('INVALID_TRANSITION', { detail: waiting.status === 'pending' ? 'approval_pending' : 'approval_rejected' });
        const payload =
          b.decision === 'accept_with_edits' ? b.edited_payload! : ((s.proposed_payload as Record<string, unknown> | null) ?? null);
        const errors = suggestionPayloadErrors(
          s.target_entity_type,
          payload,
          b.decision === 'accept_with_edits' ? '/edited_payload' : '/decision',
        );
        if (errors.length) throw ApiError.validation(errors as FieldError[]);
        const applier = this.appliers.get(s.target_entity_type);
        if (applier)
          await applier(scope, {
            id: s.id,
            insightId: s.insight_id,
            targetType: s.target_entity_type,
            targetId: s.target_entity_id,
            action: s.suggested_action as 'add',
            payload,
            organizationId: s.organization_id,
            ownerUserId: s.owner_user_id,
            actorUserId: userId,
          });
        else if (s.suggested_action !== 'review') throw ApiError.validation([{ pointer: '/decision', code: 'enum' }]);
      }
      const status = b.decision === 'accept' ? 'accepted' : b.decision === 'accept_with_edits' ? 'accepted_with_edits' : 'rejected';
      const row = await scope.db
        .updateTable('ai_mcp.ai_suggestions')
        .set({
          status,
          decided_by: userId,
          decided_at: new Date(),
          edited_payload: b.edited_payload ? JSON.stringify(b.edited_payload) : null,
        })
        .where('id', '=', s.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await scope.db
        .insertInto('ai_mcp.ai_evaluation_records')
        .values({ insight_id: s.insight_id, feedback_type: status, actor_user_id: userId })
        .execute();
      await writeAudit(scope, {
        action: 'ai.suggestion_decided',
        entityType: 'ai_suggestion',
        entityId: s.id,
        previous: 'pending',
        next: `${status} ${s.target_entity_type}`,
      });
      return toSuggestion(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('ai.approvals_list')
export class AiApprovalsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const org = ctx.access.org;
    if (!org) throw new ApiError('NOT_FOUND');
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('ai_mcp.approval_requests')
          .selectAll()
          .where('organization_id', '=', org.id)
          .where('status', '=', q.status ?? 'pending')
          .where('deleted_at', 'is', null);
        const after = afterId(ctx);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        return ctx.page(page.map(toApproval), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** Role rank within one organization type (an owner may decide what a manager may decide). */
const RANK: Record<string, number> = {
  provider_owner: 3,
  provider_manager: 2,
  provider_staff: 1,
  vendor_owner: 2,
  vendor_staff: 1,
  fleet_owner: 3,
  fleet_manager: 2,
  fleet_maintenance_coordinator: 1,
  fleet_driver: 0,
  fleet_viewer: 0,
};
const family = (role: string) => role.split('_')[0];

/** ORG(by approver_role): the caller's role is the approver role or above it in the same organization type. */
export function mayApprove(role: string | null, approverRole: string): boolean {
  if (!role) return false;
  if (role === approverRole) return true;
  return family(role) === family(approverRole) && (RANK[role] ?? -1) > (RANK[approverRole] ?? 99);
}

@Injectable()
@Operation('ai.approval_decide')
export class AiApprovalDecideHandler implements OperationHandler {
  constructor(private readonly owners: AiOwners) {}

  async handle(ctx: OperationContext<{ decision: 'approved' | 'rejected'; decision_reason?: string }>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const id = ctx.params.approval_id!;
    const owner = await this.owners.approval(id, ctx.requestId);
    const body = await ctx.tx(async (scope) => {
      const { role } = await enterOwner(ctx, scope, owner, ['ANY']);
      if (owner!.organizationId && !mayApprove(role, owner!.approverRole)) throw new ApiError('NOT_FOUND');
      const a = (await scope.db
        .selectFrom('ai_mcp.approval_requests')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as ApprovalRow | undefined;
      if (!a) throw new ApiError('NOT_FOUND');
      if (a.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: `approval is ${a.status}` });
      if (a.requested_by_user_id === userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN');
      const row = await scope.db
        .updateTable('ai_mcp.approval_requests')
        .set({ status: b.decision, decided_by: userId, decided_at: new Date(), decision_reason: b.decision_reason ?? null })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (a.insight_id) {
        await scope.db
          .updateTable('ai_mcp.ai_insights')
          .set({ human_approval_status: b.decision })
          .where('id', '=', a.insight_id)
          .where('human_approval_status', 'in', ['pending', 'not_required'])
          .execute();
        // A rejected draft cannot be applied any more.
        if (b.decision === 'rejected')
          await scope.db
            .updateTable('ai_mcp.ai_suggestions')
            .set({ status: 'rejected', decided_by: userId, decided_at: new Date() })
            .where('insight_id', '=', a.insight_id)
            .where('status', '=', 'pending')
            .execute();
      }
      await writeAudit(scope, {
        action: 'ai.approval_decided',
        entityType: 'approval_request',
        entityId: a.id,
        reason: b.decision_reason ?? null,
        previous: 'pending',
        next: `${b.decision} ${a.action_type}`,
      });
      return toApproval(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('ai.skill_heatmap')
export class AiSkillHeatmapHandler implements OperationHandler {
  constructor(
    private readonly consents: ConsentChecker,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async handle(ctx: OperationContext<undefined, { scope_type?: string }>): Promise<OperationResult> {
    const org = ctx.access.org;
    if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
    const who: AiPrincipal = { userId: ctx.principal.userId, orgId: org.id, role: org.role };
    const body = await ctx.tx(
      async (scope) => {
        await requireAiConsent(this.consents, scope, who, 'provider_analytics_ai_use');
        let q = scope.db
          .selectFrom('ai_mcp.skill_heatmap_entries')
          .selectAll()
          .where('provider_organization_id', '=', org.id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        if (ctx.query.scope_type) q = q.where('scope_type', '=', ctx.query.scope_type);
        const rows = await q.orderBy('score', 'desc').orderBy('id').limit(500).execute();
        const labels = await this.taxonomy.labels(
          rows.map((r) => r.taxonomy_node_id),
          ctx.locale,
        );
        const entries = rows
          .filter((r) => labels.has(r.taxonomy_node_id))
          .map((r) => ({
            scope_type: r.scope_type,
            node: { id: r.taxonomy_node_id, label: labels.get(r.taxonomy_node_id)! },
            score: Number(r.score).toFixed(2),
            confidence: r.confidence,
            classification: r.classification,
            trend: r.trend,
            rating_trend: r.rating_trend === null ? null : Number(r.rating_trend).toFixed(2),
            repeat_customer_count: r.repeat_customer_count,
            local_demand_score: r.local_demand_score === null ? null : Number(r.local_demand_score).toFixed(2),
            evidence_summary: r.evidence_summary,
            insight_id: r.insight_id,
            generated_at: new Date(r.generated_at).toISOString(),
          }));
        const latest = rows.reduce<Date | null>((m, r) => (!m || new Date(r.generated_at) > m ? new Date(r.generated_at) : m), null);
        return { entries, generated_at: latest ? latest.toISOString() : null };
      },
      { readOnly: true },
    );
    return { body };
  }
}
