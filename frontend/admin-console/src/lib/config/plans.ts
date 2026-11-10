// The plan keys of the contract (Docs/40 §10.1 Plan['plan_key']) and their names, shared by Plans & entitlements and
// the feature flag targeting (AC6). An unknown key from the server reads "Unknown (<value>)" (PWA P13 rule).
import type { Plan } from '@carpal/api-contracts';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export type PlanKey = Plan['plan_key'];

export const PLAN_KEYS: readonly PlanKey[] = [
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

export function planLabel(plan: string, t: Translate): string {
  return (PLAN_KEYS as readonly string[]).includes(plan)
    ? t(`admin.plans.names.${plan}` as MessageKey)
    : t('admin.kit.unknown', { value: plan });
}
