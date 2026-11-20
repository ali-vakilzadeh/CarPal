'use client';
// Work queue numbers from the server (AC13.T6, backend S21 admin.work_summary, BR-22; replaces the browser paging of
// AC5, D-32): per queue the caller's roles may read, the open count, the items assigned to the caller, the oldest
// item, the next target and the items per SLA state (the server's clock and working days). One query for the whole
// console (the dashboard, My queue in the top bar), read again every minute while the page is visible.
import type { WorkQueueKey, WorkQueueSummary } from '@carpal/api-contracts';
import { useApiQuery, useSession } from '@/lib/api/query';
import type { SlaState } from '@/lib/config/sla';
import { canCall } from '@/lib/roles';

export const WORK_REFRESH_MS = 60_000;

/** A tile of the dashboard: the server's queues plus staff account recoveries (counted from their list, D-75, BR-39). */
export type QueueId =
  | 'approvals'
  | 'recoveries'
  | 'verification'
  | 'reviewApproval'
  | 'reports'
  | 'cases'
  | 'disputes'
  | 'privacy'
  | 'badges'
  | 'planRequests'
  | 'support';

/** Each server queue's tile and the page that works it (null: no console page yet — badges, plan requests, support). */
export const WORK_QUEUES: Record<WorkQueueKey, { id: QueueId; href: string | null }> = {
  four_eyes: { id: 'approvals', href: '/approvals' },
  verifications: { id: 'verification', href: '/verification' },
  review_approvals: { id: 'reviewApproval', href: '/reviews' },
  reports: { id: 'reports', href: '/content' },
  cases: { id: 'cases', href: '/content' },
  disputes: { id: 'disputes', href: '/disputes' },
  privacy_requests: { id: 'privacy', href: '/privacy' },
  badge_approvals: { id: 'badges', href: null },
  subscription_change_requests: { id: 'planRequests', href: null },
  support_tickets: { id: 'support', href: '/support' },
};

/** The tile of a queue key, or null for a key this console does not know (shown as unknown). */
export function workQueue(key: string): { id: QueueId; href: string | null } | null {
  return Object.hasOwn(WORK_QUEUES, key) ? WORK_QUEUES[key as WorkQueueKey] : null;
}

/** The worst SLA state of a queue's open items (null: no target, or nothing whose clock runs). */
export function slaOf(sla: WorkQueueSummary['sla']): SlaState | null {
  if (!sla) return null;
  if (sla.breach > 0) return 'breach';
  if (sla.warn > 0) return 'warn';
  if (sla.ok > 0) return 'ok';
  return null;
}

/** Open items of a queue's breakdown key (e.g. "reason:unsafe_advice"), 0 when absent. */
export function breakdownCount(q: WorkQueueSummary | undefined, key: string): number {
  return q?.breakdown.find((b) => b.key === key)?.open ?? 0;
}

export function useWorkSummary() {
  const session = useSession();
  const allowed = canCall('admin.work_summary', session.data?.staff?.roles ?? []);
  return useApiQuery('admin.work_summary', { background: true }, { enabled: allowed, refetchInterval: WORK_REFRESH_MS, staleTime: 30_000 });
}
