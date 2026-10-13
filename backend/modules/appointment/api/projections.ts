// Response projections of the appointment module (40 §16.1): allowlists per
// side. The requester sees the exact provider address only from confirmation
// (52 §12, SEC-OUT-4); the provider sees the requester's contact only through
// appointment.requester_contact (confirmed until 30 days after completion) and
// never the requester's vehicle record beyond its taxonomy card. Internal
// notes never reach the requester (RLS requester_visible and the queries).
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import type { BookingLocation } from '#modules/organization/interface/booking.js';
import type { PublicOrgCard } from '#modules/organization/interface/public-profiles.js';
import type { VehicleCard } from '#modules/vehicle/interface/vehicles.js';
import { allowedTransitions, type Side } from '../domain/rules.js';

export type AppointmentRow = Selectable<DB['appointment.appointments']>;
export type WindowRow = Selectable<DB['appointment.appointment_time_windows']>;
export type NoteRow = Selectable<DB['appointment.appointment_notes']>;
export type HistoryRow = Selectable<DB['appointment.appointment_status_history']>;
export type ParticipantRow = Selectable<DB['appointment.appointment_participants']>;
export type RuleRow = Selectable<DB['appointment.provider_availability_rules']>;
export type TimeOffRow = Selectable<DB['appointment.provider_time_off']>;
export type ReportRow = Selectable<DB['appointment.pre_visit_reports']>;

const EXACT_FROM = ['confirmed', 'checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup', 'completed'];

export interface AppointmentExtras {
  side: Side;
  provider: PublicOrgCard;
  location: BookingLocation | undefined;
  vehicle: VehicleCard | undefined;
  labels: Map<string, L10n>;
  requesterDisplay: string;
  windows: WindowRow[];
  serviceRecordId: string | null;
  canReview: boolean;
  contact: { channel: string; value: string } | null;
}

export function toAppointment(a: AppointmentRow, x: AppointmentExtras) {
  const lb = (id: string | null | undefined) => (id ? (x.labels.get(id) ?? null) : null);
  const fallback: L10n = { text: '—', locale: 'en' } as L10n;
  return {
    ...meta(a),
    requester_type: a.requester_type,
    requester_display: x.requesterDisplay,
    requester_organization_id: a.requester_organization_id,
    provider: x.provider,
    provider_location: x.location?.public ?? null,
    provider_location_exact:
      x.side === 'requester' && x.location && EXACT_FROM.includes(a.status)
        ? {
            address_line_1: x.location.exact.address_line_1,
            address_line_2: x.location.exact.address_line_2,
            point: x.location.exact.point,
          }
        : null,
    vehicle: {
      id: a.vehicle_id,
      brand: lb(x.vehicle?.brandNodeId) ?? fallback,
      model: lb(x.vehicle?.modelNodeId) ?? fallback,
      series: lb(x.vehicle?.seriesNodeId),
      year: x.vehicle?.year ?? 2000,
      nickname: x.vehicle?.nickname ?? null,
    },
    source: a.source,
    match_result_id: a.match_result_id,
    related_issue_id: a.related_issue_id,
    triage_session_id: a.triage_session_id,
    triage_status: a.triage_status,
    safety_flag: a.safety_flag,
    fleet_approval_id: a.fleet_approval_id,
    appointment_type: a.appointment_type,
    service_mode: a.service_mode,
    service_system: lb(a.service_system_node_id),
    service_task: lb(a.service_task_node_id),
    symptom: lb(a.symptom_node_id),
    description: a.description,
    content_locale: a.content_locale,
    urgency_level: a.urgency_level,
    customer_expectations: a.customer_expectations,
    preferred_contact_channel: a.preferred_contact_channel,
    time_windows: x.windows
      .slice(0, 5)
      .map((w) => ({ id: w.id, start_at: iso(w.start_at), end_at: iso(w.end_at), priority: Number(w.priority) })),
    proposed_start_at: isoOrNull(a.proposed_start_at),
    proposed_end_at: isoOrNull(a.proposed_end_at),
    confirmed_start_at: isoOrNull(a.confirmed_start_at),
    confirmed_end_at: isoOrNull(a.confirmed_end_at),
    estimated_duration_minutes: a.estimated_duration_minutes,
    estimated_completion_from: isoOrNull(a.estimated_completion_from),
    estimated_completion_to: isoOrNull(a.estimated_completion_to),
    parts_availability_note: a.parts_availability_note,
    checked_in_at: isoOrNull(a.checked_in_at),
    customer_delay_minutes: a.customer_delay_minutes,
    cost_estimate:
      a.cost_estimate_amount !== null && a.cost_estimate_currency !== null
        ? { amount: String(a.cost_estimate_amount), currency: a.cost_estimate_currency }
        : null,
    consent_to_share_history: a.consent_to_share_history,
    status: a.status,
    cancelled_by: a.cancelled_by,
    cancellation_reason: a.cancellation_reason,
    completed_at: isoOrNull(a.completed_at),
    service_record_id: x.serviceRecordId,
    can_review: x.side === 'requester' && x.canReview,
    allowed_transitions: allowedTransitions(x.side, a.status),
    requester_contact: x.side === 'provider' ? x.contact : null,
  };
}

export function toHistory(h: HistoryRow) {
  return {
    id: h.id,
    old_status: h.old_status,
    new_status: h.new_status,
    changed_by_side: h.changed_by_side,
    note: h.note,
    changed_at: iso(h.changed_at),
  };
}

export function toNote(n: NoteRow, authorDisplay: string) {
  return {
    ...meta(n),
    note_type: n.note_type,
    body: n.body,
    content_locale: n.content_locale,
    author_display: authorDisplay,
    author_side: n.author_side,
  };
}

export function toParticipant(p: ParticipantRow, displayName: string) {
  return {
    id: p.id,
    user_id: p.user_id,
    display_name: displayName,
    organization_id: p.organization_id,
    participant_role: p.participant_role,
    status: p.status,
  };
}

const hhmm = (t: string) => String(t).slice(0, 5);
const day = (d: Date | string | null) => (d === null ? undefined : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export function toRule(r: RuleRow) {
  const from = day(r.effective_from);
  const to = day(r.effective_to);
  return {
    ...meta(r),
    location_id: r.location_id,
    day_of_week: Number(r.day_of_week),
    start_time: hhmm(r.start_time),
    end_time: hhmm(r.end_time),
    slot_duration_minutes: r.slot_duration_minutes,
    appointment_types: arr(r.appointment_types),
    max_concurrent_appointments: r.max_concurrent_appointments,
    buffer_minutes: r.buffer_minutes,
    ...(from ? { effective_from: from } : {}),
    ...(to ? { effective_to: to } : {}),
    status: r.status as 'active' | 'inactive',
  };
}

export function toTimeOff(t: TimeOffRow) {
  return {
    ...meta(t),
    ...(t.location_id ? { location_id: t.location_id } : {}),
    start_at: iso(t.start_at),
    end_at: iso(t.end_at),
    ...(t.reason ? { reason: t.reason } : {}),
    status: t.status,
  };
}

/** text[] columns arrive as arrays or "{a,b}" literals. */
export function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) return v.length > 2 ? v.slice(1, -1).split(',') : [];
  return [];
}
