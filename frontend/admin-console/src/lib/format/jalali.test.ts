import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  daysBetweenIso,
  gregorianToJalali,
  isJalaliLeap,
  jalaliMonthLength,
  jalaliToGregorian,
  parseIsoDate,
  todayIso,
  toIsoDate,
} from './jalali';

describe('Jalali calendar', () => {
  it('converts known dates both ways', () => {
    // 1 Farvardin 1405 = 21 March 2026; 3 Aban 1405 = 25 October 2026; 1 Farvardin 1403 = 20 March 2024.
    expect(jalaliToGregorian(1405, 1, 1)).toEqual({ year: 2026, month: 3, day: 21 });
    expect(gregorianToJalali(2026, 10, 25)).toEqual({ year: 1405, month: 8, day: 3 });
    expect(jalaliToGregorian(1403, 1, 1)).toEqual({ year: 2024, month: 3, day: 20 });
    expect(gregorianToJalali(2024, 3, 19)).toEqual({ year: 1402, month: 12, day: 29 });
  });

  it('round-trips every day of several years', () => {
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2028, 0, 1); t += 86_400_000) {
      const d = new Date(t);
      const g = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      const j = gregorianToJalali(g.year, g.month, g.day);
      expect(jalaliToGregorian(j.year, j.month, j.day)).toEqual(g);
    }
  });

  it('knows month lengths and leap years', () => {
    expect(isJalaliLeap(1403)).toBe(true);
    expect(isJalaliLeap(1404)).toBe(false);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1404, 6)).toBe(31);
    expect(jalaliMonthLength(1404, 7)).toBe(30);
  });

  it('parses, formats and shifts ISO calendar dates', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-10-25')).toEqual({ year: 2026, month: 10, day: 25 });
    expect(toIsoDate({ year: 2026, month: 3, day: 1 })).toBe('2026-03-01');
    expect(addDaysIso('2026-12-30', 14)).toBe('2027-01-13');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetweenIso('2026-10-25', '2026-11-24')).toBe(30);
    expect(todayIso('Asia/Tehran', Date.UTC(2026, 9, 25, 21, 0))).toBe('2026-10-26');
  });
});
