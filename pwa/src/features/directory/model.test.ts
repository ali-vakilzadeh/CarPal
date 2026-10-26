// P6.T7: directory paths, the index rule (≥ 3 providers, never a series refinement) and the intro counted from
// structured data (shops, verified businesses, verified jobs from the capability reasons).
import type { ResultCard } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import { directoryPath, directoryStats, facetsPath, headingKind, indexable, isSlug } from './model';

const card = (org: string, verified: boolean, jobs?: number) =>
  ({
    organization: { id: org, verified },
    reasons: [
      { reason_type: 'location', values: {} },
      ...(jobs === undefined ? [] : [{ reason_type: 'capability_evidence', values: { jobs, level: 3 } }]),
    ],
  }) as unknown as ResultCard;

describe('directory pages', () => {
  it('builds city × category × brand paths in either language', () => {
    expect(directoryPath('fa', 'tehran', 'suspension', 'bmw')).toBe('/fa/tehran/suspension/bmw');
    expect(directoryPath('en', 'tehran', 'bmw')).toBe('/en/tehran/bmw');
    const f = { city: { key: 'karaj', name: 'Karaj' }, category: { id: 'c', slug: 'brakes', name: 'Brakes' }, brand: null };
    expect(facetsPath('en', f)).toBe('/en/karaj/brakes');
    expect(headingKind(f)).toBe('category');
    expect(headingKind({ category: null, brand: { id: 'b', slug: 'bmw', name: 'BMW' } })).toBe('brand');
  });

  it('accepts taxonomy slugs only', () => {
    expect(isSlug('air-conditioning')).toBe(true);
    expect(isSlug('Air Conditioning')).toBe(false);
    expect(isSlug('../etc')).toBe(false);
  });

  it('indexes pages with at least 3 providers and never a series refinement', () => {
    expect(indexable(3, { series: null })).toBe(true);
    expect(indexable(2, { series: null })).toBe(false);
    expect(indexable(10, { series: { id: 's', slug: 'e90', name: 'E90', modelId: 'm' } })).toBe(false);
  });

  it('counts shops, verified businesses and verified jobs once per business', () => {
    expect(directoryStats([card('a', true, 27), card('a', true, 30), card('b', false, 4), card('c', true)])).toEqual({
      shops: 3,
      verified: 2,
      jobs: 34,
    });
  });
});
