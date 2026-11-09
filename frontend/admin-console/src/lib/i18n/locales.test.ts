import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTranslator } from './dictionary';
import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, directionOf, isLocale, negotiateLocale } from './locales';

describe('locales (GD-05)', () => {
  it('match the pilot region config', () => {
    const region = JSON.parse(readFileSync(join(__dirname, '../../../../../shared/region-config/ir-pilot.json'), 'utf8')) as {
      default_locale: string;
      locales: string[];
    };
    expect(DEFAULT_LOCALE).toBe(region.default_locale);
    expect([...LOCALES].sort()).toEqual([...region.locales].sort());
  });

  it('use their own cookie, not the PWA one (cookies on localhost are shared across ports)', () => {
    expect(LOCALE_COOKIE).toBe('cpa_locale');
  });

  it('knows direction and membership', () => {
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(isLocale('de')).toBe(false);
  });

  it('negotiates: cookie, then Accept-Language by quality, then the fallback', () => {
    expect(negotiateLocale('en-US,en;q=0.9', 'fa')).toBe('fa');
    expect(negotiateLocale('de-DE,en;q=0.8,fa;q=0.9')).toBe('fa');
    expect(negotiateLocale('en-GB')).toBe('en');
    expect(negotiateLocale('de, fr;q=0.5')).toBe('fa');
    expect(negotiateLocale('de', null, 'en')).toBe('en');
  });

  it('translates shared and admin keys in both languages', () => {
    expect(getTranslator('en')('admin.env.prod')).toBe('PROD');
    expect(getTranslator('fa')('common.language.label')).toBe('زبان');
    expect(getTranslator('en')('admin.console.contractLine', { version: '1.2.0', n: 67 })).toBe('Admin contract 1.2.0: 67 operations');
  });
});
