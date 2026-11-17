// NeshanGeocoder (backend S26b.T2). The answers below are fixtures written from the endpoint shapes known before the
// Neshan docs went down (see the adapter's header): they are NOT recordings of the live service.
import { describe, expect, it } from 'vitest';
import { ApiError } from '#libs/contract/index.js';
import type { KeyValueStore } from '#libs/infra/ports.js';
import { pinCheck } from './geocoder.js';
import { NeshanGeocoder, type FetchLike } from './neshan-geocoder.js';

const SEARCH_ANSWER = {
  count: 3,
  items: [
    {
      title: 'Valiasr Street 1200',
      address: 'Valiasr St, Tehran',
      region: 'Tehran - Tehran',
      type: 'street',
      location: { x: 51.410621, y: 35.757512 },
    },
    { title: 'Far away', address: 'Not in Iran', region: 'Paris', location: { x: 2.35, y: 48.85 } },
    { title: 'x'.repeat(500), address: 'a\u0000b\nc', region: 'Karaj', location: { x: '50.9915', y: '35.8327' } },
  ],
};
const GEOCODE_ANSWER = { status: 'OK', location: { x: 51.4107, y: 35.7575 } };
const REVERSE_ANSWER = {
  status: 'OK',
  formatted_address: 'Tehran, Valiasr Street',
  state: 'Tehran',
  city: 'Tehran',
  route_name: 'Valiasr Street',
};

function kvStub(): KeyValueStore {
  const data = new Map<string, string>();
  const kv = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => (data.set(k, v), true),
    incr: async (k: string, by = 1) => {
      const n = Number(data.get(k) ?? 0) + by;
      data.set(k, String(n));
      return n;
    },
  };
  return kv as unknown as KeyValueStore;
}

function fake(answer: unknown, status = 200) {
  const calls: { url: string; key: string | undefined }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, key: init.headers['Api-Key'] });
    return { status, json: async () => answer };
  };
  return { f, calls };
}

describe('NeshanGeocoder', () => {
  it('searches with the service key, validates and bounds the answers', async () => {
    const { f, calls } = fake(SEARCH_ANSWER);
    const g = new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: f });
    const found = await g.search('خیابان ولیعصر', 'IR', 5);
    expect(calls[0]!.key).toBe('service-key-1');
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.neshan\.org\/v1\/search\?term=.+&lat=35\.6892&lng=51\.389$/);
    // The point outside Iran is dropped; long titles and control characters are bounded.
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ point: { lat: 35.757512, lng: 51.410621 }, city: 'Tehran', country: 'IR', postal_code: null });
    expect(found[1]!.label.length).toBeLessThanOrEqual(300);
    expect(found[1]!.address_line_1).toBe('a b c');
  });

  it('only searches Iran, and nothing for an empty query', async () => {
    const { f, calls } = fake(SEARCH_ANSWER);
    const g = new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: f });
    expect(await g.search('Paris', 'FR')).toEqual([]);
    expect(await g.search('   ', 'IR')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('locates a typed address and reverses a point; the pin check works with Neshan results', async () => {
    const { f } = fake(GEOCODE_ANSWER);
    const point = await new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: f }).locate({
      address_line_1: '1200 Valiasr Street',
      city: 'Tehran',
      country: 'IR',
    });
    expect(point).toEqual({ lat: 35.7575, lng: 51.4107 });
    expect(pinCheck({ lat: 35.7576, lng: 51.4108 }, point, 300).location_check_status).toBe('consistent');
    expect(pinCheck({ lat: 35.65, lng: 51.3 }, point, 300).location_check_status).toBe('far_apart');
    const rev = await new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: fake(REVERSE_ANSWER).f }).reverse({
      lat: 35.7575,
      lng: 51.4107,
    });
    expect(rev).toMatchObject({ address_line_1: 'Valiasr Street', city: 'Tehran', region: 'Tehran', country: 'IR' });
    // A status other than OK, or no answer, is "nothing found".
    expect(
      await new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: fake({ status: 'ZERO_RESULTS' }).f }).reverse({
        lat: 35.7,
        lng: 51.4,
      }),
    ).toBeNull();
    expect(
      await new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: fake(null, 404).f }).locate({
        address_line_1: 'x',
        city: 'y',
        country: 'IR',
      }),
    ).toBeNull();
  });

  it('answers 503 UNAVAILABLE with a retry delay on provider errors, timeouts and bad JSON', async () => {
    for (const status of [401, 429, 500]) {
      const g = new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: fake({}, status).f });
      const err = await g.search('valiasr', 'IR').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNAVAILABLE');
      expect((err as ApiError).retryAfterMs).toBe(60_000);
    }
    const timeout: FetchLike = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    await expect(new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: timeout }).search('valiasr', 'IR')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    const badJson: FetchLike = async () => ({ status: 200, json: async () => Promise.reject(new SyntaxError('x')) });
    await expect(new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: badJson }).search('valiasr', 'IR')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('opens a circuit breaker after repeated failures and closes it later', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const failing: FetchLike = async () => {
      calls++;
      return { status: 500, json: async () => ({}) };
    };
    const g = new NeshanGeocoder({
      serviceKey: 'service-key-1',
      fetch: failing,
      now: () => clock,
      breakerThreshold: 3,
      breakerOpenMs: 10_000,
    });
    for (let i = 0; i < 3; i++) await g.search(`q${i}`, 'IR').catch(() => undefined);
    expect(calls).toBe(3);
    await expect(g.search('another', 'IR')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toBe(3); // refused without calling the provider
    clock += 10_001;
    await g.search('again', 'IR').catch(() => undefined);
    expect(calls).toBe(4);
  });

  it('caches an answer per normalized query and counts the requests that left the server', async () => {
    const kv = kvStub();
    const { f, calls } = fake(SEARCH_ANSWER);
    const g = new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: f, kv });
    await g.search('Valiasr  St.', 'IR');
    await g.search('valiasr st', 'IR');
    expect(calls).toHaveLength(1);
    const usage = await g.usage();
    expect(usage).toEqual({ provider: 'neshan', requests_today: 1, requests_30d: 1 });
    // Caching off: every call goes out.
    const { f: f2, calls: calls2 } = fake(SEARCH_ANSWER);
    const g2 = new NeshanGeocoder({ serviceKey: 'service-key-1', fetch: f2, kv: kvStub(), cacheTtlMs: 0 });
    await g2.search('valiasr', 'IR');
    await g2.search('valiasr', 'IR');
    expect(calls2).toHaveLength(2);
  });
});
