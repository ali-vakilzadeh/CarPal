// Work queues read from their lists (AC5.T7; since AC13 the numbers of every other queue come from the server,
// admin.work_summary, src/lib/work/summary.ts). Two remain list reads: the changes waiting for the caller's approval,
// whose items My work lists (one page, soonest expiry first), and staff account recoveries, which admin.work_summary does
// not count (D-75, BR-39). The SLA timers of review approvals and disputes are shared with their queue pages.
import type { PendingChange, StaffDispute, StaffRecoveryRequest, StaffReviewApprovalView } from '@carpal/api-contracts';
import type { ApiClient, CallRest } from '@/lib/api/client';
import type { AdminOperationId, StaffRole } from '@/lib/api/generated';
import { dueAt, SLA_TARGETS, slaState, worse, type SlaState } from '@/lib/config/sla';
import { canCall } from '@/lib/roles';

export type ListQueueId = 'approvals' | 'recoveries';

export interface Timer {
  start: number;
  due: number;
}

export interface QueueDef {
  id: ListQueueId;
  opId: AdminOperationId;
  /** One list call per entry (e.g. one per open status); each is paged on its own. */
  queries: readonly Record<string, string>[];
  /** The console page that works the queue. */
  href: string;
  timer: (item: never, timeZone: string) => Timer;
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * The CarPal reviewer's timer of a Path 2 review (Docs/23 §6): 2 working days after the business answered or its
 * 7-day deadline passed. The view has no answer time: the deadline when it has passed, else the review's last change
 * (the business answer updates it). Used by My work and the approval queue (AC7).
 */
export function reviewApprovalTimer(
  r: Pick<StaffReviewApprovalView, 'business_confirmation_due_at' | 'review'>,
  timeZone: string,
  now = Date.now(),
): Timer {
  const deadline = at(r.business_confirmation_due_at);
  const start = Number.isFinite(deadline) && deadline <= now ? deadline : at(r.review.updated_at);
  return { start, due: dueAt(start, SLA_TARGETS.reviewApproval, timeZone) };
}

/** Disputes and appeals: 5 working days from the day it was raised (Docs/23 §6). */
export function disputeTimer(d: Pick<StaffDispute, 'created_at'>, timeZone: string): Timer {
  return { start: at(d.created_at), due: dueAt(at(d.created_at), SLA_TARGETS.dispute, timeZone) };
}

function def<T>(d: Omit<QueueDef, 'timer'> & { timer: (item: T, timeZone: string) => Timer }): QueueDef {
  return d as unknown as QueueDef;
}

/** The queues read from their lists. */
export const QUEUES: readonly QueueDef[] = [
  def<PendingChange>({
    id: 'approvals',
    opId: 'admin.four_eyes_list',
    queries: [{ status: 'pending' }],
    href: '/approvals',
    timer: (c) => ({ start: at(c.requested_at), due: at(c.expires_at) }),
  }),
  // Staff account recoveries waiting for administrators (AC10b): admin.work_summary has no recovery queue (D-75,
  // BR-39). The timer runs from the request to its 24-hour expiry.
  def<StaffRecoveryRequest>({
    id: 'recoveries',
    opId: 'admin.staff_recoveries_list',
    queries: [{ status: 'awaiting_approvals' }],
    href: '/recoveries',
    timer: (r) => ({ start: at(r.requested_at), due: at(r.expires_at) }),
  }),
];

/** The queues a staff member may see (their roles may call the list operation; the server still decides). */
export function queuesFor(roles: readonly StaffRole[]): QueueDef[] {
  return QUEUES.filter((q) => canCall(q.opId, roles));
}

export const MAX_PAGES = 2;
export const PAGE_LIMIT = 100;
/** How many of the most urgent items a summary keeps (My work lists them for approvals). */
export const URGENT_KEEP = 5;

export interface QueueSummary<T = unknown> {
  count: number;
  /** More items exist than were read (count is a lower bound). */
  capped: boolean;
  /** Start of the oldest timer among the items read. */
  oldestStart: number | null;
  /** The worst SLA state among the items read (null when empty). */
  state: SlaState | null;
  /** Items past their target. */
  overdue: number;
  /** The items due soonest, at most URGENT_KEEP. */
  urgent: { item: T; timer: Timer }[];
}

export async function summarizeQueue(
  api: Pick<ApiClient, 'api'>,
  queue: QueueDef,
  o: { now?: number; timeZone: string; signal?: AbortSignal; maxPages?: number },
): Promise<QueueSummary> {
  const now = o.now ?? Date.now();
  const maxPages = o.maxPages ?? MAX_PAGES;
  const items: unknown[] = [];
  let capped = false;
  for (const query of queue.queries) {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const args = { query: { ...query, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, ...(o.signal ? { signal: o.signal } : {}) };
      const res = (await api.api(queue.opId, ...([args] as unknown as CallRest<AdminOperationId>))) as {
        items: unknown[];
        next_cursor: string | null;
      };
      items.push(...res.items);
      cursor = res.next_cursor ?? undefined;
      if (!cursor) break;
      if (page === maxPages - 1) capped = true;
    }
  }
  let state: SlaState | null = null;
  let oldestStart: number | null = null;
  let overdue = 0;
  const timed: { item: unknown; timer: Timer }[] = [];
  for (const item of items) {
    const timer = queue.timer(item as never, o.timeZone);
    if (!Number.isFinite(timer.start) || !Number.isFinite(timer.due)) continue;
    const s = slaState(timer.start, timer.due, now);
    state = state ? worse(state, s) : s;
    if (s === 'breach') overdue += 1;
    oldestStart = oldestStart === null ? timer.start : Math.min(oldestStart, timer.start);
    timed.push({ item, timer });
  }
  timed.sort((a, b) => a.timer.due - b.timer.due);
  return { count: items.length, capped, oldestStart, state, overdue, urgent: timed.slice(0, URGENT_KEEP) };
}

/** Query key of a list-read queue summary. */
export const queueKey = (id: ListQueueId) => ['work', id] as const;
