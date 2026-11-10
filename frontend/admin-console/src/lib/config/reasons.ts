// Reason codes of the console (AC5.T2, Docs/23 §1 principle 1, GD-11, SEC-ADM-3). Contract 1.3.0 types `reason` as a
// free string (Reason = Str<3,500>); only admin.review_approval_decide has a separate reason_code. The console keeps
// a fixed code list per kind of action here and sends "<code>: <note>" (or the code alone) as the reason, so the
// audit log reads the same whatever the staff member's language is (deviation D-29). The note is required for
// removals, suspensions and rejections (Docs/23 §1), and wherever a code is "other".

export type ReasonKind =
  'approve_change' | 'reject_change' | 'setting_change' | 'approval' | 'rejection' | 'removal' | 'suspension' | 'restore' | 'escalation';

export interface ReasonSet {
  codes: readonly string[];
  /** The note is required whatever code is chosen. */
  noteRequired: boolean;
}

/** Reason codes per kind of action; labels in admin.reasons.codes.<code>. Order = order in the list. */
export const REASON_SETS: Record<ReasonKind, ReasonSet> = {
  approve_change: { codes: ['checked_and_correct', 'planned_change', 'incident_response', 'other'], noteRequired: false },
  reject_change: { codes: ['values_incorrect', 'not_justified', 'wrong_target', 'needs_discussion', 'other'], noteRequired: true },
  setting_change: { codes: ['planned_change', 'incident_response', 'correction', 'pilot_operation', 'other'], noteRequired: false },
  approval: { codes: ['meets_policy', 'evidence_sufficient', 'other'], noteRequired: false },
  rejection: { codes: ['policy_violation', 'evidence_insufficient', 'duplicate', 'other'], noteRequired: true },
  removal: { codes: ['policy_violation', 'safety_risk', 'privacy_violation', 'legal_request', 'duplicate', 'other'], noteRequired: true },
  suspension: { codes: ['repeated_violations', 'fraud', 'safety_risk', 'legal_request', 'other'], noteRequired: true },
  restore: { codes: ['decision_reversed', 'appeal_upheld', 'mistake', 'other'], noteRequired: false },
  escalation: { codes: ['needs_lead', 'needs_admin', 'legal_question', 'other'], noteRequired: false },
};

/** Every code of every set (for the translation check and the parser). */
export const REASON_CODES: readonly string[] = [...new Set(Object.values(REASON_SETS).flatMap((s) => s.codes))];

/** Contract limits of Reason (Docs/40 §3: Str<3,500>). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface ReasonDraft {
  code: string;
  note: string;
}

export const EMPTY_REASON: ReasonDraft = { code: '', note: '' };

export type ReasonProblem = { code?: 'required'; note?: 'required' | 'too_long' };

/** The note may be at most this long once "<code>: " is put in front of it. */
export function noteLimit(code: string): number {
  return REASON_MAX - (code ? code.length + 2 : 0);
}

export function noteRequired(kind: ReasonKind, code: string): boolean {
  return REASON_SETS[kind].noteRequired || code === 'other';
}

/** What is missing or wrong in a reason draft (empty object = ready to send). */
export function checkReason(kind: ReasonKind, draft: ReasonDraft): ReasonProblem {
  const problem: ReasonProblem = {};
  const note = draft.note.trim();
  if (!REASON_SETS[kind].codes.includes(draft.code)) problem.code = 'required';
  if (noteRequired(kind, draft.code) && note.length === 0) problem.note = 'required';
  else if (note.length > noteLimit(draft.code)) problem.note = 'too_long';
  return problem;
}

export function reasonReady(kind: ReasonKind, draft: ReasonDraft): boolean {
  const p = checkReason(kind, draft);
  return !p.code && !p.note;
}

/** The reason as sent: "<code>: <note>" or "<code>" (the note keeps its own language; line breaks become spaces). */
export function composeReason(draft: ReasonDraft): string {
  const note = draft.note.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return note ? `${draft.code}: ${note}` : draft.code;
}

/** A reason the contract accepts (3–500 characters after trimming). The kit sends nothing else (SEC-ADM-3). */
export function isValidReason(reason: unknown): reason is string {
  return typeof reason === 'string' && reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
}

/** Splits a stored reason into a known code and the note, for display ({ code: null } when it has no console code). */
export function parseReason(reason: string): { code: string | null; note: string } {
  const m = /^([a-z_]{3,40})(?::\s*([\s\S]*))?$/.exec(reason.trim());
  if (m && REASON_CODES.includes(m[1]!)) return { code: m[1]!, note: (m[2] ?? '').trim() };
  return { code: null, note: reason };
}
