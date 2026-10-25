import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/lib/i18n/dictionary';
import {
  createFormatter,
  formatCalendarDate,
  formatDate,
  formatDistance,
  formatMoney,
  formatNumber,
  formatRelative,
  localizeDigits,
  toLatinDigits,
  validTimeZone,
} from './index';

const fa = getTranslator('fa');
const en = getTranslator('en');

describe('numbers and digits', () => {
  it('uses Persian digits and separators for fa, Latin for en', () => {
    expect(formatNumber(1234567, 'fa')).toBe('۱٬۲۳۴٬۵۶۷');
    expect(formatNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNumber(2.5, 'fa')).toBe('۲٫۵');
  });

  it('localizes digit strings without grouping and normalizes input digits', () => {
    expect(localizeDigits(1405, 'fa')).toBe('۱۴۰۵');
    expect(localizeDigits('E90-2012', 'en')).toBe('E90-2012');
    expect(toLatinDigits('۰۹۱۲ ٣٤٥')).toBe('0912 345');
  });
});

describe('dates', () => {
  const at = '2026-10-25T08:30:00Z';

  it('shows Jalali dates in fa and Gregorian in en', () => {
    expect(formatDate(at, 'fa', 'dateLong')).toBe('۳ آبان ۱۴۰۵');
    expect(formatDate(at, 'en', 'dateLong')).toBe('October 25, 2026');
    expect(formatDate(at, 'fa', 'monthYear')).toBe('آبان ۱۴۰۵');
  });

  it('uses 24 h times in fa and the viewer time zone', () => {
    expect(formatDate('2026-10-25T14:05:00Z', 'fa', 'time', 'Asia/Tehran')).toBe('۱۷:۳۵');
    expect(formatDate('2026-10-25T14:05:00Z', 'en', 'time', 'UTC')).toBe('2:05 PM');
  });

  it('keeps calendar dates on their day in every time zone', () => {
    expect(formatCalendarDate('2026-03-21', 'fa', 'dateLong')).toBe('۱ فروردین ۱۴۰۵');
    expect(formatCalendarDate('2026-03-21', 'en')).toBe('Mar 21, 2026');
    expect(formatCalendarDate('not a date', 'en')).toBe('');
  });

  it('says relative times in the UI language', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(formatRelative(now - 10_000, 'en', now)).toBe('now');
    expect(formatRelative(now - 3 * 86_400_000, 'en', now)).toBe('3 days ago');
    expect(formatRelative(now + 2 * 3_600_000, 'en', now)).toBe('in 2 hours');
    expect(formatRelative(now - 3 * 86_400_000, 'fa', now)).toBe('۳ روز پیش');
  });

  it('returns nothing for invalid input', () => {
    expect(formatDate('nope', 'en')).toBe('');
    expect(formatRelative('nope', 'en')).toBe('');
  });
});

describe('money and distance', () => {
  it('shows IRR in toman (÷ 10) in the UI digits', () => {
    expect(formatMoney('18500000', 'IRR', 'fa', fa)).toBe('۱٬۸۵۰٬۰۰۰ تومان');
    expect(formatMoney(18_500_000, 'irr', 'en', en)).toBe('1,850,000 T');
    expect(formatMoney('12.5', 'EUR', 'en', en)).toBe('12.5 EUR');
    expect(formatMoney('x', 'IRR', 'en', en)).toBe('');
  });

  it('says distances as "about x"', () => {
    expect(formatDistance(30, 'en', en)).toBe('about 50 m');
    expect(formatDistance(420, 'en', en)).toBe('about 400 m');
    expect(formatDistance(2450, 'en', en)).toBe('about 2.5 km');
    expect(formatDistance(12_400, 'fa', fa)).toBe('حدود ۱۲ کیلومتر');
    expect(formatDistance(3218.7, 'en', en, 'mi')).toBe('about 2 mi');
    expect(formatDistance(-1, 'en', en)).toBe('');
  });
});

describe('createFormatter / validTimeZone', () => {
  it('binds locale, time zone and distance unit', () => {
    const f = createFormatter('fa', fa, 'UTC', 'km');
    expect(f.number(12)).toBe('۱۲');
    expect(f.digits('2012')).toBe('۲۰۱۲');
    expect(f.date('2026-10-25T23:30:00Z', 'time')).toBe('۲۳:۳۰');
    expect(f.distance(800)).toBe('حدود ۸۰۰ متر');
  });

  it('accepts IANA zones only', () => {
    expect(validTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(validTimeZone('Mars/Olympus')).toBeNull();
    expect(validTimeZone(undefined)).toBeNull();
  });
});
