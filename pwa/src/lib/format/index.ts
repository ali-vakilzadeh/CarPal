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
 * How prices are shown (OQ-11 update 2026-11-04, backend GD-41): amounts are stored in USD and a system admin sets the
 * rate, so everybody sees the same price. The first display currency of the region is shown; IRR in toman (1 toman =
 * 10 rials, as in the pilot designs). Without a rate (backend unreachable) amounts stay in USD.
 */
export interface PriceDisplay {
  currency: string;
  /** Units of `currency` per US dollar; null shows USD. */
  perUsd: number | null;
}

export const BASE_CURRENCY = 'USD';
export const DEFAULT_PRICE_DISPLAY: PriceDisplay = { currency: BASE_CURRENCY, perUsd: null };

/** The price display of a region config (config.client): its first display currency at the admin-set rate. */
export function priceDisplayOf(region: {
  currency: string;
  display_currencies?: readonly string[];
  exchange_rates?: readonly { currency: string; per_usd: string }[];
}): PriceDisplay {
  const currency = region.display_currencies?.[0] ?? region.currency;
  const perUsd = Number(region.exchange_rates?.find((r) => r.currency === currency)?.per_usd);
  return Number.isFinite(perUsd) && perUsd > 0 ? { currency, perUsd } : DEFAULT_PRICE_DISPLAY;
}

const RIALS_PER_TOMAN = 10;

function inToman(rials: number, locale: Locale, t: Translate): string {
  return t('format.currency.toman', { amount: formatNumber(Math.round(rials / RIALS_PER_TOMAN), locale, { maximumFractionDigits: 0 }) });
}

/** Money from the API (decimal string + ISO code) in the region's price display, digits of the UI language. */
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
  if (code === 'IRR') return inToman(value, locale, t);
  if (code === BASE_CURRENCY) {
    if (prices.currency === 'IRR' && prices.perUsd) return inToman(value * prices.perUsd, locale, t);
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
