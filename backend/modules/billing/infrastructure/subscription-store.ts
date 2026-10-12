// Billing data access (billing.* tables only): plans with their
// entitlements, the current (trial or active) subscription of a subscriber,
// and effective entitlement values (plan value → subscription override, the
// same rule as billing.effective_entitlement()).
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { PlanKey, Subscriber } from '../interface/billing.js';

export type PlanRow = Selectable<DB['billing.plans']>;
export type SubscriptionRow = Selectable<DB['billing.subscriptions']>;
export type EntitlementValue = boolean | number | null;

export interface PlanWithEntitlements {
  plan: PlanRow;
  /** Plan values by key; integer null = unlimited. */
  entitlements: Map<string, { type: 'boolean' | 'integer'; value: EntitlementValue }>;
}

/** Display order of plans (40 Plan.plan_key enum order). */
export const PLAN_ORDER: PlanKey[] = [
  'individual_free',
  'fleet_20',
  'fleet_50',
  'fleet_100',
  'fleet_custom',
  'provider_basic',
  'provider_pro',
  'vendor_basic',
  'vendor_pro',
];

function parseValue(type: string, raw: string | null): EntitlementValue {
  if (type === 'boolean') return raw === 'true';
  return raw === null ? null : Number(raw);
}

export async function loadPlans(scope: TxScope, filter: { audience?: string; ids?: string[] } = {}): Promise<PlanWithEntitlements[]> {
  let q = scope.db.selectFrom('billing.plans').selectAll().where('status', '=', 'active').where('deleted_at', 'is', null);
  if (filter.audience) q = q.where('audience', '=', filter.audience);
  if (filter.ids) q = q.where('id', 'in', filter.ids.length ? filter.ids : ['00000000-0000-7000-8000-000000000000']);
  const plans = await q.execute();
  if (plans.length === 0) return [];
  const rows = await scope.db
    .selectFrom('billing.entitlements')
    .select(['plan_id', 'entitlement_key', 'value_type', 'value'])
    .where(
      'plan_id',
      'in',
      plans.map((p) => p.id),
    )
    .where('deleted_at', 'is', null)
    .execute();
  return plans
    .sort((a, b) => PLAN_ORDER.indexOf(a.plan_key as PlanKey) - PLAN_ORDER.indexOf(b.plan_key as PlanKey))
    .map((plan) => ({
      plan,
      entitlements: new Map(
        rows
          .filter((r) => r.plan_id === plan.id)
          .map((r) => [r.entitlement_key, { type: r.value_type as 'boolean' | 'integer', value: parseValue(r.value_type, r.value) }]),
      ),
    }));
}

/** Current (trial or active) subscription of a subscriber, visible under the caller's RLS context. */
export async function currentSubscription(scope: TxScope, s: Subscriber): Promise<SubscriptionRow | undefined> {
  return scope.db
    .selectFrom('billing.subscriptions')
    .selectAll()
    .where('subscriber_type', '=', s.type)
    .where('subscriber_id', '=', s.id)
    .where('status', 'in', ['trial', 'active'])
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/** Individual Free for a user without a subscription (billing.ensure_user_subscription: system or the user themself). */
export async function ensureUserSubscription(scope: TxScope, userId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`SELECT billing.ensure_user_subscription(${userId}::uuid) AS id`.execute(scope.db);
  return rows[0]!.id;
}

/** Plan entitlements with the subscription's overrides applied (billing.effective_entitlement rule). */
export function effectiveEntitlements(sub: SubscriptionRow, plan: PlanWithEntitlements): Map<string, EntitlementValue> {
  const overrides = (sub.entitlement_overrides as Record<string, unknown> | null) ?? {};
  const out = new Map<string, EntitlementValue>();
  for (const [key, e] of plan.entitlements) {
    let value: EntitlementValue = e.value;
    if (key === 'max_vehicles' && sub.vehicle_limit_override !== null) value = sub.vehicle_limit_override;
    else if (key === 'max_fleet_users' && sub.user_limit_override !== null) value = sub.user_limit_override;
    else if (Object.hasOwn(overrides, key)) {
      const o = overrides[key];
      value = e.type === 'boolean' ? o === true || o === 'true' : o === null ? null : Number(o);
    }
    out.set(key, value);
  }
  return out;
}

/** Serializes entitlement checks per subscriber until the transaction ends (40 SEC-AZ-9). */
export async function lockSubscriber(scope: TxScope, s: Subscriber): Promise<void> {
  await sql`SELECT billing.lock_subscriber(${s.type}, ${s.id}::uuid)`.execute(scope.db);
}
