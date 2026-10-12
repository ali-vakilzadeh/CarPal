// L17 entitlements (41 §2.2; 40 §0.4 ENT, SEC-AZ-9): plan limits are checked by
// the billing module inside the write transaction, with a row lock on the
// subscriber (billing.lock_subscriber), so parallel requests cannot exceed a
// limit. Billing implements EntitlementChecker in S3; until then every check
// fails loudly (a forgotten binding must not grant anything).
import { ApiError, type ErrorCode } from '#libs/contract/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export type EntitlementKey =
  | 'max_vehicles'
  | 'max_inventory_items'
  | 'inventory_bulk_import_enabled'
  | 'appointment_capacity_tools_enabled'
  | 'fleet_approval_workflow_enabled'
  | 'fleet_reports_enabled'
  | 'export_enabled'
  | 'ai_tools_enabled'
  | 'advanced_analytics_enabled'
  | 'ai_fleet_suggestions_enabled'
  | 'max_fleet_users'
  | 'featured_placement_eligible'
  | (string & {});

export interface Subscriber {
  type: 'user' | 'organization';
  id: string;
}

export interface EntitlementDecision {
  allowed: boolean;
  /** Numeric limit for counters (null = unlimited or boolean entitlement). */
  limit: number | null;
}

export interface CheckOptions {
  /**
   * Current usage of a counter entitlement, read after the subscriber lock is
   * held (so parallel requests see each other's committed writes). Defaults to
   * the counter the owning module registered for the key.
   */
  usage?: (scope: TxScope) => Promise<number>;
}

export abstract class EntitlementChecker {
  /** Locks the subscriber and checks `key` for an increase of `delta` (0 for boolean entitlements). */
  abstract check(
    scope: TxScope,
    subscriber: Subscriber,
    key: EntitlementKey,
    delta: number,
    options?: CheckOptions,
  ): Promise<EntitlementDecision>;
}

export class UnconfiguredEntitlementChecker extends EntitlementChecker {
  async check(): Promise<EntitlementDecision> {
    throw new ApiError('INTERNAL', { detail: 'EntitlementChecker not bound (billing module arrives in S3)' });
  }
}

/** Counter limits report their own code (40 §4.4); other entitlements ENTITLEMENT_REQUIRED. */
const LIMIT_CODES: Partial<Record<string, ErrorCode>> = {
  max_vehicles: 'VEHICLE_LIMIT_REACHED',
  max_inventory_items: 'INVENTORY_LIMIT_REACHED',
};

/** ENT(key): call inside the write transaction, before the write. */
export async function requireEntitlement(
  checker: EntitlementChecker,
  scope: TxScope,
  subscriber: Subscriber,
  key: EntitlementKey,
  delta = 0,
  options: CheckOptions = {},
): Promise<EntitlementDecision> {
  const d = await checker.check(scope, subscriber, key, delta, options);
  if (!d.allowed) {
    const code = delta > 0 ? (LIMIT_CODES[key] ?? 'ENTITLEMENT_REQUIRED') : 'ENTITLEMENT_REQUIRED';
    throw new ApiError(code, {
      detail: `entitlement ${key}`,
      ...(code === 'ENTITLEMENT_REQUIRED' ? { extensions: { entitlement_key: key } } : {}),
    });
  }
  return d;
}
