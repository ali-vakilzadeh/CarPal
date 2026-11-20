// Rules of the Recovery requests queue (AC10b.T4, SEC-ADM-2, backend S16b): two different administrators approve a
// staff account recovery after checking the requester outside CarPal (a call to a known number, in person, a video
// call, or another way described in a note); one rejection ends it. Never the requester, never twice by the same
// administrator, never by an administrator under the 72-hour post-recovery restriction (the server decides).
import type { StaffRecoveryRequest } from '@carpal/api-contracts';
import type { StaffRole } from '@/lib/api/generated';

export const RECOVERY_STATUSES = ['awaiting_approvals', 'approved', 'rejected', 'expired', 'completed'] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const VERIFICATION_METHODS = ['phone_known_number', 'in_person', 'video_call', 'other'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** Two approvals by different administrators make a request approved (Docs/40 StaffRecoveryStatus). */
export const APPROVALS_NEEDED = 2;
export const METHOD_NOTE_MAX = 500;

const ROLE_CODE: Record<string, StaffRole> = {
  platform_admin: 'ADM',
  platform_moderator: 'MOD',
  platform_support: 'SUP',
  platform_community_reviewer: 'CRV',
};

/** The requester's platform roles as the console's role codes (unknown ones are left out). */
export function roleCodes(roles: readonly string[]): StaffRole[] {
  return roles.map((r) => ROLE_CODE[r]).filter((r): r is StaffRole => !!r);
}

export function isRecoveryStatus(s: string): s is RecoveryStatus {
  return (RECOVERY_STATUSES as readonly string[]).includes(s);
}

/** What the caller may still do with the request (the server checks again). */
export function recoveryActions(r: Pick<StaffRecoveryRequest, 'status' | 'approved_by_me'>): { approve: boolean; reject: boolean } {
  return {
    approve: r.status === 'awaiting_approvals' && !r.approved_by_me,
    reject: r.status === 'awaiting_approvals' || r.status === 'approved',
  };
}

export interface ApproveDraft {
  method: VerificationMethod | '';
  note: string;
}

export type ApproveProblem = { method?: 'required'; note?: 'required' | 'too_long' };

export function checkApprove(d: ApproveDraft): ApproveProblem {
  const p: ApproveProblem = {};
  const note = d.note.trim();
  if (!d.method) p.method = 'required';
  if (d.method === 'other' && !note) p.note = 'required';
  else if (note.length > METHOD_NOTE_MAX) p.note = 'too_long';
  return p;
}

/** The body of admin.staff_recovery_approve (the note only when one was written). */
export function approveBody(d: ApproveDraft, reason: string) {
  const note = d.note.trim();
  return {
    reason,
    verification_method: d.method as VerificationMethod,
    ...(note ? { note } : {}),
  };
}
