// Support inbox (AC14.T5, Docs/23 A-SUP-01): the pure rules of the screen, kept apart for unit tests. Views map to the
// contract's status filter; the team's clock (first response within 1 working day, Docs/23 §6) runs from
// clock_started_at and stops while the ticket waits on the user or is solved; a conversion carries only the fields its
// kind needs (Docs/40 SupportConversion, conditional fields).
import type {
  DisputeType,
  ModerationReason,
  ReportTargetType,
  StaffSupportTicket,
  SupportConversion,
  SupportOutcome,
  SupportReplyTemplate,
  SupportTicketStatus,
  SupportTopic,
} from '@carpal/api-contracts';
import { dueAt, slaState, SLA_TARGETS, type SlaState } from '@/lib/config/sla';

export const STATUSES: readonly SupportTicketStatus[] = ['new', 'waiting_on_team', 'waiting_on_user', 'solved'];
export const TOPICS: readonly SupportTopic[] = ['account_access', 'appointment_problem', 'data', 'bug', 'plan_billing', 'other'];
export const OUTCOMES: readonly SupportOutcome[] = ['answered', 'converted', 'duplicate', 'no_response', 'out_of_scope'];
/** Outcomes staff choose (no_response is the system's, after 7 days waiting on the user; converted needs a linked item). */
export const CLOSE_OUTCOMES: readonly SupportOutcome[] = ['answered', 'converted', 'duplicate', 'out_of_scope'];
export const REPLY_TEMPLATES: readonly SupportReplyTemplate[] = [
  'acknowledgement',
  'request_information',
  'how_to',
  'status_update',
  'converted_notice',
  'resolution',
  'other',
];
export const CONVERSIONS = ['moderation_case', 'privacy_request', 'dispute', 'plan_request'] as const;
export type ConversionKind = (typeof CONVERSIONS)[number];
export const CASE_TARGETS: readonly ReportTargetType[] = [
  'review',
  'review_response',
  'post',
  'comment',
  'question',
  'answer',
  'portfolio_item',
  'media_asset',
  'inventory_item',
  'inventory_fitment',
  'organization',
  'organization_location',
  'user',
  'ai_output',
];
export const DISPUTE_TARGETS = ['review', 'service_record', 'badge', 'appointment', 'moderation_action'] as const;
/** Every dispute type a ticket may become (not review_approval_objection: that one is the business's own path). */
export const DISPUTE_TYPES: readonly DisputeType[] = [
  'fake_review',
  'inaccurate_review',
  'mediation_request',
  'badge_challenge',
  'service_record_dispute',
  'moderation_appeal',
];
export const REQUEST_TYPES = ['export', 'deletion', 'rectification', 'consent_withdrawal'] as const;
export const PLAN_KEYS = [
  'individual_free',
  'fleet_20',
  'fleet_50',
  'fleet_100',
  'fleet_custom',
  'provider_basic',
  'provider_pro',
  'vendor_basic',
  'vendor_pro',
] as const;
/** Moderation reasons the backend raises to at least high severity (S18 floor). */
export const SEVERITY_FLOOR_REASONS: ReadonlySet<string> = new Set(['unsafe_advice', 'non_consensual_media', 'privacy']);

export const VIEWS = ['open', 'waiting', 'solved', 'all'] as const;
export type View = (typeof VIEWS)[number];
/** A view as the list's status filter (empty = every status). */
export function statusesOf(view: View): SupportTicketStatus[] {
  if (view === 'open') return ['new', 'waiting_on_team'];
  if (view === 'waiting') return ['waiting_on_user'];
  if (view === 'solved') return ['solved'];
  return [];
}

/** The team's clock: due 1 working day after it started; null while it is stopped (waiting on the user, solved). */
export function ticketSla(
  t: Pick<StaffSupportTicket, 'clock_started_at' | 'status'>,
  timeZone: string,
  now = Date.now(),
): { state: SlaState; due: number } | null {
  if (!t.clock_started_at || t.status === 'solved' || t.status === 'waiting_on_user') return null;
  const start = Date.parse(t.clock_started_at);
  if (!Number.isFinite(start)) return null;
  const due = dueAt(start, SLA_TARGETS.support, timeZone);
  return { state: slaState(start, due, now), due };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConversionDraft {
  into: ConversionKind | '';
  caseTargetType: ReportTargetType | '';
  caseTargetId: string;
  reason: ModerationReason | '';
  severity: 'low' | 'medium' | 'high' | 'critical';
  requestType: (typeof REQUEST_TYPES)[number] | '';
  disputeTargetType: (typeof DISPUTE_TARGETS)[number] | '';
  disputeTargetId: string;
  disputeType: DisputeType | '';
  planKey: (typeof PLAN_KEYS)[number] | '';
  statement: string;
}

export const EMPTY_CONVERSION: ConversionDraft = {
  into: '',
  caseTargetType: '',
  caseTargetId: '',
  reason: '',
  severity: 'medium',
  requestType: '',
  disputeTargetType: '',
  disputeTargetId: '',
  disputeType: '',
  planKey: '',
  statement: '',
};

export type ConversionProblem =
  'into' | 'target' | 'reason' | 'requestType' | 'disputeTarget' | 'disputeType' | 'planKey' | 'organization' | 'statement';
export const STATEMENT_MAX = 2000;

/** The conversion body (without the reason) or what is missing; a plan request needs the ticket's organization. */
export function conversionOf(
  d: ConversionDraft,
  hasOrganization: boolean,
): { value: Omit<SupportConversion, 'reason'> } | { problems: ConversionProblem[] } {
  const problems: ConversionProblem[] = [];
  const statement = d.statement.trim();
  if (statement.length > STATEMENT_MAX) problems.push('statement');
  const extra = statement ? { statement } : {};
  switch (d.into) {
    case 'moderation_case': {
      const id = d.caseTargetId.trim();
      if (!d.caseTargetType || !UUID.test(id)) problems.push('target');
      if (!d.reason) problems.push('reason');
      if (problems.length) return { problems };
      const severity = SEVERITY_FLOOR_REASONS.has(d.reason) && (d.severity === 'low' || d.severity === 'medium') ? 'high' : d.severity;
      return {
        value: {
          into: 'moderation_case',
          case_target: { type: d.caseTargetType as ReportTargetType, id: id.toLowerCase() },
          moderation_reason: d.reason as ModerationReason,
          severity,
          ...extra,
        },
      };
    }
    case 'privacy_request':
      if (!d.requestType) problems.push('requestType');
      if (problems.length) return { problems };
      return { value: { into: 'privacy_request', request_type: d.requestType as (typeof REQUEST_TYPES)[number], ...extra } };
    case 'dispute': {
      const id = d.disputeTargetId.trim();
      if (!d.disputeTargetType || !UUID.test(id)) problems.push('disputeTarget');
      if (!d.disputeType) problems.push('disputeType');
      if (problems.length) return { problems };
      return {
        value: {
          into: 'dispute',
          dispute_target: { type: d.disputeTargetType as (typeof DISPUTE_TARGETS)[number], id: id.toLowerCase() },
          dispute_type: d.disputeType as DisputeType,
          ...extra,
        },
      };
    }
    case 'plan_request':
      if (!hasOrganization) problems.push('organization');
      if (!d.planKey) problems.push('planKey');
      if (problems.length) return { problems };
      return { value: { into: 'plan_request', plan_key: d.planKey as (typeof PLAN_KEYS)[number], ...extra } };
    default:
      return { problems: ['into', ...problems] };
  }
}

/** The list operation whose screen handles a linked item (to show a link only to staff who may open it). */
export const LINKED_OPS = {
  moderation_case: 'admin.cases_list',
  data_subject_request: 'admin.dsr_queue',
  dispute: 'admin.disputes_queue',
  subscription_change_request: 'admin.subscription_change_requests_list',
} as const;

/** Where a linked item is handled in the console. */
export function linkedHref(item: { type: string; id: string }): string | null {
  switch (item.type) {
    case 'moderation_case':
      return `/content?tab=content&case=${encodeURIComponent(item.id)}`;
    case 'data_subject_request':
      return `/privacy?request=${encodeURIComponent(item.id)}`;
    case 'dispute':
      return `/disputes?dispute=${encodeURIComponent(item.id)}`;
    case 'subscription_change_request':
      return '/plans?tab=requests';
    default:
      return null;
  }
}
