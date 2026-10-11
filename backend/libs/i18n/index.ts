// L13 i18n (41 §2.2; 52 §2.4-2.5; 40 §1.3, §3.1): Accept-Language resolution,
// Translations validation, L10n read rule, Latin digits and the search-text
// normalization that must stay identical to core.normalize_search_text().
import type { FieldError } from '#libs/contract/index.js';

/** Enabled locales (40 §3.1 `Locale`). The region config lists the subset in use. */
export const LOCALES = ['en', 'fa'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/**
 * Accept-Language (40 §1.3): the highest-weighted enabled locale; anything
 * else resolves to `en` (52 §2.4 read rule).
 */
export function resolveLocale(header: string | undefined, enabled: readonly Locale[] = LOCALES): Locale {
  if (!header || header.length > 200) return DEFAULT_LOCALE;
  const ranges = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/.exec(p)).find(Boolean);
      return { lang: tag.trim().toLowerCase().split('-')[0] ?? '', q: q ? Number(q[1]) : 1, index };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const r of ranges) if ((enabled as readonly string[]).includes(r.lang)) return r.lang as Locale;
  return DEFAULT_LOCALE;
}

export type Translations = Partial<Record<string, string>>;
export interface L10n {
  text: string;
  locale: Locale;
}

/**
 * Read rule (52 §2.4, 40 §3.1 `L10n`): requested locale → en → first
 * available (by key, as core.l10n does). Null when the map is empty.
 */
export function l10n(map: Translations | null | undefined, locale: Locale): L10n | null {
  if (!map) return null;
  const pick = (l: string): L10n | null => (typeof map[l] === 'string' && map[l] !== '' ? { text: map[l], locale: l as Locale } : null);
  return pick(locale) ?? pick('en') ?? pick(Object.keys(map).sort()[0] ?? '');
}

export interface TranslationRules {
  /** Max code points per value (Translations<b>). */
  maxLength: number;
  /** Platform-curated values need every enabled locale; business-authored need ≥ 1. */
  platformCurated?: boolean;
  /** Text<b> allows line breaks; Str<1,b> does not. */
  multiline?: boolean;
  enabled?: readonly Locale[];
}

/** Validates a Translations map (40 §3.1). Returns field errors with pointers under `pointer`. */
export function validateTranslations(value: unknown, pointer: string, rules: TranslationRules): FieldError[] {
  const enabled = rules.enabled ?? LOCALES;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [{ pointer, code: 'type' }];
  const errors: FieldError[] = [];
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    const p = `${pointer}/${k}`;
    if (!(enabled as readonly string[]).includes(k)) errors.push({ pointer: p, code: 'unknown_field' });
    else if (typeof v !== 'string') errors.push({ pointer: p, code: 'type' });
    else if (v.length === 0) errors.push({ pointer: p, code: 'too_short', limit: '1' });
    else if ([...v].length > rules.maxLength) errors.push({ pointer: p, code: 'too_long', limit: String(rules.maxLength) });
    else if (!rules.multiline && /[\r\n]/.test(v)) errors.push({ pointer: p, code: 'pattern' });
  }
  if (rules.platformCurated) {
    for (const l of enabled) if (!(l in (value as object))) errors.push({ pointer: `${pointer}/${l}`, code: 'required' });
  } else if (entries.length === 0) {
    errors.push({ pointer, code: 'too_short', limit: '1' });
  }
  return errors;
}

// Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669) digits → Latin (52 §2.5).
const DIGITS = new RegExp('[\\u06f0-\\u06f9\\u0660-\\u0669]', 'g');
export function latinDigits(text: string): string {
  return text.replace(DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

// Whitespace as PostgreSQL's regex class \s sees it: ASCII only under the C
// ctype (the default install, checked against the database in tests), the
// Unicode White_Space set under ICU or C.UTF-8.
const PG_SPACE_C = /[\t\n\v\f\r ]+/g;
// eslint-disable-next-line no-control-regex -- ASCII and Unicode whitespace, intended
const PG_SPACE_UNICODE = new RegExp('[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', 'g');
const ARABIC_YEH = new RegExp('[\u064a\u0649]', 'g'); // Arabic yeh and alef maksura -> Persian yeh
const ARABIC_KAF = new RegExp('\u0643', 'g'); // Arabic kaf -> Persian keheh
const ZWNJ = new RegExp('\u200c', 'g');
const TATWEEL = new RegExp('\u0640', 'g');
const PERSIAN_YEH = String.fromCharCode(0x06cc);
const PERSIAN_KEHEH = String.fromCharCode(0x06a9);

export interface SearchNormalizeOptions {
  /**
   * Database ctype. PostgreSQL's lower() and \s follow it: under "C" (the
   * default install) only ASCII letters are lower-cased and only ASCII
   * whitespace is collapsed (DI-07). Any other value uses Unicode rules.
   */
  dbLocale?: string;
}

/**
 * Search normalization (52 §2.5), identical to core.normalize_search_text():
 * NFC, Latin digits, Arabic yeh/kaf -> Persian, ZWNJ -> space, tatweel
 * removed, whitespace collapsed, trimmed, lower case.
 */
export function normalizeSearchText(text: string, options: SearchNormalizeOptions = {}): string {
  const c = (options.dbLocale ?? 'C') === 'C';
  const s = latinDigits(text.normalize('NFC'))
    .replace(ARABIC_YEH, PERSIAN_YEH)
    .replace(ARABIC_KAF, PERSIAN_KEHEH)
    .replace(ZWNJ, ' ')
    .replace(TATWEEL, '')
    .replace(c ? PG_SPACE_C : PG_SPACE_UNICODE, ' ');
  const trimmed = s.replace(/^ +| +$/g, '');
  return c ? trimmed.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : trimmed.toLowerCase();
}
