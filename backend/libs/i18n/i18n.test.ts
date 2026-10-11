import { describe, expect, it } from 'vitest';
import { l10n, latinDigits, normalizeSearchText, resolveLocale, validateTranslations } from './index.js';

describe('resolveLocale', () => {
  it('picks the highest-weighted enabled locale and falls back to en', () => {
    expect(resolveLocale('fa-IR,fa;q=0.9,en;q=0.8')).toBe('fa');
    expect(resolveLocale('de-DE, en;q=0.5, fa;q=0.7')).toBe('fa');
    expect(resolveLocale('de, fr')).toBe('en');
    expect(resolveLocale('fa;q=0, en')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('fa', ['en'])).toBe('en');
  });
});

describe('l10n', () => {
  it('applies requested → en → first available', () => {
    expect(l10n({ en: 'Brake', fa: 'ترمز' }, 'fa')).toEqual({ text: 'ترمز', locale: 'fa' });
    expect(l10n({ en: 'Brake' }, 'fa')).toEqual({ text: 'Brake', locale: 'en' });
    expect(l10n({ fa: 'ترمز' }, 'en')).toEqual({ text: 'ترمز', locale: 'fa' });
    expect(l10n({}, 'en')).toBeNull();
  });
});

describe('validateTranslations', () => {
  it('checks locales, lengths, line breaks and curated completeness', () => {
    expect(validateTranslations({ en: 'ok' }, '/name', { maxLength: 10 })).toEqual([]);
    expect(validateTranslations({}, '/name', { maxLength: 10 })).toEqual([{ pointer: '/name', code: 'too_short', limit: '1' }]);
    expect(validateTranslations({ de: 'x', en: 'a\nb', fa: 'x'.repeat(11) }, '/n', { maxLength: 10 })).toEqual([
      { pointer: '/n/de', code: 'unknown_field' },
      { pointer: '/n/en', code: 'pattern' },
      { pointer: '/n/fa', code: 'too_long', limit: '10' },
    ]);
    expect(validateTranslations({ en: 'a\nb' }, '/d', { maxLength: 10, multiline: true })).toEqual([]);
    expect(validateTranslations({ en: 'x' }, '/l', { maxLength: 10, platformCurated: true })).toEqual([
      { pointer: '/l/fa', code: 'required' },
    ]);
  });
});

describe('text normalization', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(latinDigits('۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩')).toBe('0123456789 0123456789');
  });
  it('normalizes search text', () => {
    expect(normalizeSearchText('  لنت  ترمز‌ها ۱۲ يك ')).toBe('لنت ترمز ها 12 یک');
    expect(normalizeSearchText('ÉCLAIR Brake')).toBe('Éclair brake');
    expect(normalizeSearchText('ÉCLAIR', { dbLocale: 'und-x-icu' })).toBe('éclair');
  });
});
