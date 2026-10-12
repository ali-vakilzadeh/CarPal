// Public interface of the billing module (41 §4.2 interface/). Entitlement
// checks go through the platform port (libs/entitlements EntitlementChecker,
// implemented here). Other modules read a subscription summary through
// SubscriptionReader and register the counters billing needs for limits and
// usage (vehicles: S5 vehicle module; inventory items: S5 inventory module;
// fleet users: identity).
import type { TxScope } from '#libs/tenancy/index.js';

export type PlanKey =
  | 'individual_free'
  | 'fleet_20'
  | 'fleet_50'
  | 'fleet_100'
  | 'fleet_custom'
  | 'provider_basic'
  | 'provider_pro'
  | 'vendor_basic'
  | 'vendor_pro';

/** 40 §10.1 SubscriptionSummary (Me.subscription). */
export interface SubscriptionSummary {
  plan_key: PlanKey;
  status: 'trial' | 'active' | 'expired' | 'cancelled';
  max_vehicles: number | null;
  active_vehicles: number;
  trial_ends_at: string | null;
}

export abstract class SubscriptionReader {
  /** The user's personal subscription summary (Individual Free is created when missing), in the caller's transaction. */
  abstract summaryForUser(scope: TxScope, userId: string): Promise<SubscriptionSummary>;
}

export interface Subscriber {
  type: 'user' | 'organization';
  id: string;
}

/** Organization types of 52 Organization (mirrors core.org_type). */
export type OrgSubscriberType = 'provider' | 'vendor' | 'fleet' | 'hybrid_provider_vendor';

/**
 * Writes subscriptions on behalf of other modules. org.create gives a new
 * organization the default plan of its audience in its own transaction (RLS
 * policy default_plan_insert: organization context, default plan, active).
 */
export abstract class SubscriptionWriter {
  /** Returns the plan key that was assigned. */
  abstract createDefaultForOrganization(scope: TxScope, orgId: string, orgType: OrgSubscriberType): Promise<PlanKey>;
}

/** Counts current usage of a counter entitlement, inside the caller's transaction (after the subscriber lock). */
export type UsageCounter = (scope: TxScope, subscriber: Subscriber) => Promise<number>;

/** Counter entitlements and their usage field in 40 Subscription.usage. */
export const COUNTER_KEYS = {
  max_vehicles: 'active_vehicles',
  max_fleet_users: 'users',
  max_inventory_items: 'active_inventory_items',
} as const;
export type CounterKey = keyof typeof COUNTER_KEYS;

/** Registry of usage counters; the owning modules register theirs at startup (onModuleInit). */
export class UsageCounters {
  readonly #counters = new Map<CounterKey, UsageCounter>();

  register(key: CounterKey, counter: UsageCounter): void {
    if (this.#counters.has(key)) throw new Error(`usage counter ${key} registered twice`);
    this.#counters.set(key, counter);
  }

  get(key: string): UsageCounter | undefined {
    return this.#counters.get(key as CounterKey);
  }
}
