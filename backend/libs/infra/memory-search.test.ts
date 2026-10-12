// Lite SearchIndex (S6.T1): analyzed text with Persian/Arabic variants,
// prefix and one-edit typo matches, term filters on arrays and nested paths,
// geo radius with per-point service radius, bbox, ordering.
import { describe, expect, it } from 'vitest';
import { MemorySearchIndex, matchesFilter, tokenMatch, withinOneEdit } from './index.js';

const doc = (o: Record<string, unknown>) => ({ name: 'x', locations: [], ...o });

describe('MemorySearchIndex', () => {
  it('matches Persian text typed with Arabic letters and digits, prefixes and one-edit typos', async () => {
    const ix = new MemorySearchIndex();
    await ix.upsert('t', 'a', doc({ name: { fa: 'تعمیرگاه کریمی ۲۴', en: 'Karimi Garage 24' } }));
    await ix.upsert('t', 'b', doc({ name: { en: 'Brake Masters' } }));
    const q = (query: string) => ix.search('t', { text: { query, fields: { name: 1 } } }).then((r) => r.hits.map((h) => h.id));
    expect(await q('كريمي 24')).toEqual(['a']);
    expect(await q('تعمیرگاه کریمی ٢٤')).toEqual(['a']);
    expect(await q('brak')).toEqual(['b']);
    expect(await q('masters')).toEqual(['b']);
    expect(await q('karimy garage')).toEqual(['a']);
    expect(await q('unrelated words')).toEqual([]);
    expect(withinOneEdit('garage', 'garge')).toBe(true);
    expect(withinOneEdit('garage', 'grgae')).toBe(false);
    expect(tokenMatch('bra', ['brake'], true)).toBe(0.7);
    expect(tokenMatch('bra', ['brake'], false)).toBe(0);
  });

  it('filters by term, array containment, range, existence, negation and any-of, also on nested paths', () => {
    const d = { tags: ['a', 'b'], rating: 4.5, locations: [{ city: 'Tehran' }, { city: 'Karaj' }], none: null };
    expect(matchesFilter(d, { field: 'tags', eq: 'a' })).toBe(true);
    expect(matchesFilter(d, { field: 'tags', in: ['x', 'b'] })).toBe(true);
    expect(matchesFilter(d, { field: 'tags', all: ['a', 'b'] })).toBe(true);
    expect(matchesFilter(d, { field: 'tags', all: ['a', 'c'] })).toBe(false);
    expect(matchesFilter(d, { field: 'rating', gte: 4, lte: 5 })).toBe(true);
    expect(matchesFilter(d, { field: 'rating', gte: 4.6 })).toBe(false);
    expect(matchesFilter(d, { field: 'locations.city', eq: 'Karaj' })).toBe(true);
    expect(matchesFilter(d, { field: 'none', exists: false })).toBe(true);
    expect(matchesFilter(d, { not: { field: 'tags', eq: 'a' } })).toBe(false);
    expect(
      matchesFilter(d, {
        any: [
          { field: 'tags', eq: 'z' },
          { field: 'rating', gte: 4 },
        ],
      }),
    ).toBe(true);
  });

  it("restricts by radius (or the point's own service radius) and bbox, nearest first, and removes by filter", async () => {
    const ix = new MemorySearchIndex();
    const origin = { lat: 35.7, lng: 51.4 };
    await ix.upsert('t', 'near', doc({ locations: [{ point: { lat: 35.71, lng: 51.4 }, service_radius_km: null }] }));
    await ix.upsert('t', 'far', doc({ locations: [{ point: { lat: 36.2, lng: 51.4 }, service_radius_km: null }] }));
    await ix.upsert('t', 'mobile', doc({ locations: [{ point: { lat: 36.0, lng: 51.4 }, service_radius_km: 40 }] }));
    const r = await ix.search('t', { geo: { field: 'locations.point', origin, radiusKm: 10, pointRadiusField: 'service_radius_km' } });
    expect(r.hits.map((h) => h.id)).toEqual(['near', 'mobile']);
    expect(r.hits[0]!.distanceKm).toBeCloseTo(1.1, 1);
    const box = await ix.search('t', { geo: { field: 'locations.point', bbox: { south: 35.9, west: 51, north: 36.5, east: 52 } } });
    expect(box.hits.map((h) => h.id).sort()).toEqual(['far', 'mobile']);
    expect(await ix.removeWhere('t', [{ field: 'locations.service_radius_km', exists: true }])).toBe(1);
    expect((await ix.ids('t')).sort()).toEqual(['far', 'near']);
    expect(await ix.get('t', 'mobile')).toBeNull();
  });
});
