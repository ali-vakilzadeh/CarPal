// Response projections of the vehicle module (40 §12.1), by allowlist for
// the vehicle's owner (the user, or fleet members). The VIN never leaves
// except through vehicles.vin_reveal: reads carry vin_present and vin_last4
// only (SEC-OUT-2). Optional members of the *Write types are omitted when
// the column is null; derived values are passed in by the use case.
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';

export type VehicleRow = Selectable<DB['vehicle.vehicles']>;
export type StatusHistoryRow = Selectable<DB['vehicle.vehicle_status_history']>;
export type MileageRow = Selectable<DB['vehicle.vehicle_mileage_logs']>;
export type DocumentRow = Selectable<DB['vehicle.vehicle_documents']>;
export type ServiceRecordRow = Selectable<DB['vehicle.vehicle_service_records']>;
export type EvidenceRow = Selectable<DB['vehicle.service_record_evidence']>;
export type IssueRow = Selectable<DB['vehicle.vehicle_issues']>;
export type ReminderRow = Selectable<DB['vehicle.maintenance_reminders']>;

/** Copies the listed optional members whose value is not null. */
function optional<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Partial<Record<K, NonNullable<T[K]>>> {
  const out: Partial<Record<K, NonNullable<T[K]>>> = {};
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) out[k] = row[k] as NonNullable<T[K]>;
  return out;
}

/** Values computed per request for the caller (40 `// derived`). */
export interface VehicleDerived {
  assignedDriver: { user_id: string; display_name: string } | null;
  openIssueCount: number;
  nextReminderDue: string | null;
  primaryPhotoUrl: string | null;
  duplicateVinWarning: boolean;
}

/** 40 Vehicle. */
export function toVehicle(v: VehicleRow, d: VehicleDerived) {
  return {
    ...meta(v),
    ...optional(v, [
      'license_plate',
      'nickname',
      'series_node_id',
      'engine_type_node_id',
      'fuel_type_node_id',
      'transmission',
      'drivetrain',
      'body_style',
      'color',
      'mileage_km',
      'ownership_start_date',
      'primary_photo_media_id',
      'notes',
    ] as const),
    brand_node_id: v.brand_node_id,
    model_node_id: v.model_node_id,
    year: v.year,
    owner_type: v.owner_type,
    owner_id: v.owner_id,
    vin_present: v.vin_hash !== null,
    vin_last4: v.vin_last4,
    vin_decode_status: v.vin_decode_status,
    vin_decoded_at: isoOrNull(v.vin_decoded_at),
    status: v.status,
    profile_completeness: v.profile_completeness,
    assigned_driver: d.assignedDriver,
    open_issue_count: d.openIssueCount,
    next_reminder_due: d.nextReminderDue,
    primary_photo_url: d.primaryPhotoUrl,
    duplicate_vin_warning: d.duplicateVinWarning,
  };
}

/** 40 VehicleStatusHistory. */
export function toStatusHistory(h: StatusHistoryRow, changedByDisplay: string) {
  return {
    id: h.id,
    old_status: h.old_status,
    new_status: h.new_status,
    changed_by_display: changedByDisplay,
    reason: h.reason,
    changed_at: iso(h.changed_at),
  };
}

/** 40 MileageLog. */
export function toMileage(m: MileageRow) {
  return {
    ...meta(m),
    mileage_km: m.mileage_km,
    recorded_at: iso(m.recorded_at),
    source: m.source as 'user' | 'fleet_driver' | 'service_record' | 'appointment',
    lower_than_previous: m.lower_than_previous,
  };
}

/** 40 VehicleDocument. */
export function toDocument(d: DocumentRow) {
  return {
    ...meta(d),
    document_type: d.document_type,
    title: d.title,
    media_asset_id: d.media_asset_id,
    visibility: d.visibility,
    ...optional(d, ['shared_with_organization_id', 'issued_at', 'expires_at'] as const),
    status: d.status,
  };
}

/** 40 ServiceRecordEvidence. */
export function toEvidence(e: EvidenceRow) {
  return {
    id: e.id,
    evidence_type: e.evidence_type,
    media_asset_id: e.media_asset_id,
    reference:
      e.reference_entity_type && e.reference_entity_id
        ? { type: e.reference_entity_type as 'appointment', id: e.reference_entity_id }
        : null,
    status: e.status,
  };
}

type Json = Record<string, unknown>;

/** 40 ServiceRecord (cost_amount + currency → Money, 40 §3.4). */
export function toServiceRecord(r: ServiceRecordRow, evidence: EvidenceRow[], provider: unknown) {
  const parts = Array.isArray(r.parts_used) ? (r.parts_used as Json[]) : [];
  return {
    ...meta(r),
    vehicle_id: r.vehicle_id,
    service_date: r.service_date,
    ...optional(r, [
      'provider_organization_id',
      'service_task_node_id',
      'description',
      'warranty_note',
      'mileage_km',
      'resolves_issue_id',
    ] as const),
    service_system_node_id: r.service_system_node_id,
    ...(parts.length ? { parts_used: parts } : {}),
    ...(r.cost_amount !== null && r.currency ? { cost: { amount: r.cost_amount, currency: r.currency } } : {}),
    ...(r.cost_breakdown ? { cost_breakdown: r.cost_breakdown as Json } : {}),
    visibility: r.visibility,
    source_type: r.source_type,
    verification_status: r.verification_status,
    provider,
    appointment_id: r.appointment_id,
    job_log_id: r.job_log_id,
    next_service_insight_id: r.next_service_insight_id,
    created_by_type: r.created_by_type,
    status: r.status,
    evidence: evidence.map(toEvidence),
  };
}

/** 40 VehicleIssue (safety_flag derived from the shared keyword check). */
export function toIssue(i: IssueRow, d: { mediaIds: string[]; safetyFlag: boolean; reportedByDisplay: string }) {
  return {
    ...meta(i),
    vehicle_id: i.vehicle_id,
    title: i.title,
    description: i.description,
    content_locale: i.content_locale,
    ...optional(i, ['symptom_node_id'] as const),
    urgency_level: i.urgency_level,
    ...(d.mediaIds.length ? { media_ids: d.mediaIds } : {}),
    source: i.source,
    reported_by_display: d.reportedByDisplay,
    triage_session_id: i.triage_session_id,
    ai_triage_insight_id: i.ai_triage_insight_id,
    safety_flag: d.safetyFlag,
    fleet_approval_status: i.fleet_approval_status,
    converted_appointment_id: i.converted_appointment_id,
    status: i.status,
    resolved_at: isoOrNull(i.resolved_at),
  };
}

/** 40 MaintenanceReminder. */
export function toReminder(r: ReminderRow) {
  return {
    ...meta(r),
    vehicle_id: r.vehicle_id,
    reminder_type: r.reminder_type,
    title: r.title,
    ...optional(r, ['reason', 'due_by_mileage_km', 'due_by_date'] as const),
    priority: r.priority,
    source: r.source,
    insight_id: r.insight_id,
    snoozed_until: r.snoozed_until,
    status: r.status,
  };
}
