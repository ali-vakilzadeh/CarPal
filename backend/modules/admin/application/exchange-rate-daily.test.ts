// Daily rate clock (backend S26a.T4): "today" is the day in Tehran, not in UTC.
import { describe, expect, it } from 'vitest';
import { rateFreshness, regionClock } from './exchange-rate-daily.js';

describe('regionClock and rateFreshness (Asia/Tehran, UTC+3:30)', () => {
  it('reads the day and hour on the Tehran clock', () => {
    expect(regionClock(new Date('2026-11-16T20:29:00Z'))).toEqual({ day: '2026-11-16', hour: 23 });
    expect(regionClock(new Date('2026-11-16T20:30:00Z'))).toEqual({ day: '2026-11-17', hour: 0 });
    expect(regionClock(new Date('2026-11-17T05:30:00Z'))).toEqual({ day: '2026-11-17', hour: 9 });
  });

  it('set_today turns false at midnight in Tehran, not at midnight UTC', () => {
    const setAt = new Date('2026-11-16T20:00:00Z'); // 23:30 in Tehran on the 16th
    expect(rateFreshness(setAt, new Date('2026-11-16T20:20:00Z'))).toEqual({ set_today: true, age_hours: 0 });
    expect(rateFreshness(setAt, new Date('2026-11-16T20:31:00Z'))).toEqual({ set_today: false, age_hours: 0 });
    const morning = new Date('2026-11-16T20:31:00Z'); // 00:01 on the 17th in Tehran, still the 16th in UTC
    expect(rateFreshness(morning, new Date('2026-11-17T19:00:00Z'))).toEqual({ set_today: true, age_hours: 22 });
  });
});
