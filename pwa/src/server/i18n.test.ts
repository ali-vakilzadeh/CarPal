import { describe, expect, it, vi } from 'vitest';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { REMOTE_BACKOFF_MS, RemoteDictionaries, remoteDictionaryUrl } from './i18n';

describe('remoteDictionaryUrl', () => {
  it('builds <base>/<version>/<locale>.json for https bases and real versions', () => {
    expect(remoteDictionaryUrl('https://cdn.carpal.app/i18n', 'v2', 'fa')).toBe('https://cdn.carpal.app/i18n/v2/fa.json');
    expect(remoteDictionaryUrl('https://cdn.carpal.app/i18n/', '2026.10.1', 'en')).toBe('https://cdn.carpal.app/i18n/2026.10.1/en.json');
  });

  it('uses the bundled copy for dev, fallback, odd versions and non-https bases', () => {
    expect(remoteDictionaryUrl('https://cdn.carpal.app/i18n', 'dev', 'fa')).toBeNull();
    expect(remoteDictionaryUrl('', 'bundled', 'fa')).toBeNull();
    expect(remoteDictionaryUrl('https://cdn.carpal.app/i18n', '../x', 'fa')).toBeNull();
    expect(remoteDictionaryUrl('http://cdn.carpal.app/i18n', 'v2', 'fa')).toBeNull();
    expect(remoteDictionaryUrl('not a url', 'v2', 'fa')).toBeNull();
  });
});

describe('RemoteDictionaries', () => {
  const url = 'https://cdn.carpal.app/i18n/v2/fa.json';

  it('fetches once per version and lays the file over the bundled dictionary', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ common: { appName: 'کارپال ۲' } })));
    const remote = new RemoteDictionaries(fetch as unknown as typeof globalThis.fetch);
    const [a, b] = await Promise.all([remote.get(url, 'fa'), remote.get(url, 'fa')]);
    expect(a?.common.appName).toBe('کارپال ۲');
    expect(a?.shell).toEqual(BUNDLED.fa.shell);
    expect(b).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the bundled copy after a failure and retries only after the backoff', async () => {
    let now = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('nope', { status: 404 }));
    const remote = new RemoteDictionaries(fetch as unknown as typeof globalThis.fetch, () => now);
    expect(await remote.get(url, 'fa')).toBeNull();
    expect(await remote.get(url, 'fa')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = REMOTE_BACKOFF_MS + 1;
    await remote.get(url, 'fa');
    expect(fetch).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('refuses oversized or malformed files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = new RemoteDictionaries((async () => new Response('x'.repeat(600 * 1024))) as unknown as typeof globalThis.fetch);
    expect(await big.get(url, 'fa')).toBeNull();
    const bad = new RemoteDictionaries((async () => new Response('{nope')) as unknown as typeof globalThis.fetch);
    expect(await bad.get(url, 'fa')).toBeNull();
    warn.mockRestore();
  });
});
