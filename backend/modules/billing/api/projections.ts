// Response projections of the billing module (40 §10.1), built by allowlist.
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { PlanKey, SubscriptionSummary } from '../interface/billing.js';
import type { EntitlementValue, PlanWithEntitlements, SubscriptionRow } from '../infrastructure/subscription-store.js';

const entitlementList = (m: Map<string, EntitlementValue>) =>
  [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));

/** 40 Plan. */
export function toPlan(p: PlanWithEntitlements) {
  return {
    id: p.plan.id,
    plan_key: p.plan.plan_key as PlanKey,
    audience: p.plan.audience,
    name_i18n_key: p.plan.name_i18n_key,
    max_vehicles: p.plan.max_vehicles,
    max_users: p.plan.max_users,
    trial_days: p.plan.trial_days,
    entitlements: entitlementList(new Map([...p.entitlements].map(([k, e]) => [k, e.value]))),
  };
}

export type Usage = { active_vehicles?: number; users?: number; active_inventory_items?: number };

/** 40 Subscription (status past_due_future is reserved and never stored, 52 §6). */
export function toSubscription(sub: SubscriptionRow, plan: PlanWithEntitlements, effective: Map<string, EntitlementValue>, usage: Usage) {
  return {
    ...meta(sub),
    plan: toPlan(plan),
    status: sub.status as 'trial' | 'active' | 'expired' | 'cancelled',
    billing_mode: 'manual' as const,
    started_at: iso(sub.started_at),
    trial_ends_at: isoOrNull(sub.trial_ends_at),
    expires_at: isoOrNull(sub.expires_at),
    effective_entitlements: entitlementList(effective),
    usage,
  };
}

export function toSummary(
  sub: SubscriptionRow,
  plan: PlanWithEntitlements,
  effective: Map<string, EntitlementValue>,
  activeVehicles: number,
): SubscriptionSummary {
  const max = effective.get('max_vehicles');
  return {
    plan_key: plan.plan.plan_key as PlanKey,
    status: sub.status as SubscriptionSummary['status'],
    max_vehicles: typeof max === 'number' ? max : null,
    active_vehicles: activeVehicles,
    trial_ends_at: isoOrNull(sub.trial_ends_at),
  };
}
