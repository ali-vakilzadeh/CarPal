// Allowlist projections of the fleet module (40 §18.1). People appear by
// display name only (drivers by name only with their
// fleet_driver_data_visibility consent); partners and providers as
// OrgSummary; amounts as Money strings.
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';

export type ProfileRow = Selectable<DB['fleet.fleet_profiles']>;
export type AssignmentRow = Selectable<DB['fleet.fleet_vehicle_assignments']>;
export type PartnerRow = Selectable<DB['fleet.fleet_preferred_partners']>;
export type ApprovalRow = Selectable<DB['fleet.fleet_approvals']>;
export type ImportBatchRow = Selectable<DB['fleet.fleet_import_batches']>;
export type ExportRow = Selectable<DB['fleet.fleet_exports']>;

export type OrgSummaryView = {
  id: string;
  name: string;
  organization_type: string;
  slug: string | null;
  logo_url: string | null;
  status: string;
  verification_status: string;
};

/** 40 Dec<10,2> amounts: the stored numeric without trailing noise. */
export const amount = (v: string | number): string => String(Math.round(Number(v) * 100) / 100);

export function toProfile(p: ProfileRow) {
  return {
    ...meta(p),
    fleet_size: p.fleet_size,
    ...(p.industry ? { industry: p.industry } : {}),
    approval_workflow_enabled: p.approval_workflow_enabled,
    ...(p.cost_approval_threshold_amount !== null ? { cost_approval_threshold_amount: amount(p.cost_approval_threshold_amount) } : {}),
    preferred_provider_mode: p.preferred_provider_mode,
    reporting_currency: p.reporting_currency,
    organization_id: p.organization_id,
    status: p.status,
  };
}

export function toAssignment(a: AssignmentRow, driverDisplay: string) {
  return {
    ...meta(a),
    vehicle_id: a.vehicle_id,
    driver_user_id: a.driver_user_id,
    driver_display: driverDisplay,
    assigned_at: iso(a.assigned_at),
    ended_at: isoOrNull(a.ended_at),
    status: a.status,
  };
}

export function toPartner(p: PartnerRow, partner: OrgSummaryView) {
  return {
    ...meta(p),
    partner_organization_id: p.partner_organization_id,
    relationship_type: p.relationship_type,
    ...(p.service_system_node_id ? { service_system_node_id: p.service_system_node_id } : {}),
    ...(p.part_category_node_id ? { part_category_node_id: p.part_category_node_id } : {}),
    priority: p.priority,
    ...(p.notes ? { notes: p.notes } : {}),
    partner,
    status: p.status,
  };
}

export function toApproval(a: ApprovalRow, o: { provider: OrgSummaryView | null; requestedBy: string; approver: string | null }) {
  return {
    ...meta(a),
    approval_type: a.approval_type,
    vehicle_id: a.vehicle_id,
    ...(a.related_issue_id ? { related_issue_id: a.related_issue_id } : {}),
    ...(a.related_appointment_id ? { related_appointment_id: a.related_appointment_id } : {}),
    ...(a.cost_estimate_amount !== null && a.cost_estimate_currency
      ? { cost_estimate: { amount: amount(a.cost_estimate_amount), currency: a.cost_estimate_currency } }
      : {}),
    selected_provider: o.provider,
    ai_triage_insight_id: a.ai_triage_insight_id,
    requested_by_display: o.requestedBy,
    approver_display: o.approver,
    status: a.status,
    decision_reason: a.decision_reason,
    decided_at: isoOrNull(a.decided_at),
  };
}

export function toExport(e: ExportRow) {
  const filters = (e.filters as Record<string, unknown> | null) ?? null;
  return {
    ...meta(e),
    export_type: e.export_type,
    ...(filters && Object.keys(filters).length ? { filters } : {}),
    format: e.format,
    status: e.status,
    expires_at: isoOrNull(e.expires_at),
  };
}

export function toImportBatch(b: ImportBatchRow) {
  return {
    ...meta(b),
    status: b.status,
    total_rows: b.total_rows,
    created_count: b.created_count,
    error_count: b.error_count,
    error_report_available: b.error_report_media_asset_id !== null,
    finished_at: isoOrNull(b.finished_at),
  };
}
