// Geocoder port (40 geo.geocode / geo.reverse / org.location_pin_check; Plan
// §2: a self-hosted geocoder per region, never a consumer search-as-you-type).
// Full mode talks to the region's geocoder service (not built yet: it answers
// 503). Lite mode uses FixtureGeocoder: a small, deterministic address list of
// the pilot cities, so the location editor and the pin-versus-address check
// work end to end without network access. Results are third-party data and
// are validated by the callers like client input (SEC-IN-10).
import { ApiError } from '#libs/contract/index.js';
import { distanceMeters, type GeoPoint } from './points.js';

/** 40 §7.1 GeocodeCandidate. */
export interface GeocodeCandidate {
  label: string;
  point: GeoPoint;
  address_line_1: string;
  city: string;
  region: string | null;
  postal_code: string | null;
  country: string;
}

export interface AddressQuery {
  address_line_1: string;
  city: string;
  postal_code?: string | null;
  country: string;
}

export abstract class Geocoder {
  /** Address search in one country, best first (≤ `limit`). */
  abstract search(query: string, country: string, limit?: number): Promise<GeocodeCandidate[]>;
  /** The nearest address of a point, or null when nothing is close. */
  abstract reverse(point: GeoPoint): Promise<GeocodeCandidate | null>;
  /** The point of a typed street address; null when it cannot be placed more precisely than a city. */
  abstract locate(address: AddressQuery): Promise<GeoPoint | null>;
}

/** Full mode until the regional geocoder adapter exists. */
export class UnconfiguredGeocoder extends Geocoder {
  #fail(): never {
    throw new ApiError('UNAVAILABLE', { detail: 'geocoder not configured', retryAfterMs: 60_000 });
  }
  search(): Promise<GeocodeCandidate[]> {
    return Promise.resolve().then(() => this.#fail());
  }
  reverse(): Promise<GeocodeCandidate | null> {
    return Promise.resolve().then(() => this.#fail());
  }
  locate(): Promise<GeoPoint | null> {
    return Promise.resolve().then(() => this.#fail());
  }
}

interface FixtureAddress {
  address_line_1: string;
  /** Alternative spellings (Persian script, abbreviations). */
  aliases: string[];
  city: string;
  cityAliases: string[];
  region: string | null;
  postal_code: string | null;
  country: string;
  point: GeoPoint;
}

interface FixtureCity {
  city: string;
  aliases: string[];
  region: string | null;
  country: string;
  point: GeoPoint;
}

const CITIES: FixtureCity[] = [
  { city: 'Tehran', aliases: ['تهران'], region: 'Tehran', country: 'IR', point: { lat: 35.6892, lng: 51.389 } },
  { city: 'Karaj', aliases: ['کرج'], region: 'Alborz', country: 'IR', point: { lat: 35.8327, lng: 50.9915 } },
  { city: 'Isfahan', aliases: ['اصفهان'], region: 'Isfahan', country: 'IR', point: { lat: 32.6539, lng: 51.666 } },
  { city: 'Mashhad', aliases: ['مشهد'], region: 'Razavi Khorasan', country: 'IR', point: { lat: 36.2972, lng: 59.6067 } },
  { city: 'Shiraz', aliases: ['شیراز'], region: 'Fars', country: 'IR', point: { lat: 29.5918, lng: 52.5837 } },
  { city: 'Tabriz', aliases: ['تبریز'], region: 'East Azerbaijan', country: 'IR', point: { lat: 38.0962, lng: 46.2738 } },
  { city: 'Qom', aliases: ['قم'], region: 'Qom', country: 'IR', point: { lat: 34.6416, lng: 50.8746 } },
];

const tehran = { city: 'Tehran', cityAliases: ['تهران'], region: 'Tehran', country: 'IR' };

/** Street-level fixtures (lite mode and tests). */
export const FIXTURE_ADDRESSES: FixtureAddress[] = [
  {
    ...tehran,
    address_line_1: '1200 Valiasr Street',
    aliases: ['خیابان ولیعصر ۱۲۰۰', 'Valiasr St 1200'],
    postal_code: '1511733111',
    point: { lat: 35.757512, lng: 51.410621 },
  },
  {
    ...tehran,
    address_line_1: '45 Shariati Street',
    aliases: ['خیابان شریعتی ۴۵', 'Shariati St 45'],
    postal_code: '1661635411',
    point: { lat: 35.731842, lng: 51.442317 },
  },
  {
    ...tehran,
    address_line_1: '18 Azadi Street',
    aliases: ['خیابان آزادی ۱۸', 'Azadi St 18'],
    postal_code: '1458889694',
    point: { lat: 35.700164, lng: 51.351287 },
  },
  {
    ...tehran,
    address_line_1: '7 Enghelab Street',
    aliases: ['خیابان انقلاب ۷', 'Enghelab St 7'],
    postal_code: '1314763811',
    point: { lat: 35.701119, lng: 51.401912 },
  },
  {
    city: 'Karaj',
    cityAliases: ['کرج'],
    region: 'Alborz',
    country: 'IR',
    address_line_1: '10 Taleghani Boulevard',
    aliases: ['بلوار طالقانی ۱۰', 'Taleghani Blvd 10'],
    postal_code: '3146783311',
    point: { lat: 35.826401, lng: 50.969231 },
  },
  {
    city: 'Isfahan',
    cityAliases: ['اصفهان'],
    region: 'Isfahan',
    country: 'IR',
    address_line_1: '3 Chaharbagh Abbasi Street',
    aliases: ['خیابان چهارباغ عباسی ۳', 'Chaharbagh St 3'],
    postal_code: '8143913111',
    point: { lat: 32.651023, lng: 51.668492 },
  },
];

const PERSIAN_DIGITS = /[۰-۹٠-٩]/g;
/** Lower-case, NFC, Persian/Arabic digits → Latin, Arabic ي/ك → Persian, punctuation → space, collapsed spaces. */
export function normalizeAddress(s: string): string {
  return s
    .normalize('NFC')
    .replace(PERSIAN_DIGITS, (d) => String((d.charCodeAt(0) - (d >= '۰' ? 0x6f0 : 0x660)) % 10))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase()
    .replace(/[.,;:#،/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REVERSE_STREET_M = 500;
const REVERSE_CITY_M = 25_000;

export class FixtureGeocoder extends Geocoder {
  constructor(
    private readonly addresses: FixtureAddress[] = FIXTURE_ADDRESSES,
    private readonly cities: FixtureCity[] = CITIES,
  ) {
    super();
  }

  #addressCandidate(a: FixtureAddress): GeocodeCandidate {
    return {
      label: `${a.address_line_1}, ${a.city}`,
      point: a.point,
      address_line_1: a.address_line_1,
      city: a.city,
      region: a.region,
      postal_code: a.postal_code,
      country: a.country,
    };
  }

  #cityCandidate(c: FixtureCity): GeocodeCandidate {
    return { label: c.city, point: c.point, address_line_1: '', city: c.city, region: c.region, postal_code: null, country: c.country };
  }

  async search(query: string, country: string, limit = 5): Promise<GeocodeCandidate[]> {
    const tokens = normalizeAddress(query).split(' ').filter(Boolean);
    if (tokens.length === 0) return [];
    const matches = (texts: string[]) => {
      const hay = texts.map(normalizeAddress).join(' ');
      return tokens.every((t) => hay.includes(t));
    };
    const out: GeocodeCandidate[] = [];
    for (const a of this.addresses)
      if (a.country === country && matches([a.address_line_1, ...a.aliases, a.city, ...a.cityAliases, a.postal_code ?? '']))
        out.push(this.#addressCandidate(a));
    for (const c of this.cities) if (c.country === country && matches([c.city, ...c.aliases])) out.push(this.#cityCandidate(c));
    return out.slice(0, limit);
  }

  async reverse(point: GeoPoint): Promise<GeocodeCandidate | null> {
    const nearest = <T extends { point: GeoPoint }>(list: T[]) =>
      list
        .map((x) => ({ x, d: distanceMeters(point, x.point) }))
        .sort((a, b) => a.d - b.d)
        .at(0);
    const street = nearest(this.addresses);
    if (street && street.d <= REVERSE_STREET_M) return this.#addressCandidate(street.x);
    const city = nearest(this.cities);
    if (city && city.d <= REVERSE_CITY_M) return this.#cityCandidate(city.x);
    return null;
  }

  async locate(q: AddressQuery): Promise<GeoPoint | null> {
    const line = normalizeAddress(q.address_line_1);
    const city = normalizeAddress(q.city);
    const postal = q.postal_code ? normalizeAddress(q.postal_code) : null;
    const hit = this.addresses.find(
      (a) =>
        a.country === q.country &&
        [a.address_line_1, ...a.aliases].some((s) => normalizeAddress(s) === line) &&
        [a.city, ...a.cityAliases].some((s) => normalizeAddress(s) === city) &&
        (!postal || !a.postal_code || a.postal_code === postal),
    );
    return hit ? hit.point : null;
  }
}

export type LocationCheckStatus = 'not_checked' | 'consistent' | 'far_apart';

/** Pin-versus-address check (52 OrganizationLocation): far_apart above the region threshold; never blocks saving. */
export function pinCheck(
  pin: GeoPoint,
  geocoded: GeoPoint | null,
  thresholdM: number,
): { distance_m: number | null; location_check_status: LocationCheckStatus } {
  if (!geocoded) return { distance_m: null, location_check_status: 'not_checked' };
  const d = distanceMeters(pin, geocoded);
  return { distance_m: d, location_check_status: d <= thresholdM ? 'consistent' : 'far_apart' };
}
