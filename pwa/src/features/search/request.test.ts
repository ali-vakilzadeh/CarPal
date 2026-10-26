// P6.T8: the search URL rules (GD-14: enumerated filters only, never text or coordinates), guest requests (BA-16),
// refine vs run, chip editing, the filter counts and Reset.
import type { InterpretedIntent, ResultCard, SearchRequest } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { optionCount, resetFilters, activeFilters } from './filters';
import {
  EMPTY_URL_STATE,
  buildRequest,
  changeOf,
  chipKind,
  parseUrlState,
  refined,
  searchPath,
  switchedToParts,
  urlStateQuery,
  widerDistance,
  withChip,
  withoutChip,
  type SearchContext,
} from './request';

const ID = '0195f3b1-6a2b-7c3d-8e4f-123456789abc';
const ID2 = '0195f3b1-6a2b-7c3d-8e4f-123456789abd';
const ctx: SearchContext = {
  text: 'تق‌تق جلوبندی',
  location: { mode: 'chosen_city', city_key: 'tehran' },
  vehicleId: 'v1',
  entry: 'search_box',
};

describe('search URL state', () => {
  it('round-trips the enumerated filters, mode, sort, city and the vehicle switch', () => {
    const s = {
      mode: 'providers' as const,
      sort: 'distance' as const,
      city: 'tehran',
      vehicleFilter: false,
      filters: {
        open_now: true,
        verified_only: true,
        min_rating: '4.0',
        distance_km: 25,
        available_within_days: 7,
        price_tiers: ['premium', 'budget'] as ('premium' | 'budget')[],
        service_modes: ['mobile' as const],
        service_system_node_ids: [ID],
        brand_node_id: ID2,
      },
    };
    const q = urlStateQuery(s);
    expect(q).toBe(
      `?mode=providers&sort=distance&city=tehran&vf=0&km=25&rating=4.0&verified=1&open=1&avail=7&price=budget%2Cpremium&mobile=1&sys=${ID}&brand=${ID2}`,
    );
    expect(parseUrlState(new URLSearchParams(q), ['tehran'])).toEqual({
      ...s,
      filters: { ...s.filters, price_tiers: ['budget', 'premium'] },
    });
  });

  it('drops anything not enumerated: free text, unknown keys, bad ids, unknown cities, out-of-range numbers', () => {
    const s = parseUrlState(
      new URLSearchParams(
        'q=brakes&text=x&lat=35.7&mode=showcases&sort=soonest&km=900&rating=5&brand=not-an-id&city=paris&price=cheap&avail=99',
      ),
      ['tehran'],
    );
    expect(s).toEqual(EMPTY_URL_STATE);
  });

  it('never puts text, coordinates or a map area into the page URL', () => {
    const path = searchPath('fa', ID, { ...EMPTY_URL_STATE, city: 'tehran' });
    expect(path).toBe(`/fa/search/${ID}?city=tehran`);
    expect(path).not.toMatch(/جلوبندی|lat|lng|bbox/);
  });
});

describe('search requests', () => {
  it('guests send neither vehicle_id nor user_position (BA-16); their car goes as filters with the vehicle switch', () => {
    const req = buildRequest(
      { ...ctx, location: { mode: 'user_position', point: { lat: 35.7, lng: 51.4 } } },
      { ...EMPTY_URL_STATE, filters: { brand_node_id: ID } },
      { signedIn: false, fallbackCity: 'tehran' },
    );
    expect(req).toEqual({
      search_mode: 'all',
      entry_point: 'search_box',
      location: { mode: 'chosen_city', city_key: 'tehran' },
      sort: 'best_match',
      limit: 20,
      query_text: 'تق‌تق جلوبندی',
      filters: { brand_node_id: ID },
      vehicle_filter_applied: true,
    });
  });

  it('signed-in users send their car and position; a city in the URL wins over the stored location', () => {
    const signed = { signedIn: true, fallbackCity: 'tehran' };
    expect(
      buildRequest({ ...ctx, location: { mode: 'user_position', point: { lat: 35.7, lng: 51.4 } } }, EMPTY_URL_STATE, signed),
    ).toMatchObject({
      vehicle_id: 'v1',
      vehicle_filter_applied: true,
      location: { mode: 'user_position' },
    });
    expect(buildRequest(ctx, { ...EMPTY_URL_STATE, city: 'karaj' }, signed).location).toEqual({ mode: 'chosen_city', city_key: 'karaj' });
  });

  it('refines when only refinable fields changed and runs again for a new mode, text or car', () => {
    const o = { signedIn: true, fallbackCity: 'tehran' };
    const prev = buildRequest(ctx, EMPTY_URL_STATE, o);
    const filtered = buildRequest(ctx, { ...EMPTY_URL_STATE, filters: { open_now: true }, sort: 'rating' }, o);
    expect(changeOf(prev, filtered)).toEqual({ kind: 'refine', body: { filters: { open_now: true }, sort: 'rating' } });
    expect(changeOf(filtered, prev)).toEqual({ kind: 'refine', body: { filters: {}, sort: 'best_match' } });
    expect(changeOf(prev, buildRequest(ctx, { ...EMPTY_URL_STATE, mode: 'parts' }, o))).toEqual({ kind: 'run' });
    expect(changeOf(prev, buildRequest({ ...ctx, text: 'brakes' }, EMPTY_URL_STATE, o))).toEqual({ kind: 'run' });
    expect(changeOf(prev, buildRequest({ ...ctx, vehicleId: null }, EMPTY_URL_STATE, o))).toEqual({ kind: 'run' });
    const off = buildRequest(ctx, { ...EMPTY_URL_STATE, vehicleFilter: false }, o);
    expect(changeOf(prev, off)).toEqual({ kind: 'refine', body: { vehicle_filter_applied: false } });
  });

  it('mirrors the backend merge of search.refine', () => {
    const prev: SearchRequest = {
      search_mode: 'all',
      entry_point: 'map',
      location: { mode: 'chosen_city', city_key: 'tehran' },
      filters: { open_now: true },
    };
    const viewport = { center: { lat: 35.7, lng: 51.4 }, zoom: 12, bbox: { north: 35.8, south: 35.6, east: 51.5, west: 51.3 } };
    expect(refined(prev, { location: { mode: 'map_center', viewport }, sort: 'distance' })).toEqual({
      ...prev,
      location: { mode: 'map_center', viewport },
      sort: 'distance',
    });
  });
});

describe('chips', () => {
  const intent: InterpretedIntent = {
    target_type: 'provider',
    chips: [
      { kind: 'target_type', text: 'provider', label: { text: 'Shops', locale: 'en' }, removable: false },
      { kind: 'service_system', node_id: ID, label: { text: 'Suspension', locale: 'en' }, removable: true },
    ],
  };

  it('removes a removable chip, never the target', () => {
    expect(withoutChip(intent, 1).chips).toHaveLength(1);
    expect(withoutChip(intent, 0)).toEqual(intent);
  });

  it('adds a taxonomy chip once', () => {
    const chip = { kind: 'vehicle' as const, node_id: ID2, label: { text: 'BMW', locale: 'en' as const }, removable: true };
    expect(withChip(intent, chip).chips.map((c) => c.label.text)).toEqual(['Shops', 'Suspension', 'BMW']);
    expect(withChip(withChip(intent, chip), chip).chips).toHaveLength(3);
    expect(chipKind('vehicle_model')).toBe('vehicle');
    expect(chipKind('amenity')).toBeNull();
  });

  it('says when All switched to parts', () => {
    expect(switchedToParts('all', { ...intent, target_type: 'vendor' })).toBe(true);
    expect(switchedToParts('vendors', { ...intent, target_type: 'vendor' })).toBe(false);
  });
});

describe('widening and filter counts', () => {
  it('widens step by step', () => {
    expect(widerDistance(10)).toBe(25);
    expect(widerDistance(undefined)).toBe(100);
    expect(widerDistance(200)).toBeNull();
  });

  const card = (o: Partial<ResultCard> & { verified?: boolean; rating?: string | null }): ResultCard =>
    ({
      result_id: 'r',
      rank: 1,
      target: { type: 'organization', id: 'o' },
      organization: { id: 'o', verified: o.verified ?? false, overall_rating: o.rating ?? null, price_tier: 'budget' },
      item: null,
      location: null,
      reasons: [],
      open_now: o.open_now ?? null,
      next_available_slot: o.next_available_slot ?? null,
    }) as unknown as ResultCard;

  it('counts options only over a complete list', () => {
    const results = [card({ open_now: true, verified: true, rating: '4.6' }), card({ open_now: false, rating: '3.2' })];
    expect(optionCount(results, true, 'open_now')).toBe(1);
    expect(optionCount(results, true, 'min_rating', '4.0')).toBe(1);
    expect(optionCount(results, true, 'verified_only')).toBe(1);
    expect(optionCount(results, true, 'price_tiers', 'budget')).toBe(2);
    expect(optionCount(results, false, 'open_now')).toBeNull();
    expect(optionCount(results, true, 'warranty_offered')).toBeNull();
  });

  it('Reset keeps the car and the category', () => {
    const f = { open_now: true, min_rating: '4.0', brand_node_id: ID, service_system_node_ids: [ID2] };
    expect(resetFilters(f)).toEqual({ brand_node_id: ID, service_system_node_ids: [ID2] });
    expect(activeFilters(f)).toEqual(['open_now', 'min_rating']);
  });
});
