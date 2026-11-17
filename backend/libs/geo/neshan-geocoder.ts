// NeshanGeocoder (backend S26b.T2; owner decision 2026-11-16, DQ-29): the Geocoder port over Neshan's REST API
// (https://platform.neshan.org/docs/), called from the server with the service key (CARPAL_NESHAN_SERVICE_KEY, never
// sent to a client). Only the searched address text or the pin point leaves the server, never an account or vehicle.
//
// UNVERIFIED ENDPOINTS: the Neshan docs answered 503 on 2026-11-16 and 2026-11-17. The paths and answer shapes below
// are the ones known from before the docs went down (BR-update-plan S26b.T2) and are covered by test fixtures written
// from that knowledge, not recorded from the live service. One live check on staging with the owner's key is an open
// item; fix `parse*` here if an answer differs.
//   base  https://api.neshan.org        header  Api-Key: <service key>
//   search   GET /v1/search?term=&lat=&lng=   -> { count, items: [{ title, address, neighbourhood, region, type, category, location: { x: lng, y: lat } }] }
//   geocode  GET /v4/geocoding?address=       -> { status: 'OK', location: { x: lng, y: lat } }
//   reverse  GET /v5/reverse?lat=&lng=        -> { status: 'OK', formatted_address, state, county, city, neighbourhood, route_name }
// Answers are third-party data and are bounded like client input (SEC-IN-10). Timeouts of 3 s, a circuit breaker and
// 503 UNAVAILABLE with a retry delay on provider failure keep the location editor usable by typed address. Results are
// cached for 24 h per normalized query (the terms of use are to be confirmed; `cacheTtlMs: 0` switches it off).
import { createHash } from 'node:crypto';
import { ApiError } from '#libs/contract/index.js';
import type { KeyValueStore } from '#libs/infra/ports.js';
import { Geocoder, normalizeAddress, type AddressQuery, type GeocodeCandidate, type GeocoderUsage } from './geocoder.js';
import type { GeoPoint } from './points.js';

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface NeshanGeocoderOptions {
  serviceKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  kv?: KeyValueStore;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Where "results near a point" are centred when the caller gives none (the pilot region's first city). */
  defaultCenter?: GeoPoint;
  now?: () => number;
  /** Consecutive provider failures that open the breaker, and how long it stays open. */
  breakerThreshold?: number;
  breakerOpenMs?: number;
}

const DAY_MS = 86_400_000;
const USAGE_TTL_MS = 40 * DAY_MS;
// Iran, with a margin: answers outside are not accepted for the pilot region.
const BOUNDS = { latMin: 24, latMax: 40.5, lngMin: 43.5, lngMax: 64 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, max) : null;
};
function pointOf(v: unknown): GeoPoint | null {
  if (!isObj(v)) return null;
  const lng = Number(v.x);
  const lat = Number(v.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lngMin || lng > BOUNDS.lngMax) return null;
  return { lat, lng };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

export class NeshanGeocoder extends Geocoder {
  override readonly provider = 'neshan';
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #kv: KeyValueStore | undefined;
  readonly #timeout: number;
  readonly #ttl: number;
  readonly #center: GeoPoint;
  readonly #now: () => number;
  readonly #threshold: number;
  readonly #openMs: number;
  #failures = 0;
  #openUntil = 0;

  constructor(o: NeshanGeocoderOptions) {
    super();
    this.#key = o.serviceKey;
    this.#base = (o.baseUrl ?? 'https://api.neshan.org').replace(/\/+$/, '');
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#kv = o.kv;
    this.#timeout = o.timeoutMs ?? 3_000;
    this.#ttl = o.cacheTtlMs ?? DAY_MS;
    this.#center = o.defaultCenter ?? { lat: 35.6892, lng: 51.389 };
    this.#now = o.now ?? Date.now;
    this.#threshold = o.breakerThreshold ?? 5;
    this.#openMs = o.breakerOpenMs ?? 30_000;
  }

  async search(query: string, country: string, limit = 5, near?: GeoPoint): Promise<GeocodeCandidate[]> {
    const term = normalizeAddress(query);
    if (!term || country !== 'IR') return [];
    const c = near ?? this.#center;
    // The centre is rounded to about 1 km so that the cache is shared.
    const key = `geo:neshan:search:${hash(`${term}|${c.lat.toFixed(2)}|${c.lng.toFixed(2)}`)}`;
    const path = `/v1/search?term=${encodeURIComponent(query.trim().slice(0, 200))}&lat=${c.lat}&lng=${c.lng}`;
    return parseSearch(await this.#cached(key, path)).slice(0, limit);
  }

  async reverse(point: GeoPoint): Promise<GeocodeCandidate | null> {
    const key = `geo:neshan:reverse:${hash(`${point.lat.toFixed(5)}|${point.lng.toFixed(5)}`)}`;
    return parseReverse(await this.#cached(key, `/v5/reverse?lat=${point.lat}&lng=${point.lng}`), point);
  }

  async locate(address: AddressQuery): Promise<GeoPoint | null> {
    if (address.country !== 'IR') return null;
    const line = [address.address_line_1, address.city].filter(Boolean).join(', ').slice(0, 300);
    const key = `geo:neshan:locate:${hash(normalizeAddress(`${address.address_line_1}|${address.city}|${address.postal_code ?? ''}`))}`;
    return parseGeocode(await this.#cached(key, `/v4/geocoding?address=${encodeURIComponent(line)}`));
  }

  override async usage(now = this.#now()): Promise<GeocoderUsage> {
    if (!this.#kv) return { provider: this.provider, requests_today: null, requests_30d: null };
    let today = 0;
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const n = Number((await this.#kv.get(`geo:neshan:usage:${dayKey(now - i * DAY_MS)}`)) ?? 0);
      if (i === 0) today = n;
      total += n;
    }
    return { provider: this.provider, requests_today: today, requests_30d: total };
  }

  async #cached(cacheKey: string, path: string): Promise<unknown> {
    if (this.#kv && this.#ttl > 0) {
      const hit = await this.#kv.get(cacheKey);
      if (hit !== null) return JSON.parse(hit) as unknown;
    }
    const body = await this.#call(path);
    if (this.#kv && this.#ttl > 0) await this.#kv.set(cacheKey, JSON.stringify(body), { ttlMs: this.#ttl });
    return body;
  }

  #unavailable(detail: string): ApiError {
    return new ApiError('UNAVAILABLE', { detail, retryAfterMs: 60_000 });
  }

  async #call(path: string): Promise<unknown> {
    const now = this.#now();
    if (now < this.#openUntil) throw this.#unavailable('geocoder temporarily unavailable');
    // Usage counter (quota and cost): every request that leaves the server counts, failed or not.
    await this.#kv?.incr(`geo:neshan:usage:${dayKey(now)}`, 1, USAGE_TTL_MS).catch(() => undefined);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        headers: { 'Api-Key': this.#key, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      this.#fail();
      throw this.#unavailable('geocoder did not answer');
    }
    // 404: no result. Any other non-2xx: the key, the quota or the provider (the editor keeps working by typed address).
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      this.#fail();
      throw this.#unavailable(`geocoder answered ${res.status}`);
    }
    try {
      const body = await res.json();
      this.#failures = 0;
      return body;
    } catch {
      this.#fail();
      throw this.#unavailable('geocoder answer is not JSON');
    }
  }

  #fail(): void {
    if (++this.#failures >= this.#threshold) {
      this.#openUntil = this.#now() + this.#openMs;
      this.#failures = 0;
    }
  }
}

/** Search items to candidates; items without a usable point are dropped. */
export function parseSearch(body: unknown): GeocodeCandidate[] {
  if (!isObj(body) || !Array.isArray(body.items)) return [];
  const out: GeocodeCandidate[] = [];
  for (const it of body.items.slice(0, 50)) {
    if (!isObj(it)) continue;
    const point = pointOf(it.location);
    const title = text(it.title, 200);
    if (!point || !title) continue;
    const address = text(it.address, 200);
    const region = text(it.region, 100);
    const city = (region ?? '').split(/[،,-]/)[0]?.trim() ?? '';
    out.push({
      label: [title, address].filter(Boolean).join(', ').slice(0, 300),
      point,
      address_line_1: (address ?? title).slice(0, 200),
      city: city.slice(0, 100),
      region,
      postal_code: null,
      country: 'IR',
    });
  }
  return out;
}

export function parseGeocode(body: unknown): GeoPoint | null {
  if (!isObj(body) || body.status !== 'OK') return null;
  return pointOf(body.location);
}

export function parseReverse(body: unknown, at: GeoPoint): GeocodeCandidate | null {
  if (!isObj(body) || body.status !== 'OK') return null;
  const formatted = text(body.formatted_address, 300);
  if (!formatted) return null;
  const city = text(body.city, 100) ?? text(body.county, 100) ?? '';
  const route = text(body.route_name, 200);
  const postal = typeof body.postal_code === 'string' && /^\d{10}$/.test(body.postal_code) ? body.postal_code : null;
  return {
    label: formatted,
    point: at,
    address_line_1: (route ?? formatted).slice(0, 200),
    city,
    region: text(body.state, 100),
    postal_code: postal,
    country: 'IR',
  };
}
