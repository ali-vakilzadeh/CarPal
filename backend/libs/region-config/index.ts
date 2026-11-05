// L20 region config (41 §2.2; Plan §3.5; 40 §22.1 RegionConfig): one file per
// launch region under shared/region-config/<region_key>.json with locales,
// currency, calendar, map, cities, navigation apps, map-link hosts and SMS
// country codes. Labels are stored as Translations and resolved per locale;
// every resolved form is validated against the contract schema at load time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, createContractAjv, loadSchemas } from '#libs/contract/index.js';
import { l10n, type L10n, type Locale } from '#libs/i18n/index.js';
import type { MapLinkHost } from '#libs/geo/index.js';
import type { ExchangeRateView } from './exchange-rates.js';

type Labeled<T> = Omit<T, 'label'> & { label: Record<string, string> };

interface CityConfig {
  city_key: string;
  label: L10n;
  center: { lat: number; lng: number };
}
interface NavigationApp {
  key: string;
  label: L10n;
  platforms: ('ios' | 'android' | 'web')[];
  url_template: string;
}

/** 40 §22.1 RegionConfig (response form, labels resolved). */
export interface RegionConfig {
  region_key: string;
  default_locale: Locale;
  locales: Locale[];
  /** Base currency: every stored price and cost is in it (GD-41). */
  currency: string;
  /** What clients may show amounts in; the default is the first. */
  display_currencies: string[];
  /** Admin-set, filled by config.client from ExchangeRates; display only. */
  exchange_rates: ExchangeRateView[];
  calendar_default: 'gregorian' | 'jalali';
  distance_unit_default: 'km' | 'mi';
  map: {
    style_url: string;
    tiles_url: string;
    attribution: string;
    default_center: { lat: number; lng: number };
    default_zoom: number;
    max_bbox_deg: string;
  };
  cities: CityConfig[];
  navigation_apps: NavigationApp[];
  map_link_hosts: MapLinkHost[];
  sms_country_codes: string[];
}

type RegionFile = Omit<RegionConfig, 'cities' | 'navigation_apps' | 'exchange_rates'> & {
  cities: Labeled<CityConfig>[];
  navigation_apps: Labeled<NavigationApp>[];
};

export class RegionConfigService {
  readonly #file: RegionFile;
  readonly #resolved = new Map<Locale, RegionConfig>();

  constructor(dir: string, regionKey: string) {
    const raw = JSON.parse(readFileSync(join(dir, `${regionKey}.json`), 'utf8')) as RegionFile & { $comment?: string };
    delete raw.$comment;
    if (raw.region_key !== regionKey) throw new Error(`region config ${regionKey}.json declares region_key ${raw.region_key}`);
    this.#file = raw;
    const validate = createContractAjv().getSchema(`${loadSchemas().root.$id}#/$defs/RegionConfig`);
    if (!validate) throw new Error('contract schema RegionConfig missing');
    for (const locale of raw.locales) {
      const resolved = this.#resolve(locale);
      if (!validate(resolved))
        throw new Error(`region config ${regionKey} (${locale}) violates 40 RegionConfig: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
      this.#resolved.set(locale, resolved);
    }
  }

  #resolve(locale: Locale): RegionConfig {
    const f = this.#file;
    const label = (m: Record<string, string>): L10n => l10n(m, locale) ?? { text: '', locale };
    return {
      ...f,
      exchange_rates: [],
      cities: f.cities.map((c) => ({ ...c, label: label(c.label) })),
      navigation_apps: f.navigation_apps.map((a) => ({ ...a, label: label(a.label) })),
    };
  }

  get regionKey(): string {
    return this.#file.region_key;
  }

  get locales(): Locale[] {
    return this.#file.locales;
  }

  /** The RegionConfig for a locale (falls back to en, then the region default). */
  forLocale(locale: Locale): RegionConfig {
    return this.#resolved.get(locale) ?? this.#resolved.get('en') ?? this.#resolved.get(this.#file.default_locale)!;
  }

  /** GD-41: 422 unless a written price or cost is in the base currency. An absent currency passes. */
  requireBaseCurrency(currency: string | null | undefined, pointer: string): void {
    if (currency != null && currency !== this.#file.currency) throw ApiError.validation([{ pointer, code: 'enum' }]);
  }

  get baseCurrency(): string {
    return this.#file.currency;
  }

  get mapLinkHosts(): MapLinkHost[] {
    return this.#file.map_link_hosts;
  }

  get maxBboxDeg(): number {
    return Number(this.#file.map.max_bbox_deg);
  }

  /** SEC-AU-8: SMS only to allowlisted country codes (anti SMS pumping). */
  smsAllowed(e164: string): boolean {
    return this.#file.sms_country_codes.some((cc) => e164.startsWith(cc));
  }
}

export { ExchangeRates, type ExchangeRateView } from './exchange-rates.js';
