import { describe, expect, it } from 'vitest';
import { regionConfigDir } from '#libs/config/index.js';
import { RegionConfigService } from './index.js';

describe('RegionConfigService', () => {
  const region = new RegionConfigService(regionConfigDir, 'ir-pilot');

  it('loads the pilot region and resolves labels per locale (validated against 40 RegionConfig)', () => {
    expect(region.locales).toEqual(['fa', 'en']);
    const fa = region.forLocale('fa');
    expect(fa.cities[0]).toMatchObject({ city_key: 'tehran', label: { text: 'تهران', locale: 'fa' } });
    expect(region.forLocale('en').navigation_apps.map((a) => a.key)).toContain('neshan');
    expect(region.maxBboxDeg).toBe(0.6);
    expect(region.mapLinkHosts.some((h) => h.short_link)).toBe(true);
  });

  it('allows SMS only to the allowlisted country codes', () => {
    expect(region.smsAllowed('+989121234567')).toBe(true);
    expect(region.smsAllowed('+12025550123')).toBe(false);
  });
});
