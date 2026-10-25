import type { ClientConfig } from '@carpal/api-contracts';
import { describe, expect, it, vi } from 'vitest';
import { ConfigCache, fallbackConfig, flagsOf } from './config';

const live = (version = 't1'): ClientConfig => ({
  ...fallbackConfig('en'),
  taxonomy_version: version,
  flags: [{ key: 'map.enabled', enabled: true }],
});

describe('fallbackConfig', () => {
  it('turns the pilot region file into config.client, labels in the asked language, every flag off', () => {
    const fa = fallbackConfig('fa');
    expect(fa.region.region_key).toBe('ir-pilot');
    expect(fa.region.cities.find((c) => c.city_key === 'tehran')?.label).toEqual({ text: 'تهران', locale: 'fa' });
    expect(fallbackConfig('en').region.navigation_apps[0]?.label.locale).toBe('en');
    expect(fa.flags).toEqual([]);
    expect(fa.i18n.version).toBe('bundled');
  });

  it('flagsOf maps keys to booleans', () => {
    expect(flagsOf(live())).toEqual({ 'map.enabled': true });
  });
});

describe('ConfigCache', () => {
  it('caches per language for the TTL, then serves the stale value while refreshing', async () => {
    let now = 0;
    const fetch = vi.fn(async () => live(`t${fetch.mock.calls.length}`));
    const cache = new ConfigCache({ fetch, now: () => now, ttlMs: 1000 });
    expect((await cache.get('fa')).source).toBe('live');
    expect((await cache.get('fa')).config.taxonomy_version).toBe('t1');
    expect(fetch).toHaveBeenCalledTimes(1);
    await cache.get('en');
    expect(fetch).toHaveBeenCalledTimes(2);

    now = 1500;
    const stale = await cache.get('fa');
    expect(stale.source).toBe('stale');
    expect(stale.config.taxonomy_version).toBe('t1');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const fresh = await cache.get('fa');
    expect(fresh.source).toBe('live');
    expect(fresh.config.taxonomy_version).toBe('t3');
  });

  it('falls back to the region file and backs off after a failure', async () => {
    let now = 0;
    const fetch = vi.fn(async (): Promise<ClientConfig> => {
      throw new Error('down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new ConfigCache({ fetch, now: () => now, backoffMs: 30_000 });
    const first = await cache.get('fa');
    expect(first.source).toBe('fallback');
    expect(first.config.region.region_key).toBe('ir-pilot');
    now = 10_000;
    await cache.get('fa');
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 40_000;
    await cache.get('fa');
    expect(fetch).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keeps the last good value when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('down');
      return live('good');
    });
    const cache = new ConfigCache({ fetch, now: () => now, ttlMs: 1000 });
    await cache.get('fa');
    fail = true;
    now = 2000;
    await cache.get('fa');
    await new Promise((r) => setTimeout(r, 0));
    const after = await cache.get('fa');
    expect(after.config.taxonomy_version).toBe('good');
    expect(after.source).toBe('stale');
  });
});
