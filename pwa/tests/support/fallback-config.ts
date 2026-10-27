// A config.client value for DOM tests, made from the pilot region file (labels resolved like the API does).
import type { ClientConfig, RegionConfig } from '@carpal/api-contracts';
import region from '@carpal/region-config/ir-pilot.json';
import type { Locale } from '@/lib/i18n/locales';

export function fallbackConfigForTests(locale: Locale): ClientConfig {
  const label = (l: { en: string; fa: string }) => ({ text: l[locale], locale });
  const r: RegionConfig = {
    ...(region as unknown as RegionConfig),
    cities: region.cities.map((c) => ({ city_key: c.city_key, label: label(c.label), center: c.center })),
    navigation_apps: region.navigation_apps.map((a) => ({
      ...a,
      label: label(a.label),
      platforms: a.platforms as ('ios' | 'android' | 'web')[],
    })),
  };
  return {
    min_supported_version: '0.0.0',
    latest_version: '0.0.0',
    contract_version: '1.1.0',
    i18n: { version: 'bundled', base_url: '' },
    taxonomy_version: 't1',
    flags: [],
    region: r,
  };
}
