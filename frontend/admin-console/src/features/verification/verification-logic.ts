// Rules of the verification screens (AC9.T4, Docs/23 A-VER-01/02, Docs/40 admin.verifications_queue and
// admin.verification_decide, Docs/54 §4). An organization is verified (and the Verified Business badge becomes
// possible) only when its business identity and a location are verified; a location or address check cannot be
// approved while a pin is far from its typed address (the backend answers INVALID_TRANSITION far_apart). The checklist
// of Docs/23 is the staff member's own: the contract has no field for it, so its state travels at the end of the
// audited reason (D-60). "Request more info" has no operation in the contract (DI-30): not offered.
import type { AdminResponse } from '@/lib/api/generated';
import { dueAt, SLA_TARGETS } from '@/lib/config/sla';
import { REASON_MAX } from '@/lib/config/reasons';
import type { CheckType } from '../orgs/org-logic';

export type QueueItem = AdminResponse<'admin.verifications_queue'>['items'][number];

export const CHECKLIST = [
  'details_match',
  'address_matches_pin',
  'contact_verified',
  'taxonomy_consistent',
  'no_duplicate',
  'reports_checked',
] as const;
export type ChecklistItem = (typeof CHECKLIST)[number];

/** The Docs/23 checklist items that apply to a kind of check (certifications are not a check type in contract 1.3.0). */
export function checklistFor(type: CheckType | string): ChecklistItem[] {
  switch (type) {
    case 'business_identity':
      return ['details_match', 'contact_verified', 'taxonomy_consistent', 'no_duplicate'];
    case 'address':
    case 'location':
      return ['address_matches_pin', 'reports_checked'];
    case 'phone':
    case 'email':
      return ['contact_verified'];
    default:
      return ['details_match'];
  }
}

export const isLocationCheck = (type: string) => type === 'location' || type === 'address';

export type ApproveBlock = 'far_apart' | 'checklist' | 'not_pending' | null;

/** Why Approve is not possible now (null = it is). */
export function approveBlock(o: { status: string; type: string; farApart: boolean; ticked: readonly string[] }): ApproveBlock {
  if (o.status !== 'pending') return 'not_pending';
  if (isLocationCheck(o.type) && o.farApart) return 'far_apart';
  if (checklistFor(o.type).some((c) => !o.ticked.includes(c))) return 'checklist';
  return null;
}

/**
 * The reason as sent with the checklist state at its end: "<code>: <note> [checklist: a, b]". The note is cut (with
 * "…") when both together pass the contract's 500 characters, so the checklist is never lost.
 */
export function withChecklist(reason: string, ticked: readonly string[]): string {
  const suffix = ` [checklist: ${ticked.length ? ticked.join(', ') : 'none'}]`;
  if (reason.length + suffix.length <= REASON_MAX) return `${reason}${suffix}`;
  return `${reason.slice(0, REASON_MAX - suffix.length - 1).trimEnd()}…${suffix}`;
}

/** The SLA timer of a check: 2 working days from submission (Docs/23 §6, OQ-05 default). */
export function verificationTimer(v: { created_at: string }, timeZone: string): { start: number; due: number } {
  const start = Date.parse(v.created_at);
  return { start, due: dueAt(start, SLA_TARGETS.verification, timeZone) };
}

/** Oldest first (the queue's own order is by id). */
export function oldestFirst<T extends { created_at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The rejection message the organization reads: 1–500 characters after trimming. */
export function rejectionProblem(text: string): 'required' | 'too_long' | null {
  const s = text.trim();
  if (!s) return 'required';
  return s.length > 500 ? 'too_long' : null;
}
