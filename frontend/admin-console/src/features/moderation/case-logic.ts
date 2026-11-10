// Rules of the moderation screens (AC8, Docs/23 A-CON-01/02, A-INV-01, principle 10 "safety first"; Docs/40 §23.4).
// Kept apart from the screens so they are unit-tested: the case and report vocabularies, the queue a case type belongs
// to, the target a case shows (admin.case_get target_snapshot is Json<TargetSnapshot> in the contract; its fields are
// the backend's per target type, DI-21), which moderation actions apply to that target in its state (the backend's
// ModerationTargets: an action that does not apply answers 409 INVALID_TRANSITION, so the console offers only those
// that do), the safety-first order of a queue and the SLA timer of a case. Review cases (AC7) use the same rules.
import type { ModerationCase, ModerationReason, ReportTargetType, StaffReport } from '@carpal/api-contracts';
import type { ReasonKind } from '@/lib/config/reasons';
import { dueAt, SLA_TARGETS, URGENT_REASONS, type SlaTarget } from '@/lib/config/sla';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

/** A label from a known list, or "Unknown (<value>)" (PWA P13 rule: unknown enum values never crash). */
export function enumLabel(known: readonly string[], prefix: string, value: string | null | undefined, t: Translate): string {
  if (value == null) return '—';
  return known.includes(value) ? t(`${prefix}.${value}` as MessageKey) : t('admin.kit.unknown', { value });
}

export const CASE_STATUSES: readonly ModerationCase['status'][] = ['open', 'investigating', 'escalated', 'action_taken', 'dismissed'];
export const OPEN_CASE_STATUSES: readonly ModerationCase['status'][] = ['open', 'investigating', 'escalated'];
export const CASE_SOURCES: readonly ModerationCase['source'][] = ['user_report', 'ai_flag', 'system_rule', 'admin'];
export const CASE_SEVERITIES: readonly ModerationCase['severity'][] = ['low', 'medium', 'high', 'critical'];
export const CLOSE_STATUSES = ['dismissed', 'action_taken', 'escalated'] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];
export const REPORT_STATUSES: readonly StaffReport['status'][] = ['open', 'triaged', 'resolved', 'dismissed'];
export const MODERATION_REASONS = [
  'fake',
  'abusive',
  'hate_speech',
  'harassment',
  'spam',
  'off_topic',
  'privacy',
  'unsafe_advice',
  'misleading',
  'counterfeit',
  'inaccurate_fitment',
  'wrong_location_or_closed',
  'impersonation',
  'non_consensual_media',
  'consent_issue',
  'redaction_issue',
  'hallucination',
  'other',
] as const satisfies readonly ModerationReason[];

/** Docs/40 ReportTargetType, in the order the filters list them. */
export const TARGET_TYPES = [
  'post',
  'comment',
  'question',
  'answer',
  'portfolio_item',
  'media_asset',
  'review',
  'review_response',
  'inventory_item',
  'inventory_fitment',
  'organization',
  'organization_location',
  'user',
  'ai_output',
] as const satisfies readonly ReportTargetType[];

/** admin.case_close resolution Text<1000>. */
export const CASE_RESOLUTION_MAX = 1000;

/**
 * The console's case queues (AC8.T2, saved views of admin.cases_list by case type). The list filters one case type
 * per call, so a queue of several types reads each type (D-49). Reviews keep their own section (AC7).
 */
export type CaseQueueId = 'content' | 'accounts' | 'ai' | 'inventory' | 'reviews';

export const CASE_QUEUES: Record<CaseQueueId, readonly ReportTargetType[]> = {
  content: ['post', 'comment', 'question', 'answer', 'portfolio_item', 'media_asset', 'review_response'],
  accounts: ['user', 'organization', 'organization_location'],
  ai: ['ai_output'],
  inventory: ['inventory_item', 'inventory_fitment'],
  reviews: ['review'],
};

export function queueOfType(type: string): CaseQueueId {
  for (const [id, types] of Object.entries(CASE_QUEUES) as [CaseQueueId, readonly string[]][]) if (types.includes(type)) return id;
  return 'content';
}

/** The console page that works a case of this type, opened on the case for its purpose (GD-10). */
export function caseHref(caseType: string, caseId: string): string {
  const q = queueOfType(caseType);
  const purpose = `purpose=${encodeURIComponent(`case:${caseId}`)}`;
  if (q === 'reviews') return `/reviews?tab=cases&case=${caseId}&${purpose}`;
  if (q === 'inventory') return `/inventory?case=${caseId}&${purpose}`;
  return `/content?tab=${q}&case=${caseId}&${purpose}`;
}

/**
 * Views of a queue (Docs/23 A-CON-01 tabs Reported / AI flagged / Pending pre-publication review / Unsafe advice /
 * Consent and redaction). The list has no source or reason filter (BR-27), so a view narrows the rows read (D-49).
 */
export const CASE_VIEWS = ['reported', 'ai', 'rule', 'unsafe', 'consent'] as const;
export type CaseView = (typeof CASE_VIEWS)[number];

export function inView(c: Pick<ModerationCase, 'source' | 'reason'>, view: string): boolean {
  switch (view) {
    case 'reported':
      return c.source === 'user_report';
    case 'ai':
      return c.source === 'ai_flag';
    case 'rule':
      return c.source === 'system_rule';
    case 'unsafe':
      return c.reason === 'unsafe_advice';
    case 'consent':
      return (
        c.reason === 'consent_issue' || c.reason === 'redaction_issue' || c.reason === 'non_consensual_media' || c.reason === 'privacy'
      );
    default:
      return true;
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** A safety case (Docs/23 principle 10, §6: unsafe advice, media without consent, private data; and critical cases). */
export const isSafetyCase = (c: Pick<ModerationCase, 'reason' | 'severity'>) => URGENT_REASONS.has(c.reason) || c.severity === 'critical';

/** Queue order: open safety cases first, then by severity, then the oldest first (Docs/23 principle 5). */
export function bySafetyFirst<T extends Pick<ModerationCase, 'reason' | 'severity' | 'created_at' | 'status'>>(rows: readonly T[]): T[] {
  const open = (c: T) => (OPEN_CASE_STATUSES.includes(c.status) ? 1 : 0);
  return [...rows].sort(
    (a, b) =>
      open(b) - open(a) ||
      Number(isSafetyCase(b)) - Number(isSafetyCase(a)) ||
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

/**
 * Docs/23 §6 targets of a case: safety reasons and critical cases 4 hours; reported or AI-flagged reviews 24 hours;
 * inventory and other content 48 hours.
 */
export function caseTarget(c: Pick<ModerationCase, 'reason' | 'severity' | 'case_type'>): SlaTarget {
  if (isSafetyCase(c)) return SLA_TARGETS.reportUrgent;
  if (c.case_type === 'review') return { hours: 24 };
  return queueOfType(c.case_type) === 'inventory' ? SLA_TARGETS.inventory : SLA_TARGETS.reportOther;
}

export function caseDue(c: Pick<ModerationCase, 'created_at' | 'reason' | 'severity' | 'case_type'>, timeZone: string): number {
  return dueAt(Date.parse(c.created_at), caseTarget(c), timeZone);
}

/** The same targets for a report waiting for triage (by its reason and target). */
export function reportDue(r: Pick<StaffReport, 'created_at' | 'reason' | 'target'>, timeZone: string): number {
  return caseDue({ created_at: r.created_at, reason: r.reason, severity: 'low', case_type: r.target.type }, timeZone);
}

/**
 * Severity of a new case from a report (admin.report_triage open_case): Docs/23 A-CON-01 "unsafe_advice,
 * non_consensual_media and privacy cases are at least high". The console proposes high for those and medium otherwise
 * and never offers less than high for them.
 */
export const minSeverity = (reason: string): ModerationCase['severity'] => (URGENT_REASONS.has(reason) ? 'high' : 'low');
export const proposedSeverity = (reason: string): ModerationCase['severity'] => (URGENT_REASONS.has(reason) ? 'high' : 'medium');
export function severityChoices(reason: string): ModerationCase['severity'][] {
  const min = SEVERITY_RANK[minSeverity(reason)]!;
  return CASE_SEVERITIES.filter((s) => SEVERITY_RANK[s]! >= min);
}

// ---------------------------------------------------------------------------------------------------------------
// The case target (admin.case_get target_snapshot).

/** A target snapshot as the backend sends it: its type and id, and the plain fields of that type (never contact data). */
export interface Target {
  type: string;
  id: string;
  /** False when the record is gone (the backend sends { type, id, available: false }). */
  available: boolean;
  data: Readonly<Record<string, unknown>>;
}

export function parseTarget(snapshot: unknown): Target | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.type !== 'string' || typeof s.id !== 'string') return null;
  return { type: s.type, id: s.id, available: s.available !== false, data: s };
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const field = (t: Target | null, key: string): string | null => (t ? str(t.data[key]) : null);

/** Content actions (Docs/40 ModerationActionType) the owning module applies to its record. */
export type ContentAction = 'approve' | 'hide' | 'remove' | 'restore' | 'request_changes' | 'warn_user';
export const CONTENT_ACTIONS: readonly ContentAction[] = ['approve', 'hide', 'remove', 'restore', 'request_changes', 'warn_user'];

/** Every action the console takes through admin.case_action (merge_duplicate waits for BR-08, D-51). */
export type CaseAction = ContentAction | 'suspend_account' | 'reactivate_account' | 'apply_trust_penalty' | 'revoke_badge';

/** Action types of the history (ModerationActionType; unknown values render as "Unknown (…)"). */
export const ACTION_TYPES = [
  'approve',
  'hide',
  'remove',
  'restore',
  'request_changes',
  'warn_user',
  'suspend_account',
  'reactivate_account',
  'verify_organization',
  'reject_verification',
  'merge_duplicate',
  'revoke_badge',
  'apply_trust_penalty',
  'confirm_review_approval',
  'reject_review_approval',
  'request_evidence',
  'correct_location',
  'assist_onboarding',
] as const;

export const ACTION_REASON: Record<CaseAction, ReasonKind> = {
  approve: 'approval',
  hide: 'removal',
  remove: 'removal',
  restore: 'restore',
  request_changes: 'changes_request',
  warn_user: 'warning',
  suspend_account: 'suspension',
  reactivate_account: 'restore',
  apply_trust_penalty: 'trust_penalty',
  revoke_badge: 'badge_revoke',
};

/** Actions that cannot be undone from the console: a second confirmation (Docs/23 §1 principle 7). */
export const IRREVERSIBLE: ReadonlySet<CaseAction> = new Set(['apply_trust_penalty', 'revoke_badge']);

/** Actions the backend makes step up with the security key (admin.case_action AAL3(...)). */
export const STEP_UP_ACTIONS: ReadonlySet<CaseAction> = new Set(['suspend_account', 'apply_trust_penalty']);

/** The review rules (AC7): approve a Path 1 review held back; remove (no hidden state, DI-22); restore; warn. */
export function reviewContentActions(status: string | null, path: string | null): ContentAction[] {
  const out: ContentAction[] = [];
  if (status === 'pending_moderation' && path === 'visit_based') out.push('approve');
  if (status !== 'removed' && status !== 'rejected') out.push('remove');
  if (status === 'removed') out.push('restore');
  out.push('warn_user');
  return out;
}

const COMMUNITY = new Set(['post', 'comment', 'question', 'answer']);
const CONSENT_OK = new Set(['not_required', 'granted']);

/** Why an action is shown but cannot be taken now (the button is disabled with this explanation). */
export type ActionBlock = 'consent_missing';

export interface TargetActions {
  /** Content actions, in button order. */
  content: ContentAction[];
  blocked: Partial<Record<ContentAction, ActionBlock>>;
  /** The target has a person behind it (author, uploader or the account itself): suspend applies to them. */
  suspend: boolean;
  reactivate: boolean;
  /** The target belongs to an organization the backend knows: a trust penalty applies to it. */
  penalty: boolean;
  /** Organization cases: badges of the organization (approve, revoke by id). */
  badges: boolean;
}

const NONE: TargetActions = { content: [], blocked: {}, suspend: false, reactivate: false, penalty: false, badges: false };

/**
 * The actions that apply to a case target in its state (the backend's ModerationTargets per type, S8):
 * community posts, comments and answers can be approved (held for moderation), hidden (kept for review), removed and
 * restored; a question has no removed state (remove = hide); a business reply, a file and an AI output are removed and
 * restored (hide = remove); a showcase item is approved (only with a valid customer consent), sent back for changes,
 * rejected and restored; a listing is approved, hidden, removed, sent back as a draft and restored; a fitment row is
 * rejected and restored. Accounts are warned, suspended and reactivated; organizations get trust penalties and badge
 * decisions. A gone target takes no action (the case can still be closed).
 */
export function targetActions(t: Target | null): TargetActions {
  if (!t || !t.available) return NONE;
  const s = field(t, 'status');
  const m = field(t, 'moderation_status');
  const out: TargetActions = { ...NONE, content: [], blocked: {} };
  const push = (...a: ContentAction[]) => out.content.push(...a);
  if (t.type === 'review') {
    push(...reviewContentActions(s, field(t, 'confirmation_path')));
    return { ...out, suspend: true, penalty: !!field(t, 'subject_organization_id') };
  }
  if (COMMUNITY.has(t.type)) {
    const gone = s === 'hidden' || s === 'removed';
    if (m !== 'approved' && !gone) push('approve');
    if (!gone) push('hide');
    if (t.type !== 'question' && s !== 'removed') push('remove');
    if (gone) push('restore');
    push('warn_user');
    return { ...out, suspend: true };
  }
  switch (t.type) {
    case 'review_response':
      if (s !== 'removed') push('remove');
      else push('restore');
      push('warn_user');
      return { ...out, suspend: true, penalty: true };
    case 'portfolio_item': {
      if (s === 'pending_review') {
        push('approve');
        if (!CONSENT_OK.has(field(t, 'customer_consent_status') ?? '')) out.blocked.approve = 'consent_missing';
      }
      if (s === 'pending_review' || s === 'published') push('request_changes', 'remove');
      if (s === 'rejected') push('restore');
      return { ...out, penalty: true };
    }
    case 'media_asset':
      if (s === 'active' && m !== 'approved') push('approve');
      if (s !== 'removed') push('remove');
      else if (field(t, 'scan_status') === 'clean') push('restore');
      push('warn_user');
      return { ...out, suspend: true, penalty: field(t, 'owner_type') === 'organization' };
    case 'inventory_item':
      if (s === 'pending_review') push('approve');
      if (s === 'active' || s === 'pending_review') push('request_changes');
      if (s === 'active' || s === 'pending_review' || s === 'draft') push('hide');
      if (s !== 'removed') push('remove');
      if (s === 'hidden' || s === 'removed') push('restore');
      return { ...out, penalty: true };
    case 'inventory_fitment':
      if (s !== 'rejected') push('remove');
      else push('restore');
      return { ...out, penalty: true };
    case 'organization':
      return { ...out, penalty: true, badges: true };
    case 'organization_location':
      return { ...out, penalty: true };
    case 'user':
      push('warn_user');
      return { ...out, suspend: s !== 'suspended' && s !== 'deleted', reactivate: s === 'suspended' };
    case 'ai_output':
      if (field(t, 'visibility') !== 'internal') push('remove');
      else push('restore');
      return out;
    default:
      return NONE;
  }
}

/** The organization a target belongs to, when its snapshot names it (for the chip and the penalty text). */
export function targetOrganization(t: Target | null): string | null {
  if (!t) return null;
  if (t.type === 'organization') return t.id;
  return (
    field(t, 'subject_organization_id') ??
    field(t, 'organization_id') ??
    field(t, 'provider_organization_id') ??
    field(t, 'vendor_organization_id') ??
    (field(t, 'owner_type') === 'organization' ? field(t, 'owner_id') : null)
  );
}

/** Message keys of an action on a target: the dialog title, what it does, and the confirmation after it. */
export function actionTexts(type: string, a: CaseAction): { dialog: MessageKey; effect: MessageKey; done: MessageKey } {
  // Reviews keep the AC7 texts (they name the review's own effects).
  if (type === 'review' && (a === 'approve' || a === 'remove' || a === 'restore' || a === 'warn_user'))
    return { dialog: `admin.cases.dialog.${a}`, effect: `admin.cases.effect.${a}`, done: `admin.cases.done.${a}` };
  const effect = ((): MessageKey => {
    if (a === 'hide' || a === 'remove' || a === 'restore' || a === 'approve' || a === 'request_changes') {
      if (a === 'remove' && (type === 'question' || type === 'review_response' || type === 'media_asset' || type === 'ai_output'))
        return `admin.moderation.effect.removeOnly`;
      if (type === 'portfolio_item' && (a === 'remove' || a === 'restore' || a === 'approve' || a === 'request_changes'))
        return `admin.moderation.effect.portfolio.${a}`;
      if (type === 'inventory_fitment') return `admin.moderation.effect.fitment.${a === 'restore' ? 'restore' : 'remove'}`;
      if (type === 'ai_output') return `admin.moderation.effect.ai.${a === 'restore' ? 'restore' : 'remove'}`;
      if (type === 'inventory_item' && a === 'request_changes') return 'admin.moderation.effect.inventory.request_changes';
    }
    return `admin.moderation.effect.${a}`;
  })();
  return { dialog: `admin.moderation.dialog.${a}`, effect, done: `admin.moderation.done.${a}` };
}

/** The noun of a target type for texts ("Remove this post"); unknown types read "item". */
export function thingKey(type: string): MessageKey {
  return (TARGET_TYPES as readonly string[]).includes(type)
    ? (`admin.moderation.thing.${type}` as MessageKey)
    : 'admin.moderation.thing.item';
}

/** A trust penalty: 1-100 points (Docs/40 ModerationActionInput params.trust_penalty_points). */
export const PENALTY_MIN = 1;
export const PENALTY_MAX = 100;
export function penaltyPoints(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= PENALTY_MIN && n <= PENALTY_MAX ? n : null;
}

/** A record id as the contract writes it (UUID); badge ids are typed or pasted by staff (BR-31). */
export const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/** The reason of the self-assignment (admin.case_assign RSN): the button is the reason (D-50). */
export const SELF_ASSIGN_REASON = 'taking_case';
