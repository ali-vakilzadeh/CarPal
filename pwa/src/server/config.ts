// config.client for server rendering (P3.T7): flags, region, i18n and taxonomy versions, read through the cp-ssr
// client with a short cache per UI language (labels are translated per Accept-Language). Stale values are served
// while a refresh runs; when the backend cannot be reached, the last good value (or, on a cold start, the pilot region
// file with every flag off, GD-13) is used and the next attempt waits FAILURE_BACKOFF_MS, so a backend outage never
// slows every page down.
import 'server-only';
import { connection } from 'next/server';
import type { ClientConfig, RegionConfig } from '@carpal/api-contracts';
import region from '@carpal/region-config/ir-pilot.json';
import type { Locale } from '@/lib/i18n/locales';
import { ssrApi } from './ssr/api';

export const CONFIG_TTL_MS = 60_000;
export const FAILURE_BACKOFF_MS = 30_000;
export const CONFIG_TIMEOUT_MS = 2_000;

export type ConfigSource = 'live' | 'stale' | 'fallback';

export interface LoadedConfig {
  config: ClientConfig;
  source: ConfigSource;
  fetchedAt: number;
}

type RegionFile = typeof region;
type Label = { en: string; fa: string };

const label = (l: Label, locale: Locale) => ({ text: l[locale] ?? l.en, locale });

/** The pilot region file in the shape config.client returns, labels resolved for one language. */
export function fallbackConfig(locale: Locale, file: RegionFile = region): ClientConfig {
  const regionConfig: RegionConfig = {
    region_key: file.region_key,
    default_locale: file.default_locale as RegionConfig['default_locale'],
    locales: file.locales as RegionConfig['locales'],
    currency: file.currency,
    calendar_default: file.calendar_default as RegionConfig['calendar_default'],
    distance_unit_default: file.distance_unit_default as RegionConfig['distance_unit_default'],
    map: file.map,
    cities: file.cities.map((c) => ({ city_key: c.city_key, label: label(c.label, locale), center: c.center })),
    navigation_apps: file.navigation_apps.map((a) => ({
      key: a.key,
      label: label(a.label, locale),
      platforms: a.platforms as ('ios' | 'android' | 'web')[],
      url_template: a.url_template,
    })),
    map_link_hosts: file.map_link_hosts,
    sms_country_codes: file.sms_country_codes,
  };
  return {
    min_supported_version: '0.0.0',
    latest_version: '0.0.0',
    contract_version: '1.1.0',
    i18n: { version: 'bundled', base_url: '' },
    taxonomy_version: '',
    flags: [],
    region: regionConfig,
  };
}

interface Entry {
  value?: LoadedConfig;
  failedAt?: number;
  pending?: Promise<LoadedConfig>;
}

export interface ConfigCacheOptions {
  fetch: (locale: Locale) => Promise<ClientConfig>;
  now?: () => number;
  ttlMs?: number;
  backoffMs?: number;
}

export class ConfigCache {
  readonly #entries = new Map<Locale, Entry>();
  readonly #o: Required<ConfigCacheOptions>;

  constructor(o: ConfigCacheOptions) {
    this.#o = { ...o, now: o.now ?? Date.now, ttlMs: o.ttlMs ?? CONFIG_TTL_MS, backoffMs: o.backoffMs ?? FAILURE_BACKOFF_MS };
  }

  async get(locale: Locale): Promise<LoadedConfig> {
    const now = this.#o.now();
    const entry = this.#entries.get(locale) ?? {};
    this.#entries.set(locale, entry);
    const fresh = entry.value && entry.value.source === 'live' && now - entry.value.fetchedAt < this.#o.ttlMs;
    if (fresh) return entry.value!;
    const backingOff = entry.failedAt !== undefined && now - entry.failedAt < this.#o.backoffMs;
    if (backingOff)
      return entry.value ? { ...entry.value, source: 'stale' } : { config: fallbackConfig(locale), source: 'fallback', fetchedAt: now };
    entry.pending ??= this.#refresh(locale, entry).finally(() => (entry.pending = undefined));
    // Serve a stale value at once and let the refresh finish in the background.
    if (entry.value) return { ...entry.value, source: 'stale' };
    return entry.pending;
  }

  async #refresh(locale: Locale, entry: Entry): Promise<LoadedConfig> {
    try {
      const config = await this.#o.fetch(locale);
      entry.value = { config, source: 'live', fetchedAt: this.#o.now() };
      entry.failedAt = undefined;
      return entry.value;
    } catch (err) {
      entry.failedAt = this.#o.now();
      if (!entry.value)
        console.warn(`config.client unavailable (${err instanceof Error ? err.message : String(err)}); using the region file`);
      return entry.value ?? { config: fallbackConfig(locale), source: 'fallback', fetchedAt: this.#o.now() };
    }
  }
}

const holder = globalThis as typeof globalThis & { __carpalConfig?: ConfigCache };

function cache(): ConfigCache {
  holder.__carpalConfig ??= new ConfigCache({
    fetch: (locale) => ssrApi(locale).api('config.client', { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) }),
  });
  return holder.__carpalConfig;
}

/** The client configuration for a UI language (cached; never throws). */
export async function loadClientConfig(locale: Locale): Promise<LoadedConfig> {
  await connection(); // request-time only (the build never calls the backend)
  return cache().get(locale);
}

/** Flag lookup: unknown flags are off (GD-13). */
export function flagsOf(config: ClientConfig): Record<string, boolean> {
  return Object.fromEntries(config.flags.map((f) => [f.key, f.enabled]));
}
