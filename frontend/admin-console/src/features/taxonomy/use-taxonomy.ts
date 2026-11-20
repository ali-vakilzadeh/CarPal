'use client';
// Taxonomy reads and URL state (AC12). A type is read whole (admin.taxonomy_snapshot, every status, 500 per page; the
// catalog has fewer than 200 nodes per type, Docs/44), so the tree, the search and the pickers work in the browser.
// The query key starts with the operation id, so invalidating ['admin.taxonomy_snapshot'] after a write reads again.
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { StaffTaxonomyNode } from '@carpal/api-contracts';
import { useApiClient } from '@/lib/api/query';
import { isTaxonomyType, type TaxonomyType } from './taxonomy-logic';

export const TAXONOMY_KEY = ['admin.taxonomy_snapshot'] as const;
/** At most this many pages of 500 per type (SEC-ADM-7 paging); more is shown as a warning. */
export const MAX_TYPE_PAGES = 10;
export const PAGE_LIMIT = 500;

export interface TypeNodes {
  items: StaffTaxonomyNode[];
  capped: boolean;
}

export function useTypeNodes(type: TaxonomyType | null) {
  const api = useApiClient();
  return useQuery<TypeNodes>({
    queryKey: [...TAXONOMY_KEY, 'all', type],
    enabled: !!type,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const items: StaffTaxonomyNode[] = [];
      let cursor: string | undefined;
      let capped = false;
      for (let page = 0; page < MAX_TYPE_PAGES; page++) {
        const res = await api.api('admin.taxonomy_snapshot', {
          query: { type: type!, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
          signal,
        });
        items.push(...res.items);
        cursor = res.next_cursor ?? undefined;
        if (!cursor) break;
        if (page === MAX_TYPE_PAGES - 1) capped = true;
      }
      return { items, capped };
    },
  });
}

export type TaxonomySection = 'catalog' | 'terms';
export type TaxonomyView = 'tree' | 'list' | 'missing';
export type NodeTab = 'details' | 'synonyms' | 'mappings' | 'merge';

export interface TaxonomyParams {
  section: TaxonomySection;
  type: TaxonomyType;
  view: TaxonomyView;
  q: string;
  status: string;
  /** The selected node, or 'new' (with parent) for the create form. */
  node: string | null;
  parent: string | null;
  /** The type of the new child under `parent` (a brand has models and engines). */
  childType: string | null;
  tab: NodeTab;
}

const VIEWS: readonly TaxonomyView[] = ['tree', 'list', 'missing'];
const TABS: readonly NodeTab[] = ['details', 'synonyms', 'mappings', 'merge'];

/** The screen's state in the URL (a link opens the same view; nothing personal in it). */
export function useTaxonomyParams(): [TaxonomyParams, (patch: Partial<TaxonomyParams>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const type = params.get('type');
  const view = params.get('view');
  const tab = params.get('tab');
  const value: TaxonomyParams = {
    section: params.get('section') === 'terms' ? 'terms' : 'catalog',
    type: isTaxonomyType(type) ? type : 'vehicle_brand',
    view: VIEWS.includes(view as TaxonomyView) ? (view as TaxonomyView) : 'tree',
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    node: params.get('node'),
    parent: params.get('parent'),
    childType: params.get('childType'),
    tab: TABS.includes(tab as NodeTab) ? (tab as NodeTab) : 'details',
  };
  const set = useCallback(
    (patch: Partial<TaxonomyParams>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      // Defaults stay out of the URL.
      if (next.get('section') === 'catalog') next.delete('section');
      if (next.get('view') === 'tree') next.delete('view');
      if (next.get('tab') === 'details') next.delete('tab');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return [value, set];
}
