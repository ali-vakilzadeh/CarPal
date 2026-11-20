// Unit tests of the work queues: the two queues still read from their lists (AC5.T7, AC10b; the others come from
// admin.work_summary since AC13) and the server summary helpers (SLA state from the server's buckets, breakdowns,
// unknown queue keys).
import { describe, expect, it } from 'vitest';
import type { AdminOperationId } from '@/lib/api/generated';
import { QUEUES, queuesFor, summarizeQueue, MAX_PAGES } from './queues';
import { breakdownCount, slaOf, workQueue } from './summary';

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

describe('list-read queues per role (GD-09)', () => {
  it('approvals for staff who decide four-eyes changes, recoveries for administrators', () => {
    expect(queuesFor(['ADM']).map((q) => q.id)).toEqual(['approvals', 'recoveries']);
    expect(queuesFor(['MOD']).map((q) => q.id)).toEqual(['approvals']);
    expect(queuesFor(['SUP']).map((q) => q.id)).toEqual([]);
    expect(queuesFor(['CRV']).map((q) => q.id)).toEqual([]);
  });
});

describe('summarizeQueue', () => {
  const approvals = QUEUES.find((q) => q.id === 'approvals')!;
  const recoveries = QUEUES.find((q) => q.id === 'recoveries')!;

  it('times approvals by their expiry, soonest first', async () => {
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
    const sa = await summarizeQueue(a.api, approvals, { now: NOW, timeZone: 'Asia/Tehran', maxPages: 1 });
    expect(a.calls).toEqual([{ opId: 'admin.four_eyes_list', query: { status: 'pending', limit: 100 } }]);
    expect(sa.state).toBe('warn');
    expect(sa.urgent.map((u) => (u.item as { change_id: string }).change_id)).toEqual(['c2', 'c1']);
  });

  it('reads at most two pages and marks the count as a lower bound', async () => {
    const item = (n: number) => ({ id: `r${n}`, requested_at: iso(NOW - n * 60_000), expires_at: iso(NOW + H) });
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => item(from + i));
    const { api, calls } = fakeApi({
      awaiting_approvals: [
        { items: full(0), next_cursor: 'p1' },
        { items: full(100), next_cursor: 'p2' },
      ],
    });
    const s = await summarizeQueue(api, recoveries, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(calls).toHaveLength(MAX_PAGES);
    expect(s.count).toBe(200);
    expect(s.capped).toBe(true);
  });

  it('an empty queue has no state', async () => {
    const { api } = fakeApi({});
    const s = await summarizeQueue(api, recoveries, { now: NOW, timeZone: 'Asia/Tehran' });
    expect(s).toMatchObject({ count: 0, capped: false, oldestStart: null, state: null, overdue: 0, urgent: [] });
  });
});

describe('work summary helpers (admin.work_summary)', () => {
  it('the worst SLA bucket decides; paused items alone and queues without targets have no state', () => {
    expect(slaOf({ ok: 3, warn: 1, breach: 1, paused: 0 })).toBe('breach');
    expect(slaOf({ ok: 3, warn: 1, breach: 0, paused: 0 })).toBe('warn');
    expect(slaOf({ ok: 3, warn: 0, breach: 0, paused: 2 })).toBe('ok');
    expect(slaOf({ ok: 0, warn: 0, breach: 0, paused: 2 })).toBeNull();
    expect(slaOf(null)).toBeNull();
  });

  it('maps server queues to tiles and pages; unknown keys are null', () => {
    expect(workQueue('four_eyes')).toEqual({ id: 'approvals', href: '/approvals' });
    expect(workQueue('support_tickets')).toEqual({ id: 'support', href: '/support' });
    expect(workQueue('toString')).toBeNull();
    expect(workQueue('new_queue')).toBeNull();
  });

  it('reads a breakdown count', () => {
    const q = { breakdown: [{ key: 'reason:unsafe_advice', open: 2 }] } as never;
    expect(breakdownCount(q, 'reason:unsafe_advice')).toBe(2);
    expect(breakdownCount(q, 'severity:critical')).toBe(0);
    expect(breakdownCount(undefined, 'x')).toBe(0);
  });
});
