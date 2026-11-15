// Billing on the admin plane (40 §23.2: subscription_assign, plans_list,
// plan_update; 52 Subscription, SubscriptionChangeRequest; MVP manual
// billing). Staff assign a plan (trial or active, with limit and entitlement
// overrides): the current subscription is cancelled and replaced in one
// transaction, an open change request of the organization is closed as
// assigned, and the change is audited. Plan entitlement changes affect every
// subscriber and wait for a second admin (4EYES). A daily W15 rule moves
// trials past trial_ends_at to the audience's default plan.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { FourEyes, StaffNames, staffOf, type WorkQueues } from '#modules/admin/interface/admin.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { overrideList, toPlan, toStaffPlan, toSubscription } from '../api/projections.js';
import type { PlanKey } from '../interface/billing.js';
import { currentSubscription, effectiveEntitlements, loadPlans, type PlanWithEntitlements } from '../infrastructure/subscription-store.js';
import { SubscriptionService } from './subscriptions.js';

/** Plan audiences per subscriber (individual ↔ user; organizations by type, a hybrid may take either side). */
const ORG_AUDIENCES: Record<OrgType, string[]> = {
  provider: ['provider'],
  vendor: ['vendor'],
  fleet: ['fleet'],
  hybrid_provider_vendor: ['provider', 'vendor'],
};

type EntitlementValue = { key: string; value: boolean | number | null };
type Assign = {
  subscriber: { type: 'user' | 'organization'; id: string };
  plan_key: PlanKey;
  status: 'trial' | 'active';
  trial_ends_at?: string;
  expires_at?: string;
  vehicle_limit_override?: number;
  user_limit_override?: number;
  entitlement_overrides?: EntitlementValue[];
  reason: string;
};

/** Entitlement values must match the plan's types (boolean or integer, integer null = unlimited). */
function entitlementErrors(plan: PlanWithEntitlements, list: EntitlementValue[] | undefined, pointer: string): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const [i, e] of (list ?? []).entries()) {
    const def = plan.entitlements.get(e.key);
    if (!def || seen.has(e.key)) errors.push({ pointer: `${pointer}/${i}/key`, code: def ? 'not_unique' : 'enum' });
    else if (def.type === 'boolean' ? typeof e.value !== 'boolean' : typeof e.value === 'boolean')
      errors.push({ pointer: `${pointer}/${i}/value`, code: 'type' });
    seen.add(e.key);
  }
  return errors;
}

@Injectable()
@Operation('admin.subscription_assign')
export class AdminSubscriptionAssignHandler implements OperationHandler {
  constructor(
    private readonly service: SubscriptionService,
    private readonly users: UserCards,
    private readonly orgs: OrgCards,
  ) {}

  async handle(ctx: OperationContext<Assign>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    if (b.status === 'trial' && !b.trial_ends_at) errors.push({ pointer: '/trial_ends_at', code: 'conditional_required' });
    if (b.status === 'active' && b.trial_ends_at) errors.push({ pointer: '/trial_ends_at', code: 'conditional_forbidden' });
    for (const k of ['trial_ends_at', 'expires_at'] as const)
      if (b[k] && Date.parse(b[k]!) <= Date.now()) errors.push({ pointer: `/${k}`, code: 'out_of_range' });
    if (errors.length) throw ApiError.validation(errors);
    const body = await ctx.tx(async (scope) => {
      const audiences = await this.audiences(scope, b.subscriber);
      const [plan] = (await loadPlans(scope)).filter((p) => p.plan.plan_key === b.plan_key);
      if (!plan || !audiences.includes(plan.plan.audience)) throw ApiError.validation([{ pointer: '/plan_key', code: 'enum' }]);
      const entErrors = entitlementErrors(plan, b.entitlement_overrides, '/entitlement_overrides');
      if (entErrors.length) throw ApiError.validation(entErrors);
      const current = await currentSubscription(scope, b.subscriber);
      if (current) await scope.db.updateTable('billing.subscriptions').set({ status: 'cancelled' }).where('id', '=', current.id).execute();
      const row = await scope.db
        .insertInto('billing.subscriptions')
        .values({
          subscriber_type: b.subscriber.type,
          subscriber_id: b.subscriber.id,
          plan_id: plan.plan.id,
          status: b.status,
          trial_ends_at: b.trial_ends_at ? new Date(b.trial_ends_at) : null,
          expires_at: b.expires_at ? new Date(b.expires_at) : null,
          vehicle_limit_override: b.vehicle_limit_override ?? null,
          user_limit_override: b.user_limit_override ?? null,
          entitlement_overrides: b.entitlement_overrides?.length
            ? JSON.stringify(Object.fromEntries(b.entitlement_overrides.map((e) => [e.key, e.value])))
            : null,
          assigned_by: s.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.subscriber.type === 'organization')
        await scope.db
          .updateTable('billing.subscription_change_requests')
          .set({ status: 'assigned', handled_by: s.userId, handled_at: sql<Date>`now()`, resulting_subscription_id: row.id })
          .where('organization_id', '=', b.subscriber.id)
          .where('status', '=', 'open')
          .execute();
      await writeAudit(scope, {
        action: 'subscription.assigned',
        entityType: 'subscription',
        entityId: row.id,
        reason: b.reason,
        previous: current ? `${current.id} ${current.status}` : 'none',
        next: `${b.plan_key} ${b.status} for ${b.subscriber.type} ${b.subscriber.id}`,
      });
      return toSubscription(row, plan, effectiveEntitlements(row, plan), await this.service.usage(scope, b.subscriber));
    });
    return { body };
  }

  private async audiences(scope: TxScope, sub: Assign['subscriber']): Promise<string[]> {
    if (sub.type === 'user') {
      const u = (await this.users.cards(scope, [sub.id])).get(sub.id);
      if (!u || u.status === 'deleted')
        throw ApiError.validation([{ pointer: '/subscriber/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      return ['individual'];
    }
    const o = (await this.orgs.cards(scope, [sub.id])).get(sub.id);
    if (!o || ['merged', 'archived'].includes(o.status))
      throw ApiError.validation([{ pointer: '/subscriber/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    return ORG_AUDIENCES[o.organizationType];
  }
}

@Injectable()
@Operation('admin.plans_list')
export class AdminPlansListHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const plans = await ctx.tx((scope) => loadPlans(scope, { includeInactive: true }), { readOnly: true });
    // Backend S21 (BR-23): StaffPlan says which plans are offered and which one is the audience default.
    return { body: ctx.page(plans.map(toStaffPlan), null) };
  }
}

const afterIdOf = (ctx: OperationContext): string | undefined => (ctx.cursor as { id?: string } | undefined)?.id;

type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled';
type SubscriptionsQuery = {
  plan_key?: PlanKey;
  status?: SubscriptionStatus;
  subscriber_type?: 'user' | 'organization';
  trial_ends_before?: string;
  subscriber_id?: string;
  limit: number;
};

/**
 * 40 admin.subscriptions_list (backend S21, BR-24): A-PLAN-01 Assignments, newest first. Subscribers are shown by
 * their public name (an organization's name, a user's display name); trial_ends_before finds trials ending soon.
 */
@Injectable()
@Operation('admin.subscriptions_list')
export class AdminSubscriptionsListHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<undefined, SubscriptionsQuery>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterIdOf(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let r = scope.db
          .selectFrom('billing.subscriptions as s')
          .innerJoin('billing.plans as p', 'p.id', 's.plan_id')
          .selectAll('s')
          .select('p.plan_key')
          .where('s.deleted_at', 'is', null);
        if (q.plan_key) r = r.where('p.plan_key', '=', q.plan_key);
        if (q.status) r = r.where('s.status', '=', q.status);
        if (q.subscriber_type) r = r.where('s.subscriber_type', '=', q.subscriber_type);
        if (q.subscriber_id) r = r.where('s.subscriber_id', '=', q.subscriber_id);
        if (q.trial_ends_before) r = r.where('s.status', '=', 'trial').where('s.trial_ends_at', '<', new Date(q.trial_ends_before));
        if (after) r = r.where('s.id', '<', after);
        const rows = await r
          .orderBy('s.id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const [cards, names] = await Promise.all([
          this.orgs.cards(
            scope,
            page.filter((x) => x.subscriber_type === 'organization').map((x) => x.subscriber_id),
          ),
          this.names.names(
            scope,
            [...page.filter((x) => x.subscriber_type === 'user').map((x) => x.subscriber_id), ...page.map((x) => x.assigned_by)],
            ctx.locale,
          ),
        ]);
        const items = page.map((x) => ({
          id: x.id,
          subscriber: {
            type: x.subscriber_type as 'user' | 'organization',
            id: x.subscriber_id,
            // A gone organization keeps its row; the console shows the id.
            display: (x.subscriber_type === 'organization' ? cards.get(x.subscriber_id)?.name : names.get(x.subscriber_id)) ?? '—',
          },
          plan_key: x.plan_key as PlanKey,
          status: x.status as SubscriptionStatus,
          started_at: x.started_at.toISOString(),
          trial_ends_at: x.trial_ends_at ? x.trial_ends_at.toISOString() : null,
          expires_at: x.expires_at ? x.expires_at.toISOString() : null,
          overrides: {
            vehicle_limit: x.vehicle_limit_override,
            user_limit: x.user_limit_override,
            entitlements: overrideList(x.entitlement_overrides),
          },
          assigned_by_display: x.assigned_by ? names.get(x.assigned_by)! : null,
        }));
        return ctx.page(items, rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

type RequestStatus = 'open' | 'assigned' | 'declined' | 'withdrawn';
type ChangeRequestsQuery = { status: RequestStatus; organization_id?: string; limit: number };

/**
 * 40 admin.subscription_change_requests_list (backend S21, BR-24; public Web UI PU-BR-04 list part): the plan requests
 * of organizations (subscription.change_request) as a work queue, oldest first. admin.subscription_assign closes the
 * organization's open request as assigned.
 */
@Injectable()
@Operation('admin.subscription_change_requests_list')
export class AdminSubscriptionChangeRequestsListHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<undefined, ChangeRequestsQuery>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterIdOf(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let r = scope.db
          .selectFrom('billing.subscription_change_requests as c')
          .innerJoin('billing.plans as p', 'p.id', 'c.requested_plan_id')
          .leftJoin('billing.subscriptions as cs', 'cs.id', 'c.current_subscription_id')
          .leftJoin('billing.plans as cp', 'cp.id', 'cs.plan_id')
          .selectAll('c')
          .select(['p.plan_key as requested_plan_key', 'cp.plan_key as current_plan_key'])
          .where('c.deleted_at', 'is', null)
          .where('c.status', '=', q.status);
        if (q.organization_id) r = r.where('c.organization_id', '=', q.organization_id);
        if (after) r = r.where('c.id', '>', after);
        const rows = await r
          .orderBy('c.id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const [cards, names] = await Promise.all([
          this.orgs.cards(
            scope,
            page.map((x) => x.organization_id),
          ),
          this.names.names(scope, [...page.map((x) => x.requested_by_user_id), ...page.map((x) => x.handled_by)], ctx.locale),
        ]);
        const items = [];
        for (const x of page) {
          const card = cards.get(x.organization_id);
          if (!card) continue; // the organization is gone
          items.push({
            id: x.id,
            organization: toOrgSummary(card),
            requested_plan_key: x.requested_plan_key as PlanKey,
            current_plan_key: (x.current_plan_key as PlanKey | null) ?? null,
            note: x.note,
            requested_by_display: names.get(x.requested_by_user_id)!,
            status: x.status as RequestStatus,
            created_at: x.created_at.toISOString(),
            handled_by_display: x.handled_by ? names.get(x.handled_by)! : null,
            handled_at: x.handled_at ? x.handled_at.toISOString() : null,
          });
        }
        return ctx.page(items, rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** The open plan requests as a work queue for administrators (admin.work_summary, backend S21; no target). */
export function registerBillingWork(queues: WorkQueues): void {
  queues.register('subscription_change_requests', {
    roles: ['platform_admin'],
    assignable: false,
    timed: false,
    async items(scope, _staff, limit) {
      const q = scope.db.selectFrom('billing.subscription_change_requests').where('deleted_at', 'is', null).where('status', '=', 'open');
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q.select('created_at').orderBy('created_at').limit(limit).execute(),
      ]);
      return { open: Number(n?.n ?? 0), items: rows.map((r) => ({ startedAt: r.created_at, target: null })) };
    },
  });
}

type PlanUpdate = { entitlements: EntitlementValue[]; status?: 'active' | 'inactive'; reason: string };

@Injectable()
@Operation('admin.plan_update')
export class AdminPlanUpdateHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<PlanUpdate>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const [plan] = await loadPlans(scope, { ids: [ctx.params.plan_id!], includeInactive: true });
      if (!plan) throw new ApiError('NOT_FOUND');
      const errors = entitlementErrors(plan, b.entitlements, '/entitlements');
      if (errors.length) throw ApiError.validation(errors);
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.plan_update',
          targetType: 'plan',
          targetId: plan.plan.id,
          payload: { plan_id: plan.plan.id, entitlements: b.entitlements, ...(b.status ? { status: b.status } : {}) },
          summary:
            `Plan ${plan.plan.plan_key}: ${b.entitlements.map((e) => `${e.key}=${e.value === null ? 'unlimited' : e.value}`).join(', ')}${b.status ? `; status ${b.status}` : ''}`.slice(
              0,
              1000,
            ),
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Four-eyes executor of admin.plan_update. */
export async function applyPlanUpdate(
  scope: TxScope,
  planId: string,
  p: { entitlements: EntitlementValue[]; status?: string },
  reason: string,
): Promise<void> {
  const [plan] = await loadPlans(scope, { ids: [planId], includeInactive: true });
  if (!plan) throw new ApiError('NOT_FOUND', { detail: 'plan gone' });
  const before = toPlan(plan);
  for (const e of p.entitlements)
    await scope.db
      .updateTable('billing.entitlements')
      .set({ value: e.value === null ? null : String(e.value) })
      .where('plan_id', '=', planId)
      .where('entitlement_key', '=', e.key)
      .where('deleted_at', 'is', null)
      .execute();
  if (p.status) await scope.db.updateTable('billing.plans').set({ status: p.status }).where('id', '=', planId).execute();
  await writeAudit(scope, {
    action: 'plan.updated',
    entityType: 'plan',
    entityId: planId,
    reason,
    previous: JSON.stringify(before.entitlements).slice(0, 2000),
    next: JSON.stringify({ entitlements: p.entitlements, status: p.status }).slice(0, 2000),
  });
}

/** W15 daily (41 §6.3): trials past trial_ends_at end and the subscriber returns to its audience's default plan. */
@Injectable()
export class TrialExpiryRule extends ScheduledRule {
  readonly name = 'billing.trial_expiry';
  readonly everyMs = 24 * 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async run(): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const due = await scope.db
        .selectFrom('billing.subscriptions as s')
        .innerJoin('billing.plans as p', 'p.id', 's.plan_id')
        .select(['s.id', 's.subscriber_type', 's.subscriber_id', 'p.audience'])
        .where('s.status', '=', 'trial')
        .where('s.trial_ends_at', '<=', new Date())
        .where('s.deleted_at', 'is', null)
        .forUpdate()
        .limit(500)
        .execute();
      for (const t of due) {
        await scope.db.updateTable('billing.subscriptions').set({ status: 'expired' }).where('id', '=', t.id).execute();
        const audience = t.subscriber_type === 'user' ? 'individual' : t.audience;
        const plan = await scope.db
          .selectFrom('billing.plans')
          .select('id')
          .where('audience', '=', audience)
          .where('is_default_for_audience', '=', true)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!plan) {
          this.logger.warn({ subscription: t.id, audience }, 'trial expiry: no default plan');
          continue;
        }
        const row = await scope.db
          .insertInto('billing.subscriptions')
          .values({ subscriber_type: t.subscriber_type, subscriber_id: t.subscriber_id, plan_id: plan.id, status: 'active' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeAudit(scope, {
          action: 'subscription.trial_ended',
          entityType: 'subscription',
          entityId: t.id,
          previous: 'trial',
          next: `expired; default plan subscription ${row.id}`,
        });
      }
      return due.length;
    });
  }
}
