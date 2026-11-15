import { describe, expect, it } from 'vitest';
import { addWorkingDays, dueAt, moderationTarget, slaState, summarize } from './work-sla.js';

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe('work queue SLA (backend S21, BR-22)', () => {
  it('adds working days on the caller clock and skips the Friday weekend', () => {
    // Thursday 2026-11-12 10:00 in Tehran (UTC+03:30): Friday does not count, Saturday and Sunday do.
    const thu = at('2026-11-12T06:30:00Z');
    expect(new Date(addWorkingDays(thu, 2, 'Asia/Tehran')).toISOString()).toBe('2026-11-15T06:30:00.000Z');
    // Saturday + 2 working days: Sunday, Monday.
    expect(new Date(addWorkingDays(at('2026-11-14T06:30:00Z'), 2, 'Asia/Tehran')).toISOString()).toBe('2026-11-16T06:30:00.000Z');
    // A fixed due date and hour targets.
    expect(dueAt(thu, { at: new Date('2026-12-01T00:00:00Z') }, 'UTC')).toBe(at('2026-12-01T00:00:00Z'));
    expect(dueAt(thu, { hours: 4 }, 'UTC')).toBe(thu + 4 * HOUR);
  });

  it('turns amber after 75 % of the window and red at the target', () => {
    const start = 0;
    const due = 100 * HOUR;
    expect(slaState(start, due, 74 * HOUR)).toBe('ok');
    expect(slaState(start, due, 75 * HOUR)).toBe('warn');
    expect(slaState(start, due, due)).toBe('breach');
    expect(slaState(start, start, start)).toBe('breach');
  });

  it('gives safety reasons and critical cases 4 hours, reviews 24 and the rest 48 (Docs/23 §6)', () => {
    expect(moderationTarget('privacy', 'low', 'post')).toEqual({ hours: 4 });
    expect(moderationTarget('spam', 'critical', 'post')).toEqual({ hours: 4 });
    expect(moderationTarget('fake', null, 'review')).toEqual({ hours: 24 });
    expect(moderationTarget('spam', 'medium', 'inventory_item')).toEqual({ hours: 48 });
  });

  it('summarizes a queue: exact open count, states, pauses, the caller share and the breakdown', () => {
    const now = at('2026-11-14T12:00:00Z');
    const s = summarize(
      7,
      [
        { startedAt: new Date(now - 10 * HOUR), target: { hours: 4 }, mine: true, keys: ['reason:privacy'] },
        { startedAt: new Date(now - 3.5 * HOUR), target: { hours: 4 }, keys: ['reason:privacy'] },
        { startedAt: new Date(now - HOUR), target: { hours: 48 }, keys: ['reason:spam'] },
        { startedAt: new Date(now - 100 * HOUR), target: { workingDays: 2 }, paused: true },
      ],
      { now, timeZone: 'UTC', assignable: true, timed: true },
    );
    expect(s).toEqual({
      open: 7,
      assigned_to_me: 1,
      oldest_at: new Date(now - 100 * HOUR).toISOString(),
      next_due_at: new Date(now - 6 * HOUR).toISOString(),
      sla: { ok: 1, warn: 1, breach: 1, paused: 1 },
      breakdown: [
        { key: 'reason:privacy', open: 2 },
        { key: 'reason:spam', open: 1 },
      ],
    });
    const plain = summarize(1, [{ startedAt: new Date(now), target: null }], { now, timeZone: 'UTC', assignable: false, timed: false });
    expect(plain).toMatchObject({ assigned_to_me: null, sla: null, next_due_at: null });
  });
});
