import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, directionOf, isLocale, negotiateLocale } from './locales';

describe('locales', () => {
  it('match the pilot region config', () => {
    const region = JSON.parse(readFileSync(join(__dirname, '../../../../shared/region-config/ir-pilot.json'), 'utf8')) as {
      default_locale: string;
      locales: string[];
    };
    expect(DEFAULT_LOCALE).toBe(region.default_locale);
    expect([...LOCALES].sort()).toEqual([...region.locales].sort());
  });

  it('knows direction and membership', () => {
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });

  it('negotiates: cookie, then Accept-Language by quality, then the region default', () => {
    expect(negotiateLocale('en-US,en;q=0.9', 'fa')).toBe('fa');
    expect(negotiateLocale('de-DE,en;q=0.8,fa;q=0.9')).toBe('fa');
    expect(negotiateLocale('en-GB')).toBe('en');
    expect(negotiateLocale('de, fr;q=0.5')).toBe('fa');
    expect(negotiateLocale('en;q=0')).toBe('fa');
    expect(negotiateLocale(null, 'xx')).toBe('fa');
  });
});
