'use client';
// Taxonomy in the browser (P3.T7, BA-32): taxonomy.snapshot through the BFF, held in the TanStack cache under the
// taxonomy version from config.client (an opaque string compared for equality), so a catalogue change refetches and
// nothing else does. Memory only — no IndexedDB (plan: "client IndexedDB-free memory").
import type { TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api/query';
import { useLocale } from '@/lib/i18n/client';
import { useTaxonomyVersion } from './client';
import { sortNodes } from './taxonomy-order';

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export function taxonomyQueryKey(version: string, locale: string, type: TaxonomyType, parentId?: string | null) {
  return ['taxonomy', version, locale, type, parentId ?? null] as const;
}

/** Every active node of a type (under a parent), sorted for pickers. Disabled until `enabled`. */
export function useTaxonomyNodes(type: TaxonomyType, parentId?: string | null, enabled = true) {
  const api = useApiClient();
  const version = useTaxonomyVersion();
  const locale = useLocale();
  return useQuery<TaxonomyNode[]>({
    queryKey: taxonomyQueryKey(version, locale, type, parentId),
    enabled,
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    queryFn: async ({ signal }) => {
      const out: TaxonomyNode[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await api.api('taxonomy.snapshot', {
          query: { type, limit: PAGE_LIMIT, ...(parentId ? { parent_id: parentId } : {}), ...(cursor ? { cursor } : {}) },
          signal,
        });
        out.push(...page.items);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      return sortNodes(out.filter((n) => n.status === 'active'));
    },
  });
}
