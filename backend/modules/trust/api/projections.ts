// Public review projection (40 §15.1 PublicReview): an allowlist; internal
// fields (trust_weight, ai_*, reviewer identity, business confirmation notes)
// are never read into it (SEC-OUT-1).
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { isoOrNull, iso, meta } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import { authorDisplayName, type UserCard } from '#modules/identity/interface/identity.js';
import type { MediaAttachmentView } from '#modules/media/interface/media.js';
import type { VehicleCard } from '#modules/vehicle/interface/vehicles.js';

export type ReviewRow = Selectable<DB['trust.reviews']>;

export function toPublicReview(
  r: ReviewRow,
  x: {
    locale: string;
    labels: Map<string, L10n>;
    author: UserCard | undefined;
    vehicle: VehicleCard | undefined;
    subRatings: { dimension: string; rating: number }[];
    tags: string[];
    response: { response_text: string; content_locale: string; published_at: Date | string | null } | undefined;
    media: MediaAttachmentView[];
  },
) {
  const lb = (id: string | null | undefined) => (id ? (x.labels.get(id) ?? null) : null);
  const brand = lb(x.vehicle?.brandNodeId);
  const model = lb(x.vehicle?.modelNodeId);
  return {
    id: r.id,
    author: { display_name: authorDisplayName(x.author, x.locale), avatar_url: null },
    subject_location_id: r.subject_location_id,
    vehicle: brand && model ? { brand, model, series: lb(x.vehicle?.seriesNodeId) } : null,
    service_system: lb(r.service_system_node_id),
    service_task: lb(r.service_task_node_id),
    service_date: r.service_date ?? null,
    overall_rating: Number(r.overall_rating),
    would_return: r.would_return,
    title: r.title,
    body: r.body,
    content_locale: r.content_locale,
    sub_ratings: x.subRatings.slice(0, 5).map((s) => ({ dimension: s.dimension, rating: Number(s.rating) })),
    tags: x.tags
      .filter((id) => x.labels.has(id))
      .slice(0, 10)
      .map((id) => ({ node_id: id, label: x.labels.get(id)! })),
    media: x.media.slice(0, 10),
    label: r.confirmation_path === 'approval_based' ? 'approved_by_business_and_carpal' : 'verified_visit',
    disputed_by_business: r.disputed_by_business,
    helpful_count: r.helpful_count,
    response: x.response
      ? {
          response_text: x.response.response_text,
          content_locale: x.response.content_locale,
          published_at: isoOrNull(x.response.published_at)!,
        }
      : null,
    published_at: iso(r.published_at!),
  };
}

// ---------------------------------------------------------------- S7 views

export type ResponseRow = Selectable<DB['trust.review_responses']>;
export type RequestRow = Selectable<DB['trust.review_requests']>;
export type DisputeRow = Selectable<DB['trust.disputes']>;
export type BadgeRow = Selectable<DB['trust.provider_badges']>;
export type SignalRow = Selectable<DB['trust.trust_signals']>;

const opt = <K extends string, V>(k: K, v: V | null | undefined): Partial<Record<K, V>> =>
  v === null || v === undefined ? {} : ({ [k]: v } as Record<K, V>);
const day = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** 40 ReviewResponse (responded_by_display: the responding member's display name). */
export function toResponse(r: ResponseRow, respondedBy: string) {
  return {
    ...meta(r),
    review_id: r.review_id,
    response_text: r.response_text,
    content_locale: r.content_locale,
    ...opt('ai_draft_insight_id', r.ai_draft_insight_id),
    ai_assisted: r.ai_assisted,
    edited_after_ai: r.edited_after_ai,
    sensitivity_flags: arr(r.sensitivity_flags).slice(0, 3),
    responded_by_display: respondedBy,
    status: r.status,
    published_at: isoOrNull(r.published_at),
  };
}

/** 40 Review: the author's view; trust_weight, AI fields and reviewer identity never leave (SEC-OUT-1). */
export function toReview(
  r: ReviewRow,
  x: {
    subRatings: { dimension: string; rating: number }[];
    tagIds: string[];
    media: MediaAttachmentView[];
    canAddEvidence: boolean;
    response: ReturnType<typeof toResponse> | null;
  },
) {
  return {
    ...meta(r as unknown as Parameters<typeof meta>[0]),
    subject_organization_id: r.subject_organization_id,
    subject_type: r.subject_type,
    ...opt('subject_location_id', r.subject_location_id),
    ...opt('context_appointment_id', r.context_appointment_id),
    ...opt('context_service_record_id', r.context_service_record_id),
    ...opt('context_stock_inquiry_id', r.context_stock_inquiry_id),
    ...opt('context_vehicle_id', r.context_vehicle_id),
    ...opt('service_system_node_id', r.service_system_node_id),
    ...opt('service_task_node_id', r.service_task_node_id),
    ...opt('service_date', day(r.service_date)),
    overall_rating: Number(r.overall_rating),
    ...opt('would_return', r.would_return),
    ...opt('title', r.title),
    body: r.body,
    content_locale: r.content_locale,
    sub_ratings: x.subRatings.slice(0, 5).map((s) => ({ dimension: s.dimension, rating: Number(s.rating) })),
    tag_node_ids: x.tagIds.slice(0, 10),
    status: r.status,
    confirmation_path: r.confirmation_path,
    verified_status: r.verified_status,
    business_confirmation_status: r.business_confirmation_status,
    reviewer_decision: r.reviewer_decision,
    reviewer_reason_code: r.reviewer_reason_code,
    disputed_by_business: r.disputed_by_business,
    helpful_count: r.helpful_count,
    report_status: r.report_status,
    published_at: isoOrNull(r.published_at),
    media: x.media.slice(0, 10),
    can_add_evidence: x.canAddEvidence,
    response: x.response,
  };
}

/** 40 OrgReview: the public view plus status, report status and the response draft. */
export function toOrgReview(publicView: ReturnType<typeof toPublicReview>, r: ReviewRow, draft: ReturnType<typeof toResponse> | null) {
  return { ...publicView, status: r.status, report_status: r.report_status, response_draft: draft };
}

/** 40 ReviewInvitation (invited_display: the invitee's display name, never the address). */
export function toInvitation(
  q: RequestRow,
  subject: {
    id: string;
    name: string;
    organization_type: string;
    slug: string | null;
    logo_url: string | null;
    status: string;
    verification_status: string;
  },
  invitedDisplay: string | null,
) {
  const visit: { type: 'appointment' | 'service_record' | 'stock_inquiry' | 'provider_job_log'; id: string } = q.appointment_id
    ? { type: 'appointment', id: q.appointment_id }
    : q.service_record_id
      ? { type: 'service_record', id: q.service_record_id }
      : q.stock_inquiry_id
        ? { type: 'stock_inquiry', id: q.stock_inquiry_id }
        : { type: 'provider_job_log', id: q.provider_job_log_id! };
  return {
    ...meta(q),
    subject,
    visit,
    channel: q.channel,
    status: q.status,
    business_confirmation_given: q.business_confirmation_given,
    reminder_count: Number(q.reminder_count),
    sent_at: isoOrNull(q.sent_at),
    opened_at: isoOrNull(q.opened_at),
    expires_at: isoOrNull(q.expires_at),
    invited_display: invitedDisplay,
  };
}

/** 40 Dispute: moderator notes and the assignee are never returned. */
export function toDispute(d: DisputeRow) {
  return {
    ...meta(d),
    target: { type: d.target_entity_type, id: d.target_entity_id },
    dispute_type: d.dispute_type,
    reason: d.reason,
    status: d.status,
    resolution: d.resolution,
    resolved_at: isoOrNull(d.resolved_at),
  };
}

export function toBadge(b: BadgeRow) {
  return {
    ...meta(b),
    badge_type: b.badge_type,
    scope_taxonomy_node_ids: arr(b.scope_taxonomy_node_ids).slice(0, 3),
    rule_key: b.rule_key,
    rule_version: b.rule_version,
    evaluation_snapshot: b.evaluation_snapshot,
    requires_admin_approval: b.requires_admin_approval,
    awarded_at: iso(b.awarded_at),
    last_evaluated_at: iso(b.last_evaluated_at),
    expires_at: isoOrNull(b.expires_at),
    visibility: b.visibility,
    status: b.status,
    revoked_reason: b.revoked_reason,
  };
}

/** 40 TrustSignalView (Dec<12,4> as a string). */
export function toSignal(s: SignalRow) {
  return {
    signal_group: s.signal_group,
    signal_type: s.signal_type,
    scope_taxonomy_node_id: s.scope_taxonomy_node_id,
    value: String(Math.round(Number(s.value) * 10_000) / 10_000),
    is_public: s.is_public,
    rule_version: s.rule_version,
    calculated_at: iso(s.calculated_at),
  };
}

/** text[] and uuid[] columns arrive as arrays, domain arrays as "{a,b}" literals. */
export function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) return v.length > 2 ? v.slice(1, -1).split(',') : [];
  return [];
}
