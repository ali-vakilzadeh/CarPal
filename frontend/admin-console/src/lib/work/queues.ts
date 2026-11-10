// Work queues of "My work" (AC5.T7, Docs/23 §1 principle 5, §6, A-DASH-01 queue counts). Contract 1.3.0 has no count
// or summary operation, so a queue's numbers come from its list operation: up to MAX_PAGES pages of 100 per status
// (SEC-ADM-7), counted in the browser; a longer queue shows "200+" and its oldest item among those read (BR-21 asks
// for a summary read). Each item gets an SLA timer from the console config (OQ-05 default, src/lib/config/sla).
import type {
  DataSubjectRequest,
  ModerationCase,
  OrganizationVerification,
  PendingChange,
  StaffDispute,
  StaffReport,
  StaffReviewApprovalView,
} from '@carpal/api-contracts';
import type { ApiClient, CallRest } from '@/lib/api/client';
import type { AdminOperationId, StaffRole } from '@/lib/api/generated';
import { dueAt, SLA_TARGETS, slaState, URGENT_REASONS, worse, type SlaState } from '@/lib/config/sla';
import { canCall } from '@/lib/roles';

export type QueueId = 'approvals' | 'verification' | 'reviewApproval' | 'reports' | 'cases' | 'disputes' | 'privacy';

export interface Timer {
  start: number;
  due: number;
}

export interface QueueDef {
  id: QueueId;
  opId: AdminOperationId;
  /** One list call per entry (e.g. one per open status); each is paged on its own. */
  queries: readonly Record<string, string>[];
  /** The console page that works the queue. */
  href: string;
  timer: (item: never, timeZone: string) => Timer;
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const INVENTORY_TARGETS: ReadonlySet<string> = new Set(['inventory_item', 'inventory_fitment']);

function def<T>(d: Omit<QueueDef, 'timer'> & { timer: (item: T, timeZone: string) => Timer }): QueueDef {
  return d as unknown as QueueDef;
}

/** The queues in the order My work shows them (most personal first). */
export const QUEUES: readonly QueueDef[] = [
  def<PendingChange>({
    id: 'approvals',
    opId: 'admin.four_eyes_list',
    queries: [{ status: 'pending' }],
    href: '/approvals',
    timer: (c) => ({ start: at(c.requested_at), due: at(c.expires_at) }),
  }),
  def<OrganizationVerification>({
    id: 'verification',
    opId: 'admin.verifications_queue',
    queries: [{ status: 'pending' }],
    href: '/verification',
    timer: (v, tz) => ({ start: at(v.created_at), due: dueAt(at(v.created_at), SLA_TARGETS.verification, tz) }),
  }),
  def<StaffReviewApprovalView>({
    id: 'reviewApproval',
    opId: 'admin.review_approvals_queue',
    queries: [{ stage: 'awaiting_reviewer' }],
    href: '/reviews',
    // Docs/23 §6: 2 working days after the business answered or its deadline passed. The view has no answer time:
    // the deadline when it has passed, else the review's last change (the business answer updates it).
    timer: (r, tz) => {
      const deadline = at(r.business_confirmation_due_at);
      const start = Number.isFinite(deadline) && deadline <= Date.now() ? deadline : at(r.review.updated_at);
      return { start, due: dueAt(start, SLA_TARGETS.reviewApproval, tz) };
    },
  }),
  def<StaffReport>({
    id: 'reports',
    opId: 'admin.reports_list',
    queries: [{ status: 'open' }],
    href: '/content',
    timer: (r, tz) => {
      const target = URGENT_REASONS.has(r.reason)
        ? SLA_TARGETS.reportUrgent
        : INVENTORY_TARGETS.has(r.target.type)
          ? SLA_TARGETS.inventory
          : SLA_TARGETS.reportOther;
      return { start: at(r.created_at), due: dueAt(at(r.created_at), target, tz) };
    },
  }),
  def<ModerationCase>({
    id: 'cases',
    opId: 'admin.cases_list',
    queries: [{ status: 'open' }, { status: 'investigating' }, { status: 'escalated' }],
    href: '/content',
    timer: (c, tz) => {
      const target =
        URGENT_REASONS.has(c.reason) || c.severity === 'critical'
          ? SLA_TARGETS.reportUrgent
          : INVENTORY_TARGETS.has(c.case_type)
            ? SLA_TARGETS.inventory
            : SLA_TARGETS.reportOther;
      return { start: at(c.created_at), due: dueAt(at(c.created_at), target, tz) };
    },
  }),
  def<StaffDispute>({
    id: 'disputes',
    opId: 'admin.disputes_queue',
    queries: [{ status: 'open' }, { status: 'in_mediation' }],
    href: '/disputes',
    timer: (d, tz) => ({ start: at(d.created_at), due: dueAt(at(d.created_at), SLA_TARGETS.dispute, tz) }),
  }),
  def<DataSubjectRequest>({
    id: 'privacy',
    opId: 'admin.dsr_queue',
    queries: [{ status: 'received' }, { status: 'verifying_identity' }, { status: 'in_progress' }],
    href: '/privacy',
    timer: (d) => ({ start: at(d.requested_at), due: at(d.due_at) }),
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

/** Query key of a queue summary (shared by My work and the top bar's My queue). */
export const queueKey = (id: QueueId) => ['work', id] as const;
