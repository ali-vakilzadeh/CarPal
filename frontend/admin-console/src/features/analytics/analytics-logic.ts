// Analytics rules (AC13.T5, Docs/23 A-ANL-01, Docs/40 admin.analytics_dashboard): the 11 dashboards, what each metric
// means, the period a dashboard is read for, and the day-by-day series a chart draws. The backend returns, per metric,
// the value over the period and the daily rows it has (events.daily_metrics; aggregates only, no personal data):
// - "events.<name>" counts add up over the period (a day without a row counted nothing);
// - "gauge.<name>" is a state taken once a day: the value is the latest day's, and a day without a row is unknown.
// `unit` is always "count" in contract 1.5.0, so the kind comes from the key's prefix. Region and organization type are
// accepted by the operation but filter nothing yet (backend comment, DI-36), so the console offers no such filter.
import type { Dashboard, DashboardKey } from '@carpal/api-contracts';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export const DASHBOARD_KEYS: readonly DashboardKey[] = [
  'activation',
  'matching',
  'search_and_map',
  'trust',
  'reviews',
  'provider_value',
  'vendor_value',
  'fleet_value',
  'growth',
  'moderation_load',
  'ai_quality',
];

export function isDashboardKey(v: unknown): v is DashboardKey {
  return typeof v === 'string' && (DASHBOARD_KEYS as readonly string[]).includes(v);
}

export type MetricKind = 'count' | 'gauge';

export const metricKind = (key: string): MetricKind => (key.startsWith('gauge.') ? 'gauge' : 'count');

/** The metrics the backend computes (backend modules/analytics/domain/events.ts DASHBOARDS), with their labels. */
const METRIC_LABELS = {
  'events.user.registered': 'userRegistered',
  'events.vehicle.created': 'vehicleCreated',
  'events.onboarding.step_completed': 'onboardingStep',
  'events.app.opened': 'appOpened',
  'events.review.published': 'reviewPublished',
  'events.review.created': 'reviewCreated',
  'events.review.approval.requested': 'reviewApprovalRequested',
  'events.review.approved': 'reviewApproved',
  'events.review.invitation.sent': 'invitationSent',
  'events.review.invitation.opened': 'invitationOpened',
  'events.review.reported': 'reviewReported',
  'events.dispute.opened': 'disputeOpened',
  'events.badge.awarded': 'badgeAwarded',
  'events.moderation.action.taken': 'moderationAction',
  'events.search.started': 'searchStarted',
  'events.search.zero_result': 'searchZero',
  'events.search.result_opened': 'searchResultOpened',
  'events.search.chip_edited': 'searchChipEdited',
  'events.search.safety_banner_shown': 'searchSafetyBanner',
  'events.map.opened': 'mapOpened',
  'events.map.pin_selected': 'mapPinSelected',
  'events.map.vehicle_filter_toggled': 'mapVehicleFilter',
  'events.map.directions_tapped': 'mapDirections',
  'events.appointment.requested': 'appointmentRequested',
  'events.appointment.confirmed': 'appointmentConfirmed',
  'events.appointment.completed': 'appointmentCompleted',
  'events.profile.viewed': 'profileViewed',
  'events.inquiry.sent': 'inquirySent',
  'events.fleet.approval.requested': 'fleetApprovalRequested',
  'events.fleet.approval.decided': 'fleetApprovalDecided',
  'events.ai.insight.generated': 'aiInsightGenerated',
  'events.provider.profile.published': 'providerPublished',
  'gauge.vendors_published': 'vendorsPublished',
  'gauge.fleets_active': 'fleetsActive',
  'gauge.providers_published': 'providersPublished',
  'gauge.users_active': 'usersActive',
  'gauge.ai_suggestions_pending': 'aiSuggestionsPending',
  'gauge.ai_feedback_accepted': 'aiFeedbackAccepted',
  'gauge.ai_feedback_rejected': 'aiFeedbackRejected',
  'gauge.ai_hallucination_reports': 'aiHallucinationReports',
  'gauge.moderation_open_cases': 'openCases',
  'gauge.reports_open': 'openReports',
  'gauge.review_approvals_pending': 'reviewApprovalsPending',
  'gauge.dsr_open': 'dsrOpen',
} as const satisfies Record<string, string>;

export const KNOWN_METRICS: readonly string[] = Object.keys(METRIC_LABELS);

/** A metric's name for people; a key this console does not know reads "Unknown (<key>)". */
export function metricLabel(key: string, t: Translate): string {
  const name = (METRIC_LABELS as Record<string, string>)[key];
  return name ? t(`admin.analytics.metric.${name}` as MessageKey) : t('admin.kit.unknown', { value: key });
}

// ---------------------------------------------------------------------------------------------------------------
// Periods

export const RANGE_PRESETS = ['today', '7', '30', '90'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const isRangePreset = (v: unknown): v is RangePreset => typeof v === 'string' && (RANGE_PRESETS as readonly string[]).includes(v);

/** The longest period the operation accepts (Docs/40: `to` at most 366 days after `from`). */
export const MAX_RANGE_DAYS = 366;

export interface DayRange {
  from: string;
  to: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

/** yyyy-mm-dd of an instant on the viewer's clock (the region's day, not UTC: Tehran is 3:30 ahead). */
export function dayIn(at: number, timeZone: string): string {
  // en-CA writes dates as yyyy-mm-dd.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** A calendar day moved by n days (calendar arithmetic in UTC, no time zone). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (0 for the same day). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);

/** The days a preset covers, ending today on the viewer's clock: today, or the last 7/30/90 days with today. */
export function presetRange(preset: RangePreset, now: number, timeZone: string): DayRange {
  const to = dayIn(now, timeZone);
  return { from: preset === 'today' ? to : addDays(to, -(Number(preset) - 1)), to };
}

export type RangeProblem = 'format' | 'order' | 'tooLong';

/** A typed period: both days valid, `from` not after `to`, at most 366 days. */
export function checkRange(from: string, to: string): RangeProblem | null {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'format';
  if (to < from) return 'order';
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return 'tooLong';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Values and series

export type DashboardMetric = Dashboard['metrics'][number];

export interface SeriesPoint {
  date: string;
  /** null: no row that day (only gauges; a count without a row counted nothing). */
  value: number | null;
}

/** Every day of the period with the metric's value: counts fill missing days with 0, gauges leave them unknown. */
export function dailySeries(metric: DashboardMetric, range: DayRange): SeriesPoint[] {
  const byDay = new Map((metric.series ?? []).map((p) => [p.date, Number(p.value)]));
  const gauge = metricKind(metric.metric_key) === 'gauge';
  const days = Math.min(daysBetween(range.from, range.to), MAX_RANGE_DAYS);
  const out: SeriesPoint[] = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(range.from, i);
    const v = byDay.get(date);
    out.push({ date, value: v === undefined || Number.isNaN(v) ? (gauge ? null : 0) : v });
  }
  return out;
}

/** The day a gauge's value is from (its latest row), or null when the period has none. */
export function gaugeDay(metric: DashboardMetric): string | null {
  const days = (metric.series ?? []).map((p) => p.date).sort();
  return days.at(-1) ?? null;
}

/** The metric's value as a number (the operation sends decimals as strings). */
export const metricValue = (metric: DashboardMetric | undefined): number => (metric ? Number(metric.value) || 0 : 0);

/** A metric has data in the period: a count above zero, or a gauge with at least one row. */
export function hasData(metric: DashboardMetric): boolean {
  return metricKind(metric.metric_key) === 'gauge' ? (metric.series?.length ?? 0) > 0 : metricValue(metric) > 0;
}

/** part / whole, or null when the whole is 0 (a rate of nothing is not 0 %). */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Clean axis ticks from 0 to at least `max`: 0 and up to 4 steps of 1, 2 or 5 × 10^n. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
