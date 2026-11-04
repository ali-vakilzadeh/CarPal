// P14.T2/T3/T5: the server facet mapping (enum, boolean, min_rating, availability, capped, empty; service systems and
// part categories are no facets), the filters-too-narrow order, the soonest slot in the shop's time zone, and the
// request behind a session read again with search.session_get.
import type { SearchFacets, SearchRequest, SearchResponse } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { createFormatter } from '@/lib/format';
import type { Translate } from '@/lib/i18n/keys';
import { FEW_RESULTS, facetCount, narrowingFilter, resultTotal, wideningFilters } from './facets';
import { slotText } from './result-card';
import { rereadRequest } from './use-search';

const facets = (o: Partial<SearchFacets> = {}): SearchFacets => ({
  result_count: 14,
  capped: false,
  facets: [
    {
      key: 'verified_only',
      counts: [{ value: 'true', count: 2, selected: false }],
    },
    {
      key: 'min_rating',
      counts: [
        { value: '3', count: 12, selected: false },
        { value: '4', count: 7, selected: true },
        { value: '4.5', count: 3, selected: false },
      ],
    },
    {
      key: 'available_within_days',
      counts: [
        { value: '0', count: 1, selected: false },
        { value: '7', count: 5, selected: false },
      ],
    },
    {
      key: 'price_tiers',
      counts: [
        { value: 'budget', count: 6, selected: false },
        { value: 'premium', count: 0, selected: false },
      ],
    },
    { key: 'service_modes', counts: [{ value: 'mobile', count: 4, selected: false }] },
  ],
  without_filter: [],
  ...o,
});

describe('facet counts', () => {
  it('maps boolean, rating, availability and enum options to the server counts', () => {
    const f = facets();
    expect(facetCount(f, 'verified_only')).toEqual({ count: 2, capped: false });
    // The panel's ratings are '4.0'; the backend's options are '4' — numbers compare.
    expect(facetCount(f, 'min_rating', '4.0')).toEqual({ count: 7, capped: false });
    expect(facetCount(f, 'min_rating', '4.5')).toEqual({ count: 3, capped: false });
    expect(facetCount(f, 'available_within_days', 0)).toEqual({ count: 1, capped: false });
    expect(facetCount(f, 'available_within_days', 7)).toEqual({ count: 5, capped: false });
    expect(facetCount(f, 'price_tiers', 'premium')).toEqual({ count: 0, capped: false });
    expect(facetCount(f, 'service_modes', 'mobile')).toEqual({ count: 4, capped: false });
  });

  it('shows no number for options the response leaves out, for non-facets and without facets', () => {
    const f = facets();
    expect(facetCount(f, 'min_rating', '3.5')).toBeNull();
    expect(facetCount(f, 'open_now')).toBeNull();
    expect(facetCount(f, 'distance_km', 25)).toBeNull();
    expect(facetCount(null, 'verified_only')).toBeNull();
    expect(facetCount(facets({ facets: [] }), 'verified_only')).toBeNull();
  });

  it('marks every count as a lower bound when retrieval was capped', () => {
    const f = facets({ capped: true, result_count: 100 });
    expect(facetCount(f, 'verified_only')).toEqual({ count: 2, capped: true });
    expect(resultTotal(f)).toEqual({ count: 100, capped: true });
    expect(resultTotal(null)).toBeNull();
  });
});

describe('filters too narrow', () => {
  const filters = { verified_only: true, open_now: true, min_rating: '4.0', distance_km: 10, service_system_node_ids: ['n1'] };
  const f = facets({
    result_count: 1,
    without_filter: [
      { key: 'open_now', count_without: 4 },
      { key: 'verified_only', count_without: 12 },
      { key: 'min_rating', count_without: 2 },
    ],
  });

  it('orders the removable filters by the results each removal brings back, then the uncounted ones', () => {
    expect(wideningFilters(filters, f).map((w) => [w.key, w.without?.count ?? null])).toEqual([
      ['verified_only', 12],
      ['open_now', 4],
      ['min_rating', 2],
      ['distance_km', null],
    ]);
    // Service systems are no filter of the panel and no facet (backend DI-74); distance is offered as Widen.
    expect(wideningFilters(filters, f, ['distance_km']).map((w) => w.key)).toEqual(['verified_only', 'open_now', 'min_rating']);
    // Without facets: the panel order, no numbers.
    expect(wideningFilters({ verified_only: true, open_now: true }, null)).toEqual([
      { key: 'open_now', without: null },
      { key: 'verified_only', without: null },
    ]);
  });

  it('names the filter that removed most results when results are few', () => {
    expect(narrowingFilter(filters, f)).toEqual({ key: 'verified_only', without: { count: 12, capped: false } });
    expect(narrowingFilter(filters, { ...f, result_count: FEW_RESULTS })).toBeNull();
    expect(narrowingFilter(filters, { ...f, without_filter: [{ key: 'open_now', count_without: 1 }] })).toBeNull();
    expect(narrowingFilter(filters, null)).toBeNull();
  });
});

describe('soonest slot', () => {
  const t = ((key: string, o: Record<string, string>) => `${key.split('.').pop()} ${o.date ?? ''}${o.time}`.trim()) as unknown as Translate;
  const now = Date.parse('2026-11-03T08:00:00Z'); // 11:30 in Tehran

  it('reads the slot on the shop’s clock: today, tomorrow or a date', () => {
    const en = createFormatter('en', t, 'Europe/London');
    expect(slotText('2026-11-03T11:00:00Z', en, t, 'Asia/Tehran', now)).toBe('slotToday 2:30 PM');
    expect(slotText('2026-11-04T05:30:00Z', en, t, 'Asia/Tehran', now)).toBe('slotTomorrow 9:00 AM');
    expect(slotText('2026-11-06T07:00:00Z', en, t, 'Asia/Tehran', now)).toBe('slotOn Nov 610:30 AM');
    // 22:00 UTC on the 3rd is already the 4th in Tehran.
    expect(slotText('2026-11-03T22:00:00Z', en, t, 'Asia/Tehran', now)).toBe('slotTomorrow 1:30 AM');
  });

  it('uses Jalali dates and 24-hour times in Persian', () => {
    const fa = createFormatter('fa', t, 'Asia/Tehran');
    expect(slotText('2026-11-03T11:00:00Z', fa, t, 'Asia/Tehran', now)).toBe('slotToday ۱۴:۳۰');
    expect(slotText('2026-11-06T07:00:00Z', fa, t, 'Asia/Tehran', now)).toMatch(/^slotOn ۱۵ آبان/);
  });
});

describe('a session read again (search.session_get)', () => {
  const fromUrl: SearchRequest = {
    search_mode: 'all',
    entry_point: 'search_box',
    location: { mode: 'chosen_city', city_key: 'tehran' },
    filters: { verified_only: true },
    facets: true,
  };
  const intent = { target_type: 'provider' as const, chips: [] };
  const response = { session_id: 's1', query_normalized: 'brake pads', interpreted_intent: intent } as unknown as SearchResponse;

  it('keeps the stored request of this tab', () => {
    const stored = { ...fromUrl, query_text: 'Brake pads!' };
    expect(rereadRequest(response, stored, null)).toBe(stored);
  });

  it('builds one from the URL and the session’s own text and chips in a new tab', () => {
    expect(rereadRequest(response, null, fromUrl)).toEqual({ ...fromUrl, query_text: 'brake pads', intent_override: intent });
    expect(rereadRequest(response, null, null)).toBeNull();
  });
});
