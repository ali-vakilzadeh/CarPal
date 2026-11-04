// Server facet counts of W-SRCH-01 (P14.T2, DI-42; Docs/40 §14.1 SearchFacets, contract 1.1.0). search.run and
// search.refine with facets: true return, from the same retrieval as the results, the number of results per filter
// option (with every other current filter applied) and, for each active filter, the number of results without it.
// The filter panel shows these counts ("12", "12+" when retrieval was capped; options the response leaves out show no
// number), the results header shows result_count, and the filters-too-narrow hint names the active filter with the
// largest count_without first. Service systems and part categories are not facets (backend DI-74). Pure.
import type { FacetKey, SearchFacets, SearchFilters } from '@carpal/api-contracts';
import { activeFilters, type FilterKey } from './filters';

/** The panel filters that are server facets (distance is not; FilterKey names equal FacetKey names). */
const FACET_KEYS = new Set<FilterKey>([
  'min_rating',
  'verified_only',
  'open_now',
  'available_within_days',
  'service_modes',
  'price_tiers',
  'warranty_offered',
  'ev_capable',
  'fleet_friendly',
  'stock_available',
  'part_conditions',
  'delivery_options',
] satisfies (FilterKey & FacetKey)[]);

export interface OptionCount {
  count: number;
  /** Retrieval reached its limit: the count is a lower bound ("12+"). */
  capped: boolean;
}

/** Fewer results than this and an active filter that would add some → the hint is shown above the list. */
export const FEW_RESULTS = 3;

/** Does a facet value name this option? Booleans are 'true', ratings compare as numbers ('4' = '4.0'). */
function sameOption(key: FilterKey, facetValue: string, option: unknown): boolean {
  if (option === true) return facetValue === 'true';
  if (key === 'min_rating' || key === 'available_within_days') return Number(facetValue) === Number(option);
  return facetValue === option;
}

/** The server count of one filter option, or null when the response has none (no facets, or the option left out). */
export function facetCount(facets: SearchFacets | null | undefined, key: FilterKey, option: unknown = true): OptionCount | null {
  if (!facets || !FACET_KEYS.has(key)) return null;
  const facet = facets.facets.find((x) => x.key === key);
  const hit = facet?.counts.find((c) => sameOption(key, c.value, option));
  return hit ? { count: hit.count, capped: facets.capped } : null;
}

/** The results of the current filters: result_count from the facets, else null (the loaded count is shown). */
export function resultTotal(facets: SearchFacets | null | undefined): OptionCount | null {
  return facets ? { count: facets.result_count, capped: facets.capped } : null;
}

export interface WideningFilter {
  key: FilterKey;
  /** Results without this filter (server count), or null when the server gives none (e.g. distance). */
  without: OptionCount | null;
}

/**
 * The active filters a user can remove, ordered for the filters-too-narrow hint: those with a server count_without,
 * largest first, then the others in panel order. `skip` leaves out filters offered another way (distance).
 */
export function wideningFilters(
  filters: SearchFilters,
  facets: SearchFacets | null | undefined,
  skip: readonly FilterKey[] = [],
): WideningFilter[] {
  const active = activeFilters(filters).filter((k) => !skip.includes(k));
  const without = new Map((facets?.without_filter ?? []).map((w) => [w.key as string, w.count_without]));
  const capped = facets?.capped ?? false;
  const counted = active
    .filter((k) => without.has(k))
    .map((key) => ({ key, without: { count: without.get(key)!, capped } }))
    .sort((a, b) => b.without.count - a.without.count);
  const rest = active.filter((k) => !without.has(k)).map((key) => ({ key, without: null }));
  return [...counted, ...rest];
}

/** The filter to name in the "few results" hint: the one whose removal adds the most results, if it adds any. */
export function narrowingFilter(filters: SearchFilters, facets: SearchFacets | null | undefined): WideningFilter | null {
  if (!facets || facets.result_count >= FEW_RESULTS) return null;
  const top = wideningFilters(filters, facets)[0];
  return top?.without && top.without.count > facets.result_count ? top : null;
}
