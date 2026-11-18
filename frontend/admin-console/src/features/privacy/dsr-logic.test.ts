// AC10.T4/T5 unit tests of the privacy-request rules: the moves the backend accepts (DSR_NEXT; a deletion completes
// only through its execution), export and deletion availability, the queue views (due_before, overdue never closed),
// urgency order and the short id.
import { describe, expect, it } from 'vitest';
import { byDue, canBuildExport, canRunDeletion, dateIn, dsrMoves, dueBeforeOf, inDsrView, shortId, type DsrRow } from './dsr-logic';

const row = (o: Partial<DsrRow> = {}): DsrRow => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000a1',
  user_id: '0193a3c4-5d6e-7f80-9a1b-0000000000b2',
  created_at: '2026-11-01T08:00:00Z',
  updated_at: '2026-11-01T08:00:00Z',
  version: 1,
  request_type: 'export',
  details: null,
  status: 'received',
  requested_at: '2026-11-01T08:00:00Z',
  due_at: '2026-12-01T08:00:00Z',
  rejection_reason: null,
  completed_at: null,
  export_available: false,
  ...o,
});

describe('DSR moves (backend DSR_NEXT)', () => {
  it('offers only the moves the backend accepts', () => {
    expect(dsrMoves(row({ status: 'received' }))).toEqual(['verifying_identity', 'rejected']);
    expect(dsrMoves(row({ status: 'verifying_identity' }))).toEqual(['in_progress', 'rejected']);
    expect(dsrMoves(row({ status: 'in_progress' }))).toEqual(['completed', 'rejected']);
    expect(dsrMoves(row({ status: 'completed' }))).toEqual([]);
    expect(dsrMoves(row({ status: 'rejected' }))).toEqual([]);
  });

  it('a deletion is never completed by hand (use execute-deletion)', () => {
    expect(dsrMoves(row({ status: 'in_progress', request_type: 'deletion' }))).toEqual(['rejected']);
  });

  it('an export file is built in progress for export and deletion requests; a deletion runs in progress', () => {
    expect(canBuildExport(row({ status: 'in_progress', request_type: 'export' }))).toBe(true);
    expect(canBuildExport(row({ status: 'in_progress', request_type: 'deletion' }))).toBe(true);
    expect(canBuildExport(row({ status: 'in_progress', request_type: 'rectification' }))).toBe(false);
    expect(canBuildExport(row({ status: 'received', request_type: 'export' }))).toBe(false);
    expect(canRunDeletion(row({ status: 'in_progress', request_type: 'deletion' }))).toBe(true);
    expect(canRunDeletion(row({ status: 'verifying_identity', request_type: 'deletion' }))).toBe(false);
  });
});

describe('Queue views', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  it('due_before is today (overdue) or 7 days ahead (this week), on the staff member’s calendar', () => {
    expect(dueBeforeOf('overdue', now, 'Asia/Tehran')).toBe('2026-11-18');
    expect(dueBeforeOf('week', now, 'Asia/Tehran')).toBe('2026-11-25');
    expect(dueBeforeOf('', now, 'Asia/Tehran')).toBeUndefined();
    // 22:00 UTC is already the next day in Tehran (+03:30).
    expect(dateIn(0, Date.parse('2026-11-18T22:00:00Z'), 'Asia/Tehran')).toBe('2026-11-19');
  });

  it('overdue shows only open requests past their due date; closed requests are never overdue', () => {
    expect(inDsrView(row({ due_at: '2026-11-10T00:00:00Z' }), 'overdue', now)).toBe(true);
    expect(inDsrView(row({ due_at: '2026-11-10T00:00:00Z', status: 'completed' }), 'overdue', now)).toBe(false);
    expect(inDsrView(row({ due_at: '2026-11-20T00:00:00Z' }), 'overdue', now)).toBe(false);
    expect(inDsrView(row({ status: 'rejected' }), 'week', now)).toBe(false);
    expect(inDsrView(row({ status: 'rejected' }), '', now)).toBe(true);
  });

  it('most urgent first: open before closed, then the nearest due date', () => {
    const a = row({ id: 'a', due_at: '2026-11-30T00:00:00Z' });
    const b = row({ id: 'b', due_at: '2026-11-20T00:00:00Z' });
    const c = row({ id: 'c', due_at: '2026-11-01T00:00:00Z', status: 'completed' });
    expect([a, c, b].sort(byDue).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('shows ids by their last six characters', () => {
    expect(shortId('0193a3c4-5d6e-7f80-9a1b-0000000000a1')).toBe('…0000a1');
  });
});
