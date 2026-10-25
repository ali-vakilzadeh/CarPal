import type { TaxonomyNode } from '@carpal/api-contracts';
import { describe, expect, it, vi } from 'vitest';
import { TaxonomyCache, VERSION_TTL_MS } from './taxonomy';

const node = (id: string, sort: number, name: string, status: TaxonomyNode['status'] = 'active'): TaxonomyNode => ({
  id,
  type: 'vehicle_brand',
  parent_id: null,
  name: { text: name, locale: 'en' },
  description: null,
  slug: id,
  regions: [],
  attributes: null,
  sort_order: sort,
  status,
  merged_into_id: null,
});

describe('TaxonomyCache', () => {
  it('reads every page, keeps active nodes and sorts them', async () => {
    const page = vi.fn(async (_l: string, q: { cursor?: string }) =>
      q.cursor
        ? { items: [node('c', 1, 'Citroën'), node('x', 0, 'Gone', 'merged')], next_cursor: null }
        : { items: [node('b', 2, 'BMW'), node('a', 1, 'Audi')], next_cursor: 'p2' },
    );
    const cache = new TaxonomyCache({ version: async () => 'v1', page });
    const nodes = await cache.nodes('en', 'vehicle_brand');
    expect(nodes.map((n) => n.id)).toEqual(['a', 'c', 'b']);
    expect(page).toHaveBeenCalledTimes(2);
    await cache.nodes('en', 'vehicle_brand');
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('keys by language and parent, and drops everything when the version changes', async () => {
    let now = 0;
    let version = 'v1';
    const page = vi.fn(async () => ({ items: [node('a', 1, 'A')], next_cursor: null }));
    const cache = new TaxonomyCache({ version: async () => version, page }, () => now);
    await cache.nodes('en', 'vehicle_model', 'bmw');
    await cache.nodes('fa', 'vehicle_model', 'bmw');
    await cache.nodes('en', 'vehicle_model', 'audi');
    expect(page).toHaveBeenCalledTimes(3);

    version = 'v2';
    await cache.nodes('en', 'vehicle_model', 'bmw');
    expect(page).toHaveBeenCalledTimes(3); // version re-read only after the TTL
    now = VERSION_TTL_MS + 1;
    await cache.nodes('en', 'vehicle_model', 'bmw');
    expect(page).toHaveBeenCalledTimes(4);
  });

  it('forgets a failed load', async () => {
    let fail = true;
    const page = vi.fn(async () => {
      if (fail) throw new Error('down');
      return { items: [], next_cursor: null };
    });
    const cache = new TaxonomyCache({ version: async () => 'v1', page });
    await expect(cache.nodes('en', 'vehicle_brand')).rejects.toThrow('down');
    fail = false;
    await expect(cache.nodes('en', 'vehicle_brand')).resolves.toEqual([]);
  });
});
