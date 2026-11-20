// AI oversight rules (AC13.T4, Docs/23 A-AI-01, A-AI-02 read-only): the ai_quality dashboard read as oversight numbers,
// the alert cards, and the labels of insights. The console sets the alert thresholds (Docs/23 "threshold breaches
// shown as red cards"; the contract carries no targets): any hallucination report in the period, and an acceptance
// rate below AI_ACCEPTANCE_TARGET once AI_MIN_FEEDBACK answers exist.
import type { AiInsight, InsightType } from '@carpal/api-contracts';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { metricValue, gaugeDay, share, type DashboardMetric } from '@/features/analytics';

export const INSIGHT_TYPES: readonly InsightType[] = [
  'triage_summary',
  'urgency_assessment',
  'maintenance_suggestion',
  'provider_match',
  'match_explanation',
  'vehicle_field_suggestion',
  'vehicle_summary',
  'service_history_summary',
  'recurring_issue',
  'category_extraction',
  'resolution_status_suggestion',
  'duplicate_record',
  'skill_heatmap',
  'capability_suggestion',
  'profile_suggestion',
  'badge_eligibility',
  'review_sentiment',
  'review_theme',
  'review_response_draft',
  'review_quality_score',
  'improvement_suggestion',
  'showcase_caption',
  'showcase_draft',
  'redaction_suggestion',
  'appointment_slot_suggestion',
  'customer_need_summary',
  'pre_visit_summary',
  'inventory_normalization',
  'fitment_suggestion',
  'duplicate_inventory',
  'inventory_gap',
  'catalog_quality',
  'fleet_suggestion',
  'fraud_flag',
  'duplicate_entity',
  'search_synonym_suggestion',
  'query_interpretation',
  'moderation_recommendation',
  'profile_confidence_score',
  'likely_specialization',
];

export const FEEDBACK = ['hallucination_report', 'rejected', 'corrected'] as const;
export type Feedback = (typeof FEEDBACK)[number];

const APPROVAL = ['not_required', 'pending', 'approved', 'rejected'];
const VISIBILITY = ['internal', 'owner_only', 'public_after_approval'];
const SAFETY = ['safety_critical', 'legal_sensitive', 'privacy_sensitive'];

const label = (known: readonly string[], prefix: string) => (v: string, t: Translate) =>
  known.includes(v) ? t(`admin.ai.${prefix}.${v}` as MessageKey) : t('admin.kit.unknown', { value: v });

export const insightTypeLabel = label(INSIGHT_TYPES, 'type');
export const feedbackLabel = label(FEEDBACK, 'feedback');
export const approvalLabel = label(APPROVAL, 'approval');
export const visibilityLabel = label(VISIBILITY, 'visibility');
export const safetyLabel = label(SAFETY, 'safety');

export type InsightRow = AiInsight & { organization_id: string | null };

export const AI_ACCEPTANCE_TARGET = 0.5;
export const AI_MIN_FEEDBACK = 10;

export interface AiNumbers {
  generated: number;
  pending: number | null;
  accepted: number | null;
  rejected: number | null;
  hallucinations: number | null;
  /** accepted / (accepted + rejected); null without answers. */
  acceptance: number | null;
  /** The day the gauges are from. */
  asOf: string | null;
}

/** The oversight numbers of an ai_quality dashboard (gauges are the latest day's state). */
export function aiNumbers(metrics: readonly DashboardMetric[]): AiNumbers {
  const m = (k: string) => metrics.find((x) => x.metric_key === k);
  const gauge = (k: string) => {
    const x = m(k);
    return x && gaugeDay(x) ? metricValue(x) : null;
  };
  const accepted = gauge('gauge.ai_feedback_accepted');
  const rejected = gauge('gauge.ai_feedback_rejected');
  const days = metrics
    .filter((x) => x.metric_key.startsWith('gauge.'))
    .map(gaugeDay)
    .filter((d): d is string => !!d)
    .sort();
  return {
    generated: metricValue(m('events.ai.insight.generated')),
    pending: gauge('gauge.ai_suggestions_pending'),
    accepted,
    rejected,
    hallucinations: gauge('gauge.ai_hallucination_reports'),
    acceptance: accepted === null || rejected === null ? null : share(accepted, accepted + rejected),
    asOf: days.at(-1) ?? null,
  };
}

export type AiAlert = { kind: 'hallucinations'; n: number } | { kind: 'acceptance'; rate: number };

export function aiAlerts(n: AiNumbers): AiAlert[] {
  const out: AiAlert[] = [];
  if (n.hallucinations && n.hallucinations > 0) out.push({ kind: 'hallucinations', n: n.hallucinations });
  const answers = (n.accepted ?? 0) + (n.rejected ?? 0);
  if (n.acceptance !== null && answers >= AI_MIN_FEEDBACK && n.acceptance < AI_ACCEPTANCE_TARGET)
    out.push({ kind: 'acceptance', rate: n.acceptance });
  return out;
}
