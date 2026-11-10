// AC5.T7 unit tests: which queues a role sees, and how a queue summary is counted from its list operation (pages of
// 100, a cap of two pages per status, SLA state of the most urgent item, the soonest-due items first).
import { describe, expect, it } from 'vitest';
import type { AdminOperationId } from '@/lib/api/generated';
import { QUEUES, queuesFor, summarizeQueue, MAX_PAGES } from './queues';

const H = 3_600_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function fakeApi(pages: Record<string, { items: unknown[]; next_cursor: string | null }[]>) {
  const calls: { opId: string; query: Record<string, unknown> }[] = [];
  return {
    calls,
    api: {
      api: (async (opId: AdminOperationId, args: { query: Record<string, unknown> }) => {
        calls.push({ opId, query: args.query });
        const key = `${String(args.query.status ?? args.query.stage)}`;
        const list = pages[key] ?? [{ items: [], next_cursor: null }];
        const index = args.query.cursor ? Number(String(args.query.cursor).slice(1)) : 0;
        return list[index] ?? { items: [], next_cursor: null };
      }) as never,
    },
  };
}

describe('queues per role (GD-09)', () => {
  it('shows each role the queues its list operations allow', () => {
    expect(queuesFor(['ADM']).map((q) => q.id)).toEqual(['approvals', 'verification', 'cases', 'privacy']);
    expect(queuesFor(['MOD']).map((q) => q.id)).toEqual(['approvals', 'verification', 'reviewApproval', 'reports', 'cases', 'disputes']);
    expect(queuesFor(['SUP']).map((q) => q.id)).toEqual(['reports', 'privacy']);
    expect(queuesFor(['CRV']).map((q) => q.id)).toEqual(['reviewApproval', 'disputes']);
  });
});

describe('summarizeQueue', () => {
  const reports = QUEUES.find((q) => q.id === 'reports')!;

  it('counts open reports, finds the oldest and the worst SLA state (4 h for unsafe advice)', async () => {
    const { api, calls } = fakeApi({
      open: [
        {
          items: [
            { id: 'r1', reason: 'spam', target: { type: 'review', id: 'x' }, created_at: iso(NOW - 2 * H) },
            { id: 'r2', reason: 'unsafe_advice', target: { type: 'post', id: 'y' }, created_at: iso(NOW - 5 * H) },
            { id: 'r3', reason: 'spam', target: { type: 'inventory_item', id: 'z' }, created_at: iso(NOW - 40 * H) },
          ],
          next_cursor: null,
        },
      ],
    });
    const s = await summarizeQueue(api, reports, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(calls).toEqual([{ opId: 'admin.reports_list', query: { status: 'open', limit: 100 } }]);
    expect(s.count).toBe(3);
    expect(s.capped).toBe(false);
    expect(s.oldestStart).toBe(NOW - 40 * H);
    expect(s.state).toBe('breach');
    expect(s.overdue).toBe(1);
    expect((s.urgent[0]!.item as { id: string }).id).toBe('r2');
  });

  it('reads at most two pages per status and marks the count as a lower bound', async () => {
    const item = (n: number) => ({ id: `c${n}`, reason: 'spam', severity: 'low', case_type: 'review', created_at: iso(NOW - n * H) });
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => item(from + i));
    const { api, calls } = fakeApi({
      open: [
        { items: full(0), next_cursor: 'p1' },
        { items: full(100), next_cursor: 'p2' },
      ],
      investigating: [{ items: [item(1)], next_cursor: null }],
    });
    const cases = QUEUES.find((q) => q.id === 'cases')!;
    const s = await summarizeQueue(api, cases, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(calls.filter((c) => c.query.status === 'open')).toHaveLength(MAX_PAGES);
    expect(calls.map((c) => c.query.status)).toEqual(['open', 'open', 'investigating', 'escalated']);
    expect(s.count).toBe(201);
    expect(s.capped).toBe(true);
  });

  it('times privacy requests by their own due date and approvals by their expiry', async () => {
    const privacy = QUEUES.find((q) => q.id === 'privacy')!;
    const { api } = fakeApi({
      received: [{ items: [{ id: 'd1', requested_at: iso(NOW - 20 * 24 * H), due_at: iso(NOW + 2 * 24 * H) }], next_cursor: null }],
    });
    const s = await summarizeQueue(api, privacy, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(s.count).toBe(1);
    expect(s.state).toBe('warn');

    const approvals = QUEUES.find((q) => q.id === 'approvals')!;
    const a = fakeApi({
      pending: [
        {
          items: [
            { change_id: 'c1', requested_at: iso(NOW - 1 * H), expires_at: iso(NOW + 71 * H) },
            { change_id: 'c2', requested_at: iso(NOW - 70 * H), expires_at: iso(NOW + 2 * H) },
          ],
          next_cursor: null,
        },
      ],
    });
    const sa = await summarizeQueue(a.api, approvals, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(sa.state).toBe('warn');
    expect(sa.urgent.map((u) => (u.item as { change_id: string }).change_id)).toEqual(['c2', 'c1']);
  });

  it('an empty queue has no state', async () => {
    const { api } = fakeApi({});
    const s = await summarizeQueue(api, reports, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(s).toMatchObject({ count: 0, capped: false, oldestStart: null, state: null, overdue: 0, urgent: [] });
  });
});
