// Locale-aware formatting (GD-10, Docs/02 §3.4, Docs/21 §7): Persian digits and the Jalali calendar for fa, Latin
// digits and the Gregorian calendar for en; 24 h times in fa; money in the region's display unit; distances as
// "about x km". Pure functions over Intl (no date library: Intl's 'persian' calendar covers Jalali). Words come
// from the 'format' namespace, so a new language needs no code change. createFormatter() binds a locale.
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';

/** Intl locale per UI language: fa-IR gives Persian (arabext) digits; dates use the Persian calendar. */
const NUMBER_LOCALE: Record<Locale, string> = { fa: 'fa-IR', en: 'en-US' };
const DATE_LOCALE: Record<Locale, string> = { fa: 'fa-IR-u-ca-persian-nu-arabext', en: 'en-US-u-ca-gregory' };

/**
 * Fallback time zone of the formatters. Pages use the browser's zone (cp_tz cookie) or the deployment's
 * CARPAL_PWA_DEFAULT_TIME_ZONE (OQ-13); this constant only covers callers that pass none.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Tehran';
/** The browser's IANA time zone, written by the client so the next server render uses it. */
export const TIME_ZONE_COOKIE = 'cp_tz';

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function formatNumber(n: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale], options).format(n);
}

/** Years, codes and other digit strings: the UI language's digits, no grouping ("1405" → "۱۴۰۵"). */
export function localizeDigits(value: string | number, locale: Locale): string {
  const s = String(value);
  return locale === 'fa' ? s.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!) : s;
}

/** Input normalisation: Persian and Arabic-Indic digits become Latin (inputs accept both, storage is Latin). */
export function toLatinDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

export type DateStyle = 'date' | 'dateLong' | 'dateShort' | 'time' | 'dateTime' | 'monthYear' | 'weekdayDate';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  dateLong: { year: 'numeric', month: 'long', day: 'numeric' },
  dateShort: { month: 'short', day: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit' },
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  monthYear: { year: 'numeric', month: 'long' },
  weekdayDate: { weekday: 'long', month: 'long', day: 'numeric' },
};

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** A timestamp (stored in UTC) in the UI calendar: Jalali for fa, Gregorian for en; fa times are 24 h. */
export function formatDate(value: string | number | Date, locale: Locale, style: DateStyle = 'date', timeZone = DEFAULT_TIME_ZONE): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { ...DATE_OPTIONS[style], timeZone };
  if ('hour' in options) options.hourCycle = locale === 'fa' ? 'h23' : 'h12';
  const format = new Intl.DateTimeFormat(DATE_LOCALE[locale], options);
  // ICU writes "۱۴۰۵ آبان" for a Persian month and year; people write "آبان ۱۴۰۵".
  if (style === 'monthYear' && locale === 'fa') {
    const parts = format.formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('month')} ${part('year')}`;
  }
  return format.format(date);
}

/** A calendar date without a time (e.g. 2026-10-25 from the API) — never shifted by time zones. */
export function formatCalendarDate(
  isoDate: string,
  locale: Locale,
  style: 'date' | 'dateLong' | 'dateShort' | 'monthYear' = 'date',
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return '';
  return formatDate(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), locale, style, 'UTC');
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Infinity],
];

/** "3 days ago" / "in 2 hours" / "now" in the UI language. */
export function formatRelative(value: string | number | Date, locale: Locale, now: number = Date.now()): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  let delta = (date.getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(NUMBER_LOCALE[locale], { numeric: 'auto' });
  if (Math.abs(delta) < 45) return rtf.format(0, 'second');
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) return rtf.format(Math.round(delta), unit);
    delta /= size;
  }
  return rtf.format(Math.round(delta), 'year');
}

/**
 * How prices are shown in this browser (OQ-11). Prices are based in USD; a visitor may enter their own rate and tick
 * "Convert USD prices with this rate" to see them in toman or rial instead. IRR amounts are shown in the same unit
 * (toman by default, 1 toman = 10 rials, as in the pilot designs). Kept in the cp_price cookie so the server renders
 * the same text the browser does.
 */
export interface PriceDisplay {
  convertUsd: boolean;
  /** How many units (toman or rial) one US dollar is worth; null until the visitor enters one. */
  usdRate: number | null;
  unit: 'toman' | 'rial';
}

export const BASE_CURRENCY = 'USD';
export const PRICE_COOKIE = 'cp_price';
export const DEFAULT_PRICE_DISPLAY: PriceDisplay = { convertUsd: false, usdRate: null, unit: 'toman' };
/** Highest rate accepted (units per dollar); keeps the cookie and the arithmetic sane. */
export const MAX_USD_RATE = 1e9;

/** Cookie value "<0|1>.<toman|rial>.<rate or empty>"; anything malformed gives the defaults. */
export function parsePriceDisplay(value: string | null | undefined): PriceDisplay {
  const m = /^([01])\.(toman|rial)\.(\d{1,10}(?:\.\d{1,4})?)?$/.exec(value ?? '');
  if (!m) return DEFAULT_PRICE_DISPLAY;
  const rate = m[3] ? Number(m[3]) : null;
  const usdRate = rate !== null && rate > 0 && rate <= MAX_USD_RATE ? rate : null;
  return { convertUsd: m[1] === '1' && usdRate !== null, usdRate, unit: m[2] as PriceDisplay['unit'] };
}

export function serializePriceDisplay(p: PriceDisplay): string {
  const rate = p.usdRate !== null && p.usdRate > 0 && p.usdRate <= MAX_USD_RATE ? String(Math.round(p.usdRate * 10_000) / 10_000) : '';
  return `${p.convertUsd && rate ? 1 : 0}.${p.unit}.${rate}`;
}

const RIALS_PER_TOMAN = 10;

function localUnit(rials: number, unit: PriceDisplay['unit'], locale: Locale, t: Translate): string {
  const value = unit === 'toman' ? rials / RIALS_PER_TOMAN : rials;
  const shown = formatNumber(Math.round(value), locale, { maximumFractionDigits: 0 });
  return t(unit === 'toman' ? 'format.currency.toman' : 'format.currency.rial', { amount: shown });
}

/** Money from the API (decimal string + ISO code) in this browser's price display, digits of the UI language. */
export function formatMoney(
  amount: string | number,
  currency: string,
  locale: Locale,
  t: Translate,
  prices: PriceDisplay = DEFAULT_PRICE_DISPLAY,
): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return '';
  const code = currency.toUpperCase();
  if (code === 'IRR') return localUnit(value, prices.unit, locale, t);
  if (code === BASE_CURRENCY) {
    if (prices.convertUsd && prices.usdRate) {
      const rials = value * prices.usdRate * (prices.unit === 'toman' ? RIALS_PER_TOMAN : 1);
      return localUnit(rials, prices.unit, locale, t);
    }
    return t('format.currency.usd', { amount: formatNumber(value, locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) });
  }
  const shown = formatNumber(value, locale, { maximumFractionDigits: 2 });
  return t('format.currency.other', { amount: shown, currency: code });
}

/**
 * A distance as people say it: "about 400 m", "about 2.5 km", "about 12 km" (or mi/ft). Under 1 km it rounds to
 * 50 m (never 0), under 10 km to one decimal, above that to whole units.
 */
export function formatDistance(meters: number, locale: Locale, t: Translate, unit: 'km' | 'mi' = 'km'): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (unit === 'mi') {
    const miles = meters / 1609.344;
    if (miles < 0.2)
      return t('format.distance.ft', { value: formatNumber(Math.max(50, Math.round((meters * 3.28084) / 50) * 50), locale) });
    return t('format.distance.mi', { value: formatNumber(miles < 10 ? Math.round(miles * 10) / 10 : Math.round(miles), locale) });
  }
  if (meters < 1000) return t('format.distance.m', { value: formatNumber(Math.max(50, Math.round(meters / 50) * 50), locale) });
  const km = meters / 1000;
  return t('format.distance.km', { value: formatNumber(km < 10 ? Math.round(km * 10) / 10 : Math.round(km), locale) });
}

export interface Formatter {
  locale: Locale;
  timeZone: string;
  number: (n: number, options?: Intl.NumberFormatOptions) => string;
  digits: (value: string | number) => string;
  date: (value: string | number | Date, style?: DateStyle) => string;
  calendarDate: (isoDate: string, style?: 'date' | 'dateLong' | 'dateShort' | 'monthYear') => string;
  relative: (value: string | number | Date, now?: number) => string;
  money: (amount: string | number, currency: string) => string;
  distance: (meters: number, unit?: 'km' | 'mi') => string;
}

export function createFormatter(
  locale: Locale,
  t: Translate,
  timeZone: string = DEFAULT_TIME_ZONE,
  distanceUnit: 'km' | 'mi' = 'km',
  prices: PriceDisplay = DEFAULT_PRICE_DISPLAY,
): Formatter {
  return {
    locale,
    timeZone,
    number: (n, options) => formatNumber(n, locale, options),
    digits: (value) => localizeDigits(value, locale),
    date: (value, style) => formatDate(value, locale, style, timeZone),
    calendarDate: (isoDate, style) => formatCalendarDate(isoDate, locale, style),
    relative: (value, now) => formatRelative(value, locale, now),
    money: (amount, currency) => formatMoney(amount, currency, locale, t, prices),
    distance: (meters, unit = distanceUnit) => formatDistance(meters, locale, t, unit),
  };
}

/** A valid IANA time zone, or null (cookie and header values are untrusted). */
export function validTimeZone(value: string | null | undefined): string | null {
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
