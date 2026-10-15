// Subscriptions and entitlements (52 §6, 40 §10, SEC-AZ-9). The entitlement
// check runs inside the caller's write transaction: it takes the subscriber's
// advisory lock (billing.lock_subscriber) first, then reads the effective
// value and the current usage, so two parallel requests at a limit are
// serialized and only one passes.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { EntitlementChecker, type CheckOptions, type EntitlementDecision, type EntitlementKey } from '#libs/entitlements/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { toSubscription, toSummary, type Usage } from '../api/projections.js';
import {
  COUNTER_KEYS,
  SubscriptionReader,
  SubscriptionWriter,
  UsageCounters,
  type CounterKey,
  type OrgSubscriberType,
  type PlanKey,
  type Subscriber,
  type SubscriptionSummary,
} from '../interface/billing.js';
import {
  currentSubscription,
  effectiveEntitlements,
  ensureUserSubscription,
  loadPlans,
  lockSubscriber,
  type EntitlementValue,
  type PlanWithEntitlements,
  type SubscriptionRow,
} from '../infrastructure/subscription-store.js';

export interface SubscriptionView {
  sub: SubscriptionRow;
  plan: PlanWithEntitlements;
  effective: Map<string, EntitlementValue>;
}

@Injectable()
export class SubscriptionService extends SubscriptionReader {
  constructor(readonly counters: UsageCounters) {
    super();
  }

  /** Current subscription with its plan and effective entitlements; a user without one gets Individual Free. */
  async view(scope: TxScope, s: Subscriber): Promise<SubscriptionView | null> {
    if (s.type === 'user') await ensureUserSubscription(scope, s.id);
    const sub = await currentSubscription(scope, s);
    if (!sub) return null;
    const [plan] = await loadPlans(scope, { ids: [sub.plan_id] });
    if (!plan) throw new ApiError('INTERNAL', { detail: `subscription ${sub.id}: plan ${sub.plan_id} not active` });
    return { sub, plan, effective: effectiveEntitlements(sub, plan) };
  }

  /** 40 Subscription.usage: every counter registered by its owning module. */
  async usage(scope: TxScope, s: Subscriber): Promise<Usage> {
    const usage: Usage = {};
    for (const [key, field] of Object.entries(COUNTER_KEYS) as [CounterKey, keyof Usage][]) {
      const counter = this.counters.get(key);
      if (counter) usage[field] = await counter(scope, s);
    }
    return usage;
  }

  async staffSubscription(scope: TxScope, subscriber: Subscriber): Promise<unknown> {
    const sub =
      (await currentSubscription(scope, subscriber)) ??
      (await scope.db
        .selectFrom('billing.subscriptions')
        .selectAll()
        .where('subscriber_type', '=', subscriber.type)
        .where('subscriber_id', '=', subscriber.id)
        .where('deleted_at', 'is', null)
        .orderBy('id', 'desc')
        .executeTakeFirst());
    if (!sub) return null;
    const [plan] = await loadPlans(scope, { ids: [sub.plan_id], includeInactive: true });
    if (!plan) return null;
    return toSubscription(sub, plan, effectiveEntitlements(sub, plan), await this.usage(scope, subscriber));
  }

  async staffSummaryForUser(scope: TxScope, userId: string): Promise<SubscriptionSummary> {
    const s: Subscriber = { type: 'user', id: userId };
    const vehicles = this.counters.get('max_vehicles');
    const active = vehicles ? await vehicles(scope, s) : 0;
    const sub = await currentSubscription(scope, s);
    if (sub) {
      const [plan] = await loadPlans(scope, { ids: [sub.plan_id] });
      if (plan) return toSummary(sub, plan, effectiveEntitlements(sub, plan), active);
    }
    const [plan] = (await loadPlans(scope, { audience: 'individual' })).filter((p) => p.plan.is_default_for_audience);
    if (!plan) throw new ApiError('INTERNAL', { detail: 'no default individual plan' });
    const max = plan.entitlements.get('max_vehicles')?.value;
    return {
      plan_key: plan.plan.plan_key as PlanKey,
      status: 'active',
      max_vehicles: typeof max === 'number' ? max : null,
      active_vehicles: active,
      trial_ends_at: null,
    };
  }

  async summaryForUser(scope: TxScope, userId: string): Promise<SubscriptionSummary> {
    const s: Subscriber = { type: 'user', id: userId };
    const v = await this.view(scope, s);
    if (!v) throw new ApiError('INTERNAL', { detail: 'no individual subscription after ensure' });
    const vehicles = this.counters.get('max_vehicles');
    return toSummary(v.sub, v.plan, v.effective, vehicles ? await vehicles(scope, s) : 0);
  }
}

@Injectable()
export class BillingEntitlementChecker extends EntitlementChecker {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly counters: UsageCounters,
  ) {
    super();
  }

  async check(
    scope: TxScope,
    subscriber: Subscriber,
    key: EntitlementKey,
    delta: number,
    options: CheckOptions = {},
  ): Promise<EntitlementDecision> {
    await lockSubscriber(scope, subscriber);
    const v = await this.subscriptions.view(scope, subscriber);
    // No current subscription (expired, or an organization without one): nothing is granted.
    if (!v) return { allowed: false, limit: null };
    const entitlement = v.plan.entitlements.get(key);
    if (!entitlement) return { allowed: false, limit: null };
    const value = v.effective.get(key) ?? null;
    if (entitlement.type === 'boolean') return { allowed: value === true, limit: null };
    const limit = typeof value === 'number' ? value : null;
    if (delta <= 0) return { allowed: limit === null || limit > 0, limit };
    if (limit === null) return { allowed: true, limit };
    const counter = options.usage ?? ((s: TxScope) => this.counters.get(key)?.(s, subscriber) ?? Promise.reject(noCounter(key)));
    const used = await counter(scope);
    return { allowed: used + delta <= limit, limit };
  }
}

const noCounter = (key: string): ApiError => new ApiError('INTERNAL', { detail: `no usage counter registered for ${key}` });

/**
 * Plan audience of an organization type. A hybrid provider/vendor starts on
 * the provider audience (S4 decision, DI-20): its public face is the provider
 * profile; staff can move it with admin.subscription_assign.
 */
const ORG_AUDIENCE: Record<OrgSubscriberType, 'provider' | 'vendor' | 'fleet'> = {
  provider: 'provider',
  vendor: 'vendor',
  fleet: 'fleet',
  hybrid_provider_vendor: 'provider',
};

@Injectable()
export class DbSubscriptionWriter extends SubscriptionWriter {
  async createDefaultForOrganization(scope: TxScope, orgId: string, orgType: OrgSubscriberType): Promise<PlanKey> {
    const plan = await scope.db
      .selectFrom('billing.plans')
      .select(['id', 'plan_key'])
      .where('audience', '=', ORG_AUDIENCE[orgType])
      .where('is_default_for_audience', '=', true)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!plan) throw new ApiError('INTERNAL', { detail: `no default plan for audience ${ORG_AUDIENCE[orgType]}` });
    // Policy default_plan_insert: the organization context of the new organization, its default plan, status active.
    await scope.db
      .insertInto('billing.subscriptions')
      .values({ subscriber_type: 'organization', subscriber_id: orgId, plan_id: plan.id, status: 'active' })
      .execute();
    return plan.plan_key as PlanKey;
  }
}
