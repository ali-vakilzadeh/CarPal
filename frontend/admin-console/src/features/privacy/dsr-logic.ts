// Rules of the privacy-request screens (AC10.T4/T5, Docs/23 A-DSR-01/02, Docs/40 §6.5 and §23.5 dsr operations). The
// backend decides every move (backend identity admin-ops DSR_NEXT); the console offers only the moves it accepts so
// no button is dead (GD-08): received -> verifying_identity | rejected; verifying_identity -> in_progress | rejected;
// in_progress -> completed | rejected. A deletion completes only through its execution (admin.dsr_execute_deletion,
// four-eyes); an export can be marked completed only once its file exists (the backend answers export_missing); an
// export file is built (admin.dsr_export) while the request is in progress, for export and deletion requests.
import type { DataSubjectRequest } from '@carpal/api-contracts';
import type { ReasonKind } from '@/lib/config/reasons';

export type DsrRow = DataSubjectRequest & { user_id: string };
export type DsrType = DataSubjectRequest['request_type'];
export type DsrStatus = DataSubjectRequest['status'];
export type DsrMove = 'verifying_identity' | 'in_progress' | 'completed' | 'rejected';

export const DSR_TYPES = ['export', 'deletion', 'rectification', 'consent_withdrawal'] as const;
export const DSR_STATUSES = ['received', 'verifying_identity', 'in_progress', 'completed', 'rejected'] as const;
export const OPEN_DSR_STATUSES: readonly string[] = ['received', 'verifying_identity', 'in_progress'];

/** Queue views of Docs/23 A-DSR-01 on top of the server filters ("due this week" and "overdue" use due_before). */
export const DSR_VIEWS = ['overdue', 'week'] as const;
export type DsrView = (typeof DSR_VIEWS)[number];

/** The rejection text the user reads (Docs/40 dsr_update rejection_reason: Str<1,500>). */
export const DSR_REJECTION_MAX = 500;

const NEXT: Record<string, readonly DsrMove[]> = {
  received: ['verifying_identity', 'rejected'],
  verifying_identity: ['in_progress', 'rejected'],
  in_progress: ['completed', 'rejected'],
};

export function isOpenDsr(r: Pick<DataSubjectRequest, 'status'>): boolean {
  return OPEN_DSR_STATUSES.includes(r.status);
}

/** The status moves the backend accepts for this request (a deletion never "completes" by hand). */
export function dsrMoves(r: Pick<DataSubjectRequest, 'status' | 'request_type'>): DsrMove[] {
  return (NEXT[r.status] ?? []).filter((m) => !(m === 'completed' && r.request_type === 'deletion'));
}

/** An export file can be built for an export or deletion request in progress (identity verified first). */
export function canBuildExport(r: Pick<DataSubjectRequest, 'status' | 'request_type'>): boolean {
  return r.status === 'in_progress' && (r.request_type === 'export' || r.request_type === 'deletion');
}

/** The deletion is run (four-eyes) on a deletion request in progress. */
export function canRunDeletion(r: Pick<DataSubjectRequest, 'status' | 'request_type'>): boolean {
  return r.status === 'in_progress' && r.request_type === 'deletion';
}

/** The reason set of a move (GD-11). */
export const MOVE_REASON: Record<DsrMove, ReasonKind> = {
  verifying_identity: 'dsr_step',
  in_progress: 'dsr_step',
  completed: 'dsr_complete',
  rejected: 'dsr_reject',
};

/** The local calendar date (YYYY-MM-DD) `days` from `now`, for due_before. */
export function dateIn(days: number, now: number, timeZone: string): string {
  const d = new Date(now + days * 86_400_000);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** The server filter of a view: overdue = due before today; this week = due before 7 days from today. */
export function dueBeforeOf(view: string, now: number, timeZone: string): string | undefined {
  if (view === 'overdue') return dateIn(0, now, timeZone);
  if (view === 'week') return dateIn(7, now, timeZone);
  return undefined;
}

/** Rows a view shows: due_before also returns closed requests, which are never overdue. */
export function inDsrView(r: DsrRow, view: string, now: number): boolean {
  if (view === 'overdue') return isOpenDsr(r) && Date.parse(r.due_at) < now;
  if (view === 'week') return isOpenDsr(r);
  return true;
}

/** Most urgent first: open before closed, then the nearest due date. */
export function byDue(a: DsrRow, b: DsrRow): number {
  const open = Number(isOpenDsr(b)) - Number(isOpenDsr(a));
  return open || a.due_at.localeCompare(b.due_at);
}

/** "…a1b2c3" — the user is shown by the end of the id only in the queue (Docs/23 A-DSR-01 "user (masked)"). */
export function shortId(id: string): string {
  return `…${id.replace(/-/g, '').slice(-6)}`;
}
