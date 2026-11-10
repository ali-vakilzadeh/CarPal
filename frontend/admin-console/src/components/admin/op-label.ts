// Names of admin operations for people (AC5.T4): a pending change carries its op_id (e.g. admin.retention_update);
// the console shows "Data retention change". Operations without a name, and op ids the console does not know,
// read "Unknown (<value>)" instead of failing (PWA P13 rule).
import { ADMIN_OPERATIONS } from '@/lib/api/generated';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

/** The four-eyes operations of contract 1.3.0 (4EYES in their sec: line), which pending changes name. */
export const FOUR_EYES_OPS = [
  'admin.platform_role_grant',
  'admin.org_merge',
  'admin.plan_update',
  'admin.taxonomy_merge',
  'admin.review_move_to_approval_path',
  'admin.flag_update',
  'admin.exchange_rate_update',
  'admin.retention_update',
  'admin.dsr_execute_deletion',
  'admin.mcp_client_update',
] as const;

const NAMED: ReadonlySet<string> = new Set(FOUR_EYES_OPS);

export function opLabel(opId: string, t: Translate): string {
  if (NAMED.has(opId) && opId in ADMIN_OPERATIONS) return t(`admin.ops.${opId.slice('admin.'.length)}` as MessageKey);
  return t('admin.kit.unknown', { value: opId });
}
