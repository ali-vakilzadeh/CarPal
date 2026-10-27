// S10 (contract 1.1.0): facet counting, the availability window, the shared
// index filters and the ranking's 14-day slot cutoff.
import { describe, expect, it } from 'vitest';
import { computeFacets, facetKeys, indexFilters, isActive, PROVIDER_FILTERS, slotWithinDays, type FacetFilters } from './facets.js';
import { availabilityFit, rankingSlot } from './ranking.js';

/** A tiny result set the counter selects from, with the run's own semantics (OR within a Set filter). */
const rows = [
  { rating: 4.6, verified: true, modes: ['in_shop'], open: true, langs: ['fa'] },
  { rating: 4.1, verified: false, modes: ['mobile'], open: false, langs: ['fa', 'en'] },
  { rating: 3.2, verified: true, modes: ['in_shop', 'mobile'], open: true, langs: ['ar'] },
  { rating: null, verified: false, modes: ['pickup_dropoff'], open: false, langs: [] },
];
const count = (f: FacetFilters): number =>
  rows.filter(
    (r) =>
      (!f.min_rating || (r.rating ?? 0) >= Number(f.min_rating)) &&
      (!f.verified_only || r.verified) &&
      (!f.open_now || r.open) &&
      (!f.service_modes?.length || r.modes.some((m) => f.service_modes!.includes(m))) &&
      (!f.languages?.length || r.langs.some((l) => f.languages!.includes(l))),
  ).length;

const facet = (facets: ReturnType<typeof computeFacets>, key: string) => facets.facets.find((x) => x.key === key)!;

describe('computeFacets', () => {
  it('counts each option with the other filters kept and the facet’s own selection replaced (OR within a Set facet)', () => {
    const filters: FacetFilters = { verified_only: true, service_modes: ['in_shop'] };
    const out = computeFacets({
      target: 'provider',
      filters,
      count,
      resultCount: count(filters),
      capped: false,
      languages: ['fa', 'en', 'ar'],
    });
    expect(out.result_count).toBe(2);
    const modes = facet(out, 'service_modes').counts;
    // verified rows: #0 (in_shop), #2 (in_shop, mobile)
    expect(modes).toEqual([
      { value: 'in_shop', count: 2, selected: true },
      { value: 'mobile', count: 1, selected: false },
      { value: 'pickup_dropoff', count: 0, selected: false },
    ]);
    // verified_only replaced by itself: the count with the option equals the current results; open now keeps verified + in_shop.
    expect(facet(out, 'verified_only').counts).toEqual([{ value: 'true', count: 2, selected: true }]);
    expect(facet(out, 'open_now').counts).toEqual([{ value: 'true', count: 2, selected: false }]);
    expect(facet(out, 'min_rating').counts.map((c) => [c.value, c.count])).toEqual([
      ['3', 2],
      ['3.5', 1],
      ['4', 1],
      ['4.5', 1],
    ]);
  });

  it('names the result of removing each active filter (filters too narrow)', () => {
    const filters: FacetFilters = { verified_only: true, open_now: true, service_modes: ['pickup_dropoff'] };
    const out = computeFacets({ target: 'provider', filters, count, resultCount: 0, capped: false, languages: [] });
    expect(out.without_filter).toEqual([
      { key: 'verified_only', count_without: 0 },
      { key: 'open_now', count_without: 0 },
      { key: 'service_modes', count_without: 2 },
    ]);
  });

  it('lists the selected languages and the spoken ones with results, by count', () => {
    const out = computeFacets({
      target: 'provider',
      filters: { languages: ['de'] },
      count,
      resultCount: 0,
      capped: true,
      languages: ['ar', 'en', 'fa'],
    });
    expect(out.capped).toBe(true);
    expect(facet(out, 'languages').counts).toEqual([
      { value: 'de', count: 0, selected: true },
      { value: 'fa', count: 2, selected: false },
      { value: 'ar', count: 1, selected: false },
      { value: 'en', count: 1, selected: false },
    ]);
  });

  it('offers the facets of the target type only', () => {
    expect(facetKeys('inventory_item')).toEqual(['open_now', 'part_conditions', 'stock_available']);
    expect(facetKeys('vendor')).not.toContain('available_within_days');
    const place = facetKeys('place');
    expect(new Set(place).size).toBe(place.length);
    expect(place).toEqual(expect.arrayContaining(['available_within_days', 'vendor_types', 'trade_pricing']));
    expect(place).not.toContain('part_conditions');
  });

  it('treats 0 days as an active availability filter', () => {
    expect(isActive({ available_within_days: 0 }, 'available_within_days')).toBe(true);
    expect(isActive({ service_modes: [] }, 'service_modes')).toBe(false);
    expect(isActive({ verified_only: false }, 'verified_only')).toBe(false);
  });
});

describe('index filters shared by search, facets and the map', () => {
  it('builds the provider document filters of a filter set', () => {
    expect(indexFilters(PROVIDER_FILTERS, { min_rating: '4.5', ev_capable: true, price_tiers: ['budget'], service_modes: [] })).toEqual([
      { field: 'overall_rating', gte: 4.5 },
      { field: 'price_tier', in: ['budget'] },
      { field: 'ev_ready', eq: true },
    ]);
    expect(indexFilters(PROVIDER_FILTERS, undefined)).toEqual([]);
  });
});

describe('slotWithinDays (available_within_days, 0 = today)', () => {
  const tz = 'Asia/Tehran'; // UTC+03:30
  const now = new Date('2026-10-26T08:00:00Z'); // 11:30 in Tehran
  it('today ends at local midnight', () => {
    expect(slotWithinDays('2026-10-26T20:29:00Z', 0, tz, now)).toBe(true); // 23:59 local
    expect(slotWithinDays('2026-10-26T20:30:00Z', 0, tz, now)).toBe(false); // 00:00 next day local
  });
  it('N days include the N-th day after today', () => {
    expect(slotWithinDays('2026-11-02T20:29:00Z', 7, tz, now)).toBe(true);
    expect(slotWithinDays('2026-11-02T20:31:00Z', 7, tz, now)).toBe(false);
  });
  it('no slot never matches', () => {
    expect(slotWithinDays(null, 30, tz, now)).toBe(false);
  });
});

describe('ranking slot cutoff (scores unchanged by the 30-day projection)', () => {
  const now = Date.parse('2026-10-26T08:00:00Z');
  it('counts a slot in the first 14 days only', () => {
    expect(rankingSlot('2026-11-08T08:00:00Z', now)).toBe('2026-11-08T08:00:00Z');
    expect(rankingSlot('2026-11-10T08:00:01Z', now)).toBeNull();
    expect(availabilityFit(rankingSlot('2026-11-20T08:00:00Z', now), now)).toBeNull();
  });
});
