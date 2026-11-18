// Names of admin operations for people (AC5.T4): a pending change carries its op_id (e.g. admin.retention_update);
// the console shows "Data retention change". Operations without a name, and op ids the console does not know,
// read "Unknown (<value>)" instead of failing (PWA P13 rule).
import { ADMIN_OPERATIONS } from '@/lib/api/generated';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

/**
 * The operations a pending change can name: 4EYES in their sec: line (contract 1.5.0), and admin.dispute_resolve,
 * whose removal outcomes wait for an administrator's fairness approval (backend S25a, 202 PendingChange).
 */
export const FOUR_EYES_OPS = [
  'admin.staff_enable',
  'admin.platform_role_grant',
  'admin.org_merge',
  'admin.plan_update',
  'admin.taxonomy_merge',
  'admin.review_move_to_approval_path',
  'admin.flag_update',
  'admin.exchange_rate_update',
  'admin.retention_update',
  'admin.retention_create',
  'admin.policy_version_publish',
  'admin.dsr_execute_deletion',
  'admin.mcp_client_update',
  'admin.dispute_resolve',
] as const;

const NAMED: ReadonlySet<string> = new Set(FOUR_EYES_OPS);

export function opLabel(opId: string, t: Translate): string {
  if (NAMED.has(opId) && opId in ADMIN_OPERATIONS) return t(`admin.ops.${opId.slice('admin.'.length)}` as MessageKey);
  return t('admin.kit.unknown', { value: opId });
}
