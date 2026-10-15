// Allowlist projections of the admin module (40 §23.1): pending changes,
// reports, moderation cases and actions, feature flags and retention
// policies. Staff are shown by display name only; reporters' contact data
// never appears (MVP Module M).
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { PendingChangeView } from '../interface/admin.js';

export type PendingChangeRow = Selectable<DB['admin.pending_admin_changes']>;
export type CaseRow = Selectable<DB['admin.moderation_cases']>;
export type ReportRow = Selectable<DB['admin.content_reports']>;
export type ActionRow = Selectable<DB['admin.moderation_actions']>;
export type FlagRow = Selectable<DB['admin.feature_flags']>;
export type RetentionRow = Selectable<DB['admin.data_retention_policies']>;
export type AssistRow = Selectable<DB['admin.assist_sessions']>;

/** A pending change past its expiry is shown as expired before the hourly rule marks it (52 PendingAdminChange). */
export function pendingStatus(row: Pick<PendingChangeRow, 'status' | 'expires_at'>, now = Date.now()): PendingChangeView['status'] {
  if (row.status === 'pending' && new Date(row.expires_at).getTime() <= now) return 'expired';
  return row.status as PendingChangeView['status'];
}

export function toPendingChange(row: PendingChangeRow, requestedBy: string): PendingChangeView {
  return {
    change_id: row.id,
    op_id: row.op_id,
    summary: row.summary,
    requested_by_display: requestedBy,
    requested_at: iso(row.created_at),
    reason: row.reason,
    status: pendingStatus(row),
    expires_at: iso(row.expires_at),
  };
}

export function toCase(row: CaseRow, o: { assignee: string | null; reportCount: number }) {
  return {
    ...meta(row),
    case_type: row.case_type,
    target: { type: row.case_type, id: row.target_entity_id },
    source: row.source,
    reason: row.reason,
    severity: row.severity,
    ai_risk_score: row.ai_risk_score,
    ai_flag_insight_id: row.ai_flag_insight_id,
    status: row.status,
    assigned_to_display: o.assignee,
    resolution: row.resolution,
    resolved_at: isoOrNull(row.resolved_at),
    report_count: o.reportCount,
  };
}

export function toAction(row: ActionRow, actor: string) {
  return {
    id: row.id,
    moderation_case_id: row.moderation_case_id,
    action_type: row.action_type,
    target: { type: row.target_entity_type.slice(0, 40), id: row.target_entity_id },
    reason: row.reason,
    actor_display: actor,
    created_at: iso(row.created_at),
  };
}

export function toReport(row: ReportRow, reporter: string) {
  return {
    id: row.id,
    reporter_display: reporter,
    target: { type: row.target_type, id: row.target_id },
    reason: row.reason,
    details: row.details,
    status: row.status,
    moderation_case_id: row.moderation_case_id,
    created_at: iso(row.created_at),
  };
}

export function toFlag(row: FlagRow, updatedBy: string) {
  return {
    key: row.key,
    description: row.description,
    flag_type: row.flag_type,
    enabled: row.enabled,
    targeting: (row.targeting as Record<string, unknown> | null) ?? null,
    environment: row.environment,
    updated_by_display: updatedBy,
    updated_at: iso(row.updated_at),
    version: row.version,
  };
}

export function toRetention(row: RetentionRow) {
  return {
    id: row.id,
    entity_type: row.entity_type,
    applies_to_status: row.applies_to_status,
    retention_days: row.retention_days,
    action: row.action,
    legal_basis: row.legal_basis,
    status: row.status,
  };
}
