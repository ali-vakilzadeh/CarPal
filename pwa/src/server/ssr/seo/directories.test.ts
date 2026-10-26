// P6.T7: the directories sitemap lists city × top-level category pages with at least 3 providers, in region and
// taxonomy order, within the search budget (Docs/22 open point 6). Also the map origins the page CSP admits (GD-12).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
vi.mock('../api', () => ({ ssrApi: () => ({ api: run }) }));
vi.mock('@/server/taxonomy', () => ({
  taxonomy: () => ({
    nodes: async () => [
      { id: 's1', slug: 'suspension', parent_id: null },
      { id: 's2', slug: 'brakes', parent_id: null },
      { id: 's3', slug: 'brake-pads-sub', parent_id: 's2' },
    ],
  }),
}));
vi.mock('@/server/config', async () => {
  const { fallbackConfig } = await vi.importActual<typeof import('@/server/config')>('@/server/config');
  return { loadClientConfig: async () => ({ config: fallbackConfig('fa'), source: 'fallback', fetchedAt: 0 }) };
});

const { directoryEntries } = await import('./sitemap');
const { mapTileOrigins } = await import('@/server/map-config');

beforeEach(() => {
  run.mockReset();
});

describe('directories sitemap', () => {
  it('lists combinations with ≥ 3 providers and stops at the budget', async () => {
    run.mockImplementation(
      async (_op: string, args: { body: { location: { city_key: string }; filters: { service_system_node_ids: string[] } } }) => {
        const enough = args.body.location.city_key === 'tehran' && args.body.filters.service_system_node_ids[0] === 's1';
        return { results: enough ? [{}, {}, {}] : [{}, {}] };
      },
    );
    const entries = await directoryEntries(5);
    expect(entries).toEqual([{ paths: { fa: '/fa/tehran/suspension', en: '/en/tehran/suspension' } }]);
    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls[0]).toEqual([
      'search.run',
      {
        body: {
          search_mode: 'providers',
          entry_point: 'directory_page',
          location: { mode: 'chosen_city', city_key: 'tehran' },
          filters: { service_system_node_ids: ['s1'] },
          limit: 3,
        },
      },
    ]);
  });
});

describe('map origins in the CSP', () => {
  it('admits the env style and the pilot region file’s style and tile hosts', () => {
    expect(mapTileOrigins({ CARPAL_PWA_MAP_STYLE_URL: undefined })).toEqual(['https://cdn.carpal.app']);
    expect(mapTileOrigins({ CARPAL_PWA_MAP_STYLE_URL: 'https://tiles.carpal.test/style.json' })).toEqual([
      'https://tiles.carpal.test',
      'https://cdn.carpal.app',
    ]);
  });
});
