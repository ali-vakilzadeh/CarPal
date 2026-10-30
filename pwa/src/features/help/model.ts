// W-HELP-01 view model (P10.T1-T3; Docs/55 §4-§7, Docs/22 W-HELP-01, Docs/40 §16 and §21.2). Pure functions:
//   - the case: what one Help Me run (or one request without triage) holds in this browser — the triage session, the
//     chosen category, the provider and, once sent, the appointment;
//   - the steps and their order (Describe → Questions → Safety → Recommendations → Request → Done; a request opened
//     from a profile, the map, search or favourites has only Request → Done);
//   - urgency: the user's own choice, the triage's level and the server's safety block, the highest wins — the server
//     safety block can raise but never lower it (Docs/55 §5.2, SEC-AI-7);
//   - the request: the 14-day slot grid, up to 3 preferred windows (slots, or a day and part of the day when the shop
//     publishes no slots: "Request anyway", BA-19; appointments/times.ts), the AppointmentCreate body and what each
//     failure means.
import type {
  AppointmentCreate,
  AppointmentSource,
  AppointmentType,
  NotificationChannel,
  ResultCard,
  SafetyBlock,
  ServiceMode,
  TimeWindowInput,
  TriageSession,
  UrgencyLevel,
} from '@carpal/api-contracts';
import { ApiProblem } from '@/lib/api/problem';

// ---------------------------------------------------------------- steps

export const HELP_STEPS = ['describe', 'questions', 'safety', 'recommendations', 'request', 'done'] as const;
export type HelpStep = (typeof HELP_STEPS)[number];
/** A request without Help Me (profile, map, search, favourites): Docs/55 §4.9. */
export const DIRECT_STEPS = ['request', 'done'] as const satisfies readonly HelpStep[];

export function isHelpStep(v: string | null | undefined): v is HelpStep {
  return (HELP_STEPS as readonly string[]).includes(v ?? '');
}

export function stepsOf(c: Pick<HelpCase, 'kind'>): readonly HelpStep[] {
  return c.kind === 'direct' ? DIRECT_STEPS : HELP_STEPS;
}

export const helpPath = (locale: string, caseId: string, step: HelpStep) => `/${locale}/help/${caseId}/${step}`;

// ---------------------------------------------------------------- the case

/** Symptom shortcuts of C-HELP-01 (the same keys as the onboarding's Help Me draft, cp:help-draft). */
export const SYMPTOM_KEYS = ['light', 'noise', 'brakes', 'vibration', 'overheating', 'start', 'ac', 'suspension', 'leak', 'smell'] as const;
export type SymptomKey = (typeof SYMPTOM_KEYS)[number];

export function isSymptomKey(v: unknown): v is SymptomKey {
  return typeof v === 'string' && (SYMPTOM_KEYS as readonly string[]).includes(v);
}

/** The urgency selector of C-HELP-03. */
export const URGENCY_CHOICES = ['ok', 'soon', 'urgent', 'unsafe'] as const;
export type UrgencyChoice = (typeof URGENCY_CHOICES)[number];

export const CHOICE_LEVEL: Record<UrgencyChoice, UrgencyLevel> = { ok: 'low', soon: 'medium', urgent: 'high', unsafe: 'safety_critical' };

export type CaseSafety = SafetyBlock & { do_not_drive?: boolean };

/** Where a request comes from (Docs/55 §4.9 request source). */
export type RequestVia = 'help' | 'profile' | 'search' | 'saved';

export interface CaseProvider {
  orgId: string;
  slug: string | null;
  name: string | null;
  locationId: string | null;
  /** A slot picked on the profile (ISO start). */
  slot: string | null;
  /** The result of the caller's own search or match session that ranked this provider. */
  resultId: string | null;
  via: RequestVia;
}

export interface HelpCase {
  id: string;
  createdAt: number;
  updatedAt: number;
  kind: 'help' | 'direct';
  /** The step shown last (Continue your case). */
  step: HelpStep;
  vehicleId: string | null;
  /** An open garage issue this case is about (from W-GAR-01 "Get help"). */
  issueId: string | null;
  text: string;
  symptoms: SymptomKey[];
  urgency: UrgencyChoice | null;
  /** Photos and videos of the problem (purpose issue_photo), ready assets only. */
  mediaIds: string[];
  triageId: string | null;
  /** AI was unavailable (503 AI_UNAVAILABLE or the flag off): the category picker path (GD-13). */
  aiOff: boolean;
  /** The latest safety block: the triage's, the 503 body's or safety.check's. */
  safety: CaseSafety | null;
  /** "I understand the risk and want to see normal results" (C-HELP-05). */
  ack: boolean;
  category: { id: string; label: string } | null;
  /** A chosen pilot city; a browser position is never stored (TR-7 spirit). */
  city: string | null;
  /** The triage's match session or the category search behind the recommendations. */
  matchSessionId: string | null;
  /** What the match was made for (category, location): an equal key shows it again (actions.ts matchKey). */
  matchKey: string | null;
  provider: CaseProvider | null;
  /** The draft made for "Preview what the shop receives" (appointments.create submit=false). */
  draft: { id: string; version: number; share: boolean; providerId: string; vehicleId: string; source: AppointmentSource } | null;
  appointmentId: string | null;
}

export function newCase(id: string, o: Partial<Omit<HelpCase, 'id'>> = {}, now = Date.now()): HelpCase {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    kind: 'help',
    step: 'describe',
    vehicleId: null,
    issueId: null,
    text: '',
    symptoms: [],
    urgency: null,
    mediaIds: [],
    triageId: null,
    aiOff: false,
    safety: null,
    ack: false,
    category: null,
    city: null,
    matchSessionId: null,
    matchKey: null,
    provider: null,
    draft: null,
    appointmentId: null,
    ...o,
  };
}

// ---------------------------------------------------------------- entry links

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
const id = (v: string | null) => (v && ID.test(v) ? v.toLowerCase() : null);

export interface Entry {
  provider: Omit<CaseProvider, 'name' | 'resultId'> | null;
  vehicleId: string | null;
  issueId: string | null;
  urgent: boolean;
}

/**
 * /<locale>/help?… as the earlier stages link to it: provider + location + slot + shop (slug) + via from profiles,
 * search, the map and favourites (P5/P6/P8), vehicle + issue from the garage (P7), urgent=1 from the safety banners.
 * Only ids, a slug, an ISO time and enumerations — never text (GD-14).
 */
export function parseEntry(q: URLSearchParams): Entry {
  const orgId = id(q.get('provider'));
  const slot = q.get('slot');
  const slug = q.get('shop');
  const via = q.get('via');
  return {
    provider: orgId
      ? {
          orgId,
          slug: slug && SLUG.test(slug) ? slug : null,
          locationId: id(q.get('location')),
          slot: slot && !Number.isNaN(Date.parse(slot)) && /^\d{4}-\d{2}-\d{2}T/.test(slot) ? new Date(slot).toISOString() : null,
          via: via === 'profile' || via === 'saved' || via === 'search' ? via : 'search',
        }
      : null,
    vehicleId: id(q.get('vehicle')),
    issueId: id(q.get('issue')),
    urgent: q.get('urgent') === '1',
  };
}

// ---------------------------------------------------------------- urgency and safety

export const LEVEL_ORDER: readonly UrgencyLevel[] = ['low', 'medium', 'high', 'safety_critical'];

export function maxLevel(...levels: (UrgencyLevel | null | undefined)[]): UrgencyLevel | null {
  let best: UrgencyLevel | null = null;
  for (const l of levels) if (l && (best === null || LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(best))) best = l;
  return best;
}

/** The lowest level the server's safety block allows: do-not-drive is critical, urgent is high, a warning medium. */
export function safetyLevel(s: CaseSafety | null | undefined): UrgencyLevel | null {
  if (!s) return null;
  if (s.do_not_drive) return 'safety_critical';
  if (s.level === 'urgent') return 'high';
  if (s.level === 'warning' || s.flag) return 'medium';
  return null;
}

/** The case's urgency: the highest of the user's choice, the triage and the server safety block (default medium). */
export function caseLevel(
  c: Pick<HelpCase, 'urgency' | 'safety'>,
  triage?: Pick<TriageSession, 'urgency_level' | 'status'> | null,
): UrgencyLevel {
  return (
    maxLevel(
      c.urgency ? CHOICE_LEVEL[c.urgency] : null,
      triage?.urgency_level,
      triage?.status === 'escalated_safety' ? 'safety_critical' : null,
      safetyLevel(c.safety),
    ) ?? 'medium'
  );
}

/** Safety-critical interrupts the flow (Docs/55 §4.5): the user said unsafe, the triage escalated or do-not-drive. */
export function isCritical(level: UrgencyLevel): boolean {
  return level === 'safety_critical';
}

/** Where the wizard goes after the description (Docs/55 §5.1): critical → Safety; a question → Questions; else Safety. */
export function stepAfterStart(level: UrgencyLevel, session: Pick<TriageSession, 'next_question'> | null): HelpStep {
  if (isCritical(level)) return 'safety';
  return session?.next_question ? 'questions' : 'safety';
}

// ---------------------------------------------------------------- triage

/** Help Me asks at most 5 questions (Docs/55 §7 rule 1). */
export const MAX_QUESTIONS = 5;
/** 52 Appointment.description and "Input too short" (C-HELP-03): at least 10 characters. */
export const MIN_DESCRIPTION = 10;
export const MAX_TRIAGE_TEXT = 2000;

/** The text triage.start receives: the user's words plus the chosen symptom shortcuts in the UI language. */
export function composeText(text: string, symptomLabels: readonly string[]): string {
  const parts = [text.trim(), symptomLabels.length ? symptomLabels.join('، ') : ''].filter(Boolean);
  return [...parts.join('\n')].slice(0, MAX_TRIAGE_TEXT).join('');
}

export function tooShort(text: string): boolean {
  return [...text.trim()].length < MIN_DESCRIPTION;
}

/** The user's first turn: what they described. */
export function descriptionOf(s: Pick<TriageSession, 'turns'>): string {
  return s.turns.find((x) => x.role === 'user')?.text ?? '';
}

/** Each later user turn with the assistant turn before it: the questions answered so far. */
export function answersOf(s: Pick<TriageSession, 'turns'>): { question: string; answer: string; index: number }[] {
  const out: { question: string; answer: string; index: number }[] = [];
  let firstUserSeen = false;
  s.turns.forEach((turn, i) => {
    if (turn.role !== 'user') return;
    if (!firstUserSeen) {
      firstUserSeen = true;
      return;
    }
    const prev = s.turns[i - 1];
    out.push({ question: prev?.role === 'assistant' ? prev.text : '', answer: turn.text, index: out.length });
  });
  return out;
}

/** The user texts to replay when an answer is edited (Docs/22 "editing reruns from that point"). */
export function replayTexts(s: Pick<TriageSession, 'turns'>, editIndex: number, edited: string): { start: string; replies: string[] } {
  const answers = answersOf(s).map((a) => a.answer);
  return { start: descriptionOf(s), replies: [...answers.slice(0, editIndex), edited] };
}

/** Docs/55 §5.3: one likely area = high, several = medium, none = low (general inspection). */
export function confidenceOf(s: Pick<TriageSession, 'likely_systems'>): 'high' | 'medium' | 'low' {
  if (s.likely_systems.length === 0) return 'low';
  return s.likely_systems.length === 1 ? 'high' : 'medium';
}

/** The service system a request names: the user's category choice, else the triage's most likely system. */
export function serviceSystemOf(c: Pick<HelpCase, 'category'>, s: Pick<TriageSession, 'likely_systems'> | null): string | null {
  return c.category?.id ?? s?.likely_systems[0]?.node_id ?? null;
}

// ---------------------------------------------------------------- recommendations

export const RECOMMENDED = 3;

/**
 * The 3 recommended providers and the rest of the first page. Safety-critical issues put shops that are open now or
 * have the soonest opening first (Docs/55 §4.6 "urgent providers shown first"); otherwise the session's ranking.
 */
export function recommended(results: readonly ResultCard[], critical: boolean): { top: ResultCard[]; more: ResultCard[] } {
  const providers = results.filter((r) => r.target.type === 'organization' && r.organization.roles.includes('provider'));
  const order = critical
    ? [...providers].sort((a, b) => urgentScore(a) - urgentScore(b) || a.rank - b.rank)
    : [...providers].sort((a, b) => a.rank - b.rank);
  return { top: order.slice(0, RECOMMENDED), more: order.slice(RECOMMENDED) };
}

function urgentScore(r: ResultCard): number {
  if (r.open_now === true) return 0;
  if (r.next_available_slot) return 1 + Date.parse(r.next_available_slot) / 1e15;
  return 3;
}

// ---------------------------------------------------------------- request: body

export const APPOINTMENT_TYPES = [
  'diagnosis',
  'repair',
  'inspection',
  'bodywork_estimate',
  'parts_installation',
] as const satisfies readonly AppointmentType[];
export const CONTACT_CHANNELS = ['in_app', 'email', 'sms'] as const satisfies readonly NotificationChannel[];

/** In the shop first when it is offered (service_mode must be one the provider offers). */
export function defaultMode(modes: readonly ServiceMode[]): ServiceMode {
  return modes.includes('in_shop') ? 'in_shop' : (modes[0] ?? 'in_shop');
}

/** Docs/55 §4.9: Help Me = ai_match (it needs a service system), profiles and showcases = review_profile, else direct_search. */
export function sourceOf(c: Pick<HelpCase, 'kind' | 'provider'>, serviceSystemId: string | null): AppointmentSource {
  if (c.kind === 'help') return serviceSystemId ? 'ai_match' : 'direct_search';
  return c.provider?.via === 'profile' ? 'review_profile' : 'direct_search';
}

export interface RequestForm {
  vehicleId: string | null;
  description: string;
  categoryId: string | null;
  appointmentType: AppointmentType;
  serviceMode: ServiceMode;
  urgency: UrgencyLevel;
  note: string;
  channel: NotificationChannel;
  share: boolean;
  includeMedia: boolean;
  mediaIds: readonly string[];
  windows: readonly TimeWindowInput[];
}

export type FormError = 'vehicle' | 'description' | 'times';

/** What keeps the request from being sent (times only matter when sending, not for the preview draft). */
export function formErrors(f: RequestForm, submit: boolean): FormError[] {
  const out: FormError[] = [];
  if (!f.vehicleId) out.push('vehicle');
  if (tooShort(f.description)) out.push('description');
  if (submit && f.windows.length === 0) out.push('times');
  return out;
}

export function createBody(
  c: HelpCase,
  f: RequestForm,
  o: { locale: 'en' | 'fa'; policyVersion: string; triage: TriageSession | null; submit: boolean },
): AppointmentCreate {
  const system = f.categoryId ?? serviceSystemOf(c, o.triage);
  const triageDone = o.triage?.status === 'completed' ? o.triage : null;
  const issueId = c.issueId ?? triageDone?.issue_id ?? null;
  const body: AppointmentCreate = {
    provider_organization_id: c.provider!.orgId,
    vehicle_id: f.vehicleId!,
    source: sourceOf(c, system),
    appointment_type: f.appointmentType,
    service_mode: f.serviceMode,
    description: [...f.description.trim()].slice(0, 3000).join(''),
    content_locale: o.locale,
    urgency_level: f.urgency,
    preferred_contact_channel: f.channel,
    time_windows: [...f.windows],
    submit: o.submit,
  };
  if (c.provider!.locationId) body.provider_location_id = c.provider!.locationId;
  if (c.provider!.resultId) body.match_result_id = c.provider!.resultId;
  if (issueId) body.related_issue_id = issueId;
  if (triageDone) {
    body.triage_session_id = triageDone.id;
    if (triageDone.symptoms[0]) body.symptom_node_id = triageDone.symptoms[0].node_id;
    if (triageDone.recommended_service) body.service_task_node_id = triageDone.recommended_service.node_id;
  }
  if (system) body.service_system_node_id = system;
  if (f.note.trim()) body.customer_expectations = [...f.note.trim()].slice(0, 1000).join('');
  if (f.share) body.share_history = { policy_version: o.policyVersion };
  if (f.includeMedia && f.mediaIds.length) body.media_ids = [...new Set(f.mediaIds)].slice(0, 10);
  return body;
}

/** A preview draft can be reused for sending while its fixed parts (set only at creation) are unchanged. */
export function draftMatches(
  d: HelpCase['draft'],
  b: Pick<AppointmentCreate, 'provider_organization_id' | 'vehicle_id' | 'source'> & { share: boolean },
): boolean {
  return !!d && d.providerId === b.provider_organization_id && d.vehicleId === b.vehicle_id && d.share === b.share && d.source === b.source;
}

export type RequestFailure =
  'caps' | 'contact' | 'times' | 'description' | 'mode' | 'provider' | 'vehicle' | 'capacity' | 'stale' | 'network' | 'error';

/** What a failed send means for the user (Docs/55 §4.7 states; BA-19 caps in one message, never retried). */
export function requestFailure(err: unknown): RequestFailure {
  if (!(err instanceof ApiProblem)) return 'error';
  if (err.status === 429 || err.code === 'RATE_LIMITED') return 'caps';
  if (err.code === 'VERIFIED_CONTACT_REQUIRED') return 'contact';
  if (err.code === 'CAPACITY_UNAVAILABLE') return 'capacity';
  if (err.code === 'NETWORK' || err.code === 'PAUSED' || err.status >= 502) return 'network';
  if (err.status === 412 || err.code === 'VERSION_MISMATCH' || err.code === 'INVALID_TRANSITION') return 'stale';
  const at = (p: string) => err.fields.some((f) => f.pointer === p || f.pointer.startsWith(`${p}/`));
  if (at('/time_windows')) return 'times';
  if (at('/description')) return 'description';
  if (at('/service_mode')) return 'mode';
  if (at('/provider_organization_id') || at('/provider_location_id')) return 'provider';
  if (at('/vehicle_id')) return 'vehicle';
  return 'error';
}
