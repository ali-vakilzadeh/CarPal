import { describe, expect, it } from 'vitest';
import { zonedToUtc } from '#libs/geo/index.js';
import {
  allowedTransitions,
  capacityCells,
  openSlots,
  transitionAllowed,
  visitTookPlace,
  windowErrors,
  withinCheckInWindow,
} from './rules.js';

const rule = (o: Partial<Parameters<typeof openSlots>[0]['rules'][number]> = {}) => ({
  location_id: 'L',
  day_of_week: 1, // Monday
  start_time: '09:00:00',
  end_time: '12:00:00',
  slot_duration_minutes: 60,
  appointment_types: [],
  max_concurrent_appointments: 1,
  buffer_minutes: 0,
  effective_from: null,
  effective_to: null,
  ...o,
});

describe('appointment transitions (40 §16.1)', () => {
  it('follows the table per side', () => {
    expect(transitionAllowed('requester', 'draft', 'requested')).toBe(true);
    expect(transitionAllowed('requester', 'requested', 'confirmed')).toBe(false);
    expect(transitionAllowed('requester', 'alternative_proposed', 'confirmed')).toBe(true);
    expect(transitionAllowed('provider', 'requested', 'confirmed')).toBe(true);
    expect(transitionAllowed('provider', 'checked_in', 'completed')).toBe(false);
    expect(transitionAllowed('provider', 'in_progress', 'completed')).toBe(true);
    expect(allowedTransitions('provider', 'completed')).toEqual([]);
    expect(allowedTransitions('requester', 'confirmed')).toEqual(['cancelled', 'checked_in']);
  });

  it('windows must be future, ordered and at most 30 days ahead', () => {
    const now = Date.parse('2026-10-13T08:00:00Z');
    expect(windowErrors([{ start_at: '2026-10-14T08:00:00Z', end_at: '2026-10-14T09:00:00Z', priority: 1 }], now)).toEqual([]);
    expect(windowErrors([{ start_at: '2026-10-12T08:00:00Z', end_at: '2026-10-14T09:00:00Z', priority: 1 }], now)[0]!.code).toBe('in_past');
    expect(windowErrors([{ start_at: '2026-12-14T08:00:00Z', end_at: '2026-12-14T09:00:00Z', priority: 1 }], now)[0]!.code).toBe(
      'out_of_range',
    );
    expect(windowErrors([{ start_at: '2026-10-14T09:00:00Z', end_at: '2026-10-14T08:00:00Z', priority: 1 }], now)[0]!.pointer).toBe(
      '/time_windows/0/end_at',
    );
  });

  it('check-in window is ±2 h; a confirmed visit counts for Path 1 24 h after its time (52 §21)', () => {
    const start = new Date('2026-10-13T10:00:00Z');
    expect(withinCheckInWindow(start, start.getTime() - 3_600_000)).toBe(true);
    expect(withinCheckInWindow(start, start.getTime() - 3 * 3_600_000)).toBe(false);
    const a = { status: 'confirmed', confirmed_start_at: start, completed_at: null };
    expect(visitTookPlace(a, start.getTime() + 23 * 3_600_000)).toBe(false);
    expect(visitTookPlace(a, start.getTime() + 25 * 3_600_000)).toBe(true);
    expect(visitTookPlace({ ...a, status: 'cancelled' }, start.getTime() + 48 * 3_600_000)).toBe(false);
    expect(visitTookPlace({ ...a, status: 'completed', completed_at: start }, start.getTime())).toBe(true);
  });
});

describe('slot computation (public.availability)', () => {
  const tz = 'Asia/Tehran';
  const monday = '2026-10-19';
  const now = new Date('2026-10-13T00:00:00Z');

  it('yields one slot per slot length inside the rule, in the location time zone', () => {
    const slots = openSlots({ rules: [rule()], timezone: tz, from: monday, days: 1, busy: [], timeOff: [], now });
    expect(slots).toHaveLength(3);
    expect(slots[0]!.start_at).toBe(zonedToUtc(monday, '09:00', tz).toISOString());
    expect(slots[0]!.appointment_types).toHaveLength(5);
  });

  it('removes full slots (with buffers), time off and past slots', () => {
    const nine = zonedToUtc(monday, '09:00', tz);
    const busy = [{ start: nine, end: new Date(nine.getTime() + 3_600_000) }];
    expect(openSlots({ rules: [rule()], timezone: tz, from: monday, days: 1, busy, timeOff: [], now })).toHaveLength(2);
    // A 30-minute buffer makes the 09:00 appointment overlap the 10:00 slot too.
    expect(openSlots({ rules: [rule({ buffer_minutes: 30 })], timezone: tz, from: monday, days: 1, busy, timeOff: [], now })).toHaveLength(
      1,
    );
    // Two concurrent appointments allowed: the 09:00 slot is still open.
    expect(
      openSlots({ rules: [rule({ max_concurrent_appointments: 2 })], timezone: tz, from: monday, days: 1, busy, timeOff: [], now }),
    ).toHaveLength(3);
    const off = [{ start: nine, end: new Date(nine.getTime() + 2 * 3_600_000) }];
    expect(openSlots({ rules: [rule()], timezone: tz, from: monday, days: 1, busy: [], timeOff: off, now })).toHaveLength(1);
    const late = new Date(nine.getTime() + 90 * 60_000);
    expect(openSlots({ rules: [rule()], timezone: tz, from: monday, days: 1, busy: [], timeOff: [], now: late })).toHaveLength(1);
  });

  it('respects rule types, effective dates and the day of week', () => {
    const typed = rule({ appointment_types: ['inspection'] });
    expect(openSlots({ rules: [typed], timezone: tz, from: monday, days: 1, busy: [], timeOff: [], now, type: 'repair' })).toHaveLength(0);
    expect(openSlots({ rules: [typed], timezone: tz, from: monday, days: 7, busy: [], timeOff: [], now, type: 'inspection' })).toHaveLength(
      3,
    );
    expect(
      openSlots({ rules: [rule({ effective_from: '2026-10-20' })], timezone: tz, from: monday, days: 1, busy: [], timeOff: [], now }),
    ).toHaveLength(0);
    const cells = capacityCells({ rules: [rule()], timezone: tz, from: monday, days: 7, busy: [] });
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ used: 0, max: 1 });
  });
});
