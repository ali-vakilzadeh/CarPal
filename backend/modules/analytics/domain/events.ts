// Product analytics rules (52 AnalyticsEvent, ActorPseudonym; 40
// events.ingest, admin.analytics_dashboard; MVP §16). Pure functions:
//   - the registry of client event names and their property schemas (only
//     registered names and properties are accepted; values are scalars from
//     closed vocabularies, never free text, ids of people or coordinates);
//   - the domain events W12 copies into the analytics database and the
//     non-personal properties it keeps from their payloads;
//   - the dashboards: which daily metrics each one shows.
import { createHmac } from 'node:crypto';

type PropertySpec =
  { kind: 'enum'; values: readonly string[] } | { kind: 'bool' } | { kind: 'int'; min: number; max: number } | { kind: 'key' }; // a short machine key (a-z, 0-9, _ . -), e.g. a navigation app key

const ENTRY_POINTS = ['home', 'search', 'map', 'help_me', 'discover', 'profile', 'vehicle', 'notification', 'deep_link', 'other'] as const;
const TARGETS = ['organization', 'inventory_item', 'location'] as const;

/** Client events (40 Appendix A "events.ingest (client analytics)", 52 §18 registered names). */
export const CLIENT_EVENTS: Record<string, Record<string, PropertySpec>> = {
  'map.opened': { entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'map.pin_selected': { target_type: { kind: 'enum', values: TARGETS }, rank: { kind: 'int', min: 0, max: 1000 } },
  'map.vehicle_filter_toggled': { enabled: { kind: 'bool' }, show_all_nearby: { kind: 'bool' } },
  'map.directions_tapped': { navigation_app_key: { kind: 'key' }, target_type: { kind: 'enum', values: TARGETS } },
  'search.started': { entry_point: { kind: 'enum', values: ENTRY_POINTS }, help_me_used: { kind: 'bool' } },
  'search.safety_banner_shown': { entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'search.chip_edited': { chip_type: { kind: 'key' } },
  'search.result_opened': { target_type: { kind: 'enum', values: TARGETS }, rank: { kind: 'int', min: 0, max: 1000 } },
  'profile.viewed': { target_type: { kind: 'enum', values: ['provider', 'vendor'] }, entry_point: { kind: 'enum', values: ENTRY_POINTS } },
  'app.opened': { cold_start: { kind: 'bool' } },
  'onboarding.step_completed': {
    flow_type: { kind: 'enum', values: ['individual', 'fleet', 'provider', 'vendor'] },
    step: { kind: 'key' },
  },
};

const KEY = /^[a-z0-9_.-]{1,40}$/;
/** Client clocks drift: events up to 5 min in the future and 7 days back are accepted. */
const FUTURE_MS = 5 * 60_000;
const PAST_MS = 7 * 86_400_000;

export interface ClientEventInput {
  event_name: string;
  schema_version: number;
  occurred_at: string;
  session_id?: string;
  properties?: Record<string, unknown>;
}

/** The accepted, normalized properties of a client event, or null when it is refused (unknown name, property or value). */
export function validateClientEvent(e: ClientEventInput, now = Date.now()): Record<string, string | number | boolean> | null {
  const spec = CLIENT_EVENTS[e.event_name];
  if (!spec) return null;
  const at = Date.parse(e.occurred_at);
  if (!Number.isFinite(at) || at > now + FUTURE_MS || at < now - PAST_MS) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(e.properties ?? {})) {
    const p = spec[k];
    if (!p) return null;
    if (p.kind === 'bool' && typeof v === 'boolean') out[k] = v;
    else if (p.kind === 'int' && Number.isInteger(v) && (v as number) >= p.min && (v as number) <= p.max) out[k] = v as number;
    else if (p.kind === 'enum' && typeof v === 'string' && p.values.includes(v)) out[k] = v;
    else if (p.kind === 'key' && typeof v === 'string' && KEY.test(v)) out[k] = v;
    else return null;
  }
  return out;
}

/** Domain events W12 copies (41 §6.2 "W12") with the payload keys that are safe to keep (no person ids, no text). */
export const FORWARDED_EVENTS: Record<string, readonly string[]> = {
  'user.registered': [],
  'vehicle.created': ['owner_type', 'vin_present'],
  'vehicle.issue.reported': ['urgency_level', 'safety_flag', 'source'],
  'provider.profile.published': [],
  'search.started': ['search_mode', 'entry_point', 'help_me_used', 'safety_flag', 'result_count', 'query_language'],
  'search.zero_result': ['search_mode', 'query_language'],
  'search.chip_edited': ['chip_type'],
  'map.opened': ['entry_point', 'pin_count'],
  'appointment.requested': ['source', 'requester_type', 'triage_status'],
  'appointment.confirmed': ['requester_type'],
  'appointment.completed': ['requester_type'],
  'review.created': ['confirmation_path', 'subject_type'],
  'review.published': ['confirmation_path', 'subject_type', 'overall_rating'],
  'review.approved': ['subject_type'],
  'review.reported': ['reason'],
  'review.invitation.sent': ['channel', 'source'],
  'review.invitation.opened': [],
  'review.approval.requested': [],
  'inquiry.sent': ['requester_type', 'vehicle_context_shared'],
  'fleet.approval.requested': ['approval_type'],
  'fleet.approval.decided': ['approval_type', 'status'],
  'moderation.action.taken': ['action_type', 'target_type'],
  'dispute.opened': ['target_type', 'dispute_type'],
  'badge.awarded': ['badge_type'],
  'portfolio.published': [],
  'qna.question.created': [],
  'user.deletion.completed': [],
};

/** Payload keys that identify a person: the actor of the event (pseudonymized), never stored as properties. */
export const ACTOR_KEYS = ['user_id', 'author_user_id', 'requester_user_id', 'requested_by_user_id', 'raised_by_user_id'] as const;

export function forwardedProperties(type: string, payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of FORWARDED_EVENTS[type] ?? []) {
    const v = payload[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && KEY.test(v)) out[k] = v;
  }
  return out;
}

/** 52 ActorPseudonym: HMAC(per-user key, user id), 64 hex characters; unlinkable once the key is deleted. */
export function pseudonym(key: Buffer, userId: string): string {
  return createHmac('sha256', key).update(userId).digest('hex');
}

/** Metric key of an event count (events.daily_metrics.metric_key). */
export const countMetric = (eventName: string): string => `events.${eventName}`;

/** Gauges computed from the primary database once a day (counts at the end of the day, no personal data). */
export const GAUGES = {
  'gauge.users_active': 'count',
  'gauge.providers_published': 'count',
  'gauge.vendors_published': 'count',
  'gauge.fleets_active': 'count',
  'gauge.moderation_open_cases': 'count',
  'gauge.reports_open': 'count',
  'gauge.review_approvals_pending': 'count',
  'gauge.dsr_open': 'count',
} as const;

export type DashboardKey =
  | 'activation'
  | 'trust'
  | 'matching'
  | 'provider_value'
  | 'vendor_value'
  | 'fleet_value'
  | 'ai_quality'
  | 'growth'
  | 'moderation_load'
  | 'search_and_map'
  | 'reviews';

/** Metrics per dashboard (40 §23.5 DashboardKey; MVP §16 metric groups). */
export const DASHBOARDS: Record<DashboardKey, string[]> = {
  activation: [
    countMetric('user.registered'),
    countMetric('vehicle.created'),
    countMetric('onboarding.step_completed'),
    countMetric('app.opened'),
  ],
  trust: [
    countMetric('review.published'),
    countMetric('dispute.opened'),
    countMetric('badge.awarded'),
    countMetric('moderation.action.taken'),
  ],
  matching: [
    countMetric('search.started'),
    countMetric('search.zero_result'),
    countMetric('search.result_opened'),
    countMetric('appointment.requested'),
  ],
  provider_value: [
    countMetric('appointment.requested'),
    countMetric('appointment.confirmed'),
    countMetric('appointment.completed'),
    countMetric('profile.viewed'),
  ],
  vendor_value: [countMetric('inquiry.sent'), countMetric('profile.viewed'), 'gauge.vendors_published'],
  fleet_value: [countMetric('fleet.approval.requested'), countMetric('fleet.approval.decided'), 'gauge.fleets_active'],
  ai_quality: [countMetric('ai.insight.generated'), countMetric('search.started')],
  growth: [
    countMetric('user.registered'),
    countMetric('provider.profile.published'),
    'gauge.users_active',
    'gauge.providers_published',
    'gauge.vendors_published',
    'gauge.fleets_active',
  ],
  moderation_load: [
    countMetric('review.reported'),
    countMetric('moderation.action.taken'),
    'gauge.moderation_open_cases',
    'gauge.reports_open',
    'gauge.review_approvals_pending',
    'gauge.dsr_open',
  ],
  search_and_map: [
    countMetric('search.started'),
    countMetric('search.zero_result'),
    countMetric('search.chip_edited'),
    countMetric('search.safety_banner_shown'),
    countMetric('map.opened'),
    countMetric('map.pin_selected'),
    countMetric('map.vehicle_filter_toggled'),
    countMetric('map.directions_tapped'),
  ],
  reviews: [
    countMetric('review.created'),
    countMetric('review.published'),
    countMetric('review.approval.requested'),
    countMetric('review.approved'),
    countMetric('review.invitation.sent'),
    countMetric('review.invitation.opened'),
  ],
};

/** Formats a metric value as 40 Dec<14,4> (non-negative, at most 4 decimals). */
export function dec4(v: number): string {
  const n = Math.max(0, Math.min(99_999_999_999_999, v));
  return String(Math.round(n * 10_000) / 10_000);
}
