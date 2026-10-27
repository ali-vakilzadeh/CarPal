// Search facets (40 §14.1 SearchFacets, contract 1.1.0): result counts per
// filter option and per removed filter. Pure: the caller hands in a counter
// that answers "how many results would this filter set give" from one
// retrieval without the facetable filters (search-service #select), so a
// count always means the same as a run with that option. The filters that
// narrow the index are built here once and used by retrieval too, so the
// search and its counts cannot drift apart.
import { ENUMS } from '#libs/contract/index.js';
import { addDays, localParts, zonedToUtc } from '#libs/geo/index.js';
import type { SearchFilter } from '#libs/infra/index.js';

/** The facetable members of SearchFilters (40 FacetKey). */
export type FacetKey =
  | 'min_rating'
  | 'verified_only'
  | 'open_now'
  | 'available_within_days'
  | 'service_modes'
  | 'price_tiers'
  | 'provider_types'
  | 'vendor_types'
  | 'badges'
  | 'languages'
  | 'warranty_offered'
  | 'ev_capable'
  | 'fleet_friendly'
  | 'stock_available'
  | 'part_conditions'
  | 'delivery_options'
  | 'trade_pricing';

/** The SearchFilters members the facets read and write (structurally the search request's filters). */
export interface FacetFilters {
  min_rating?: string;
  verified_only?: boolean;
  open_now?: boolean;
  available_within_days?: number;
  service_modes?: string[];
  price_tiers?: string[];
  provider_types?: string[];
  vendor_types?: string[];
  badges?: string[];
  languages?: string[];
  warranty_offered?: boolean;
  ev_capable?: boolean;
  fleet_friendly?: boolean;
  stock_available?: boolean;
  part_conditions?: string[];
  delivery_options?: string[];
  trade_pricing?: boolean;
}

export type FacetTarget = 'provider' | 'vendor' | 'inventory_item' | 'place';

export interface FacetCount {
  value: string;
  count: number;
  selected: boolean;
}
export interface SearchFacet {
  key: FacetKey;
  counts: FacetCount[];
}
export interface SearchFacets {
  result_count: number;
  capped: boolean;
  facets: SearchFacet[];
  without_filter: { key: FacetKey; count_without: number }[];
}

// ------------------------------------------------------------ index filters

type Build = (f: FacetFilters) => SearchFilter | null;
const eqTrue = (field: string, on: boolean | undefined): SearchFilter | null => (on ? { field, eq: true } : null);
const inSet = (field: string, v: readonly string[] | undefined): SearchFilter | null => (v?.length ? { field, in: v } : null);
const rating: Build = (f) => (f.min_rating ? { field: 'overall_rating', gte: Number(f.min_rating) } : null);

/** Provider-document filters of the facetable keys (the index narrows retrieval with them). */
export const PROVIDER_FILTERS: Partial<Record<FacetKey, Build>> = {
  min_rating: rating,
  verified_only: (f) => eqTrue('verified', f.verified_only),
  service_modes: (f) => inSet('service_modes', f.service_modes),
  price_tiers: (f) => inSet('price_tier', f.price_tiers),
  fleet_friendly: (f) => eqTrue('fleet_friendly', f.fleet_friendly),
  ev_capable: (f) => eqTrue('ev_ready', f.ev_capable),
  warranty_offered: (f) => eqTrue('warranty_offered', f.warranty_offered),
  languages: (f) => inSet('languages', f.languages),
  provider_types: (f) => inSet('provider_type', f.provider_types),
  badges: (f) => inSet('badges', f.badges),
};

/** Vendor-document filters of the facetable keys. */
export const VENDOR_FILTERS: Partial<Record<FacetKey, Build>> = {
  min_rating: rating,
  verified_only: (f) => eqTrue('verified', f.verified_only),
  vendor_types: (f) => inSet('vendor_type', f.vendor_types),
  delivery_options: (f) => inSet('delivery_options', f.delivery_options),
  trade_pricing: (f) => eqTrue('trade_customers_supported', f.trade_pricing),
};

/** Inventory-document filters of the facetable keys. */
export const ITEM_FILTERS: Partial<Record<FacetKey, Build>> = {
  part_conditions: (f) => inSet('condition', f.part_conditions),
  stock_available: (f) => (f.stock_available ? { field: 'stock_status', in: ['in_stock', 'low_stock'] } : null),
};

/** The index filters of one table for a filter set. */
export function indexFilters(table: Partial<Record<FacetKey, Build>>, f: FacetFilters | undefined): SearchFilter[] {
  if (!f) return [];
  return Object.values(table)
    .map((b) => b!(f))
    .filter((x): x is SearchFilter => x !== null);
}

// ------------------------------------------------------------ availability

/**
 * SearchFilters.available_within_days: an open slot that starts before the end
 * of the N-th day after today in the location's time zone (0 = today).
 */
export function slotWithinDays(nextIso: string | null | undefined, days: number, timezone: string, now: Date): boolean {
  if (!nextIso) return false;
  const end = zonedToUtc(addDays(localParts(now, timezone).date, days + 1), '00:00', timezone);
  return Date.parse(nextIso) < end.getTime();
}

// ------------------------------------------------------------ facets

/** Facets that change the results of each target type (40 SearchFacets: "facets that apply to the session's target type"). */
const PROVIDER_KEYS: FacetKey[] = [
  'min_rating',
  'verified_only',
  'open_now',
  'available_within_days',
  'service_modes',
  'price_tiers',
  'provider_types',
  'badges',
  'languages',
  'warranty_offered',
  'ev_capable',
  'fleet_friendly',
];
const VENDOR_KEYS: FacetKey[] = ['min_rating', 'verified_only', 'open_now', 'vendor_types', 'delivery_options', 'trade_pricing'];
const ITEM_KEYS: FacetKey[] = ['open_now', 'part_conditions', 'stock_available'];

export function facetKeys(target: FacetTarget): FacetKey[] {
  if (target === 'provider') return PROVIDER_KEYS;
  if (target === 'vendor') return VENDOR_KEYS;
  if (target === 'inventory_item') return ITEM_KEYS;
  return [...PROVIDER_KEYS, ...VENDOR_KEYS.filter((k) => !PROVIDER_KEYS.includes(k))];
}

const BOOLEAN_KEYS = new Set<FacetKey>([
  'verified_only',
  'open_now',
  'warranty_offered',
  'ev_capable',
  'fleet_friendly',
  'stock_available',
  'trade_pricing',
]);
export const RATING_OPTIONS = ['3', '3.5', '4', '4.5'] as const;
export const AVAILABILITY_OPTIONS = ['0', '7'] as const;
const ENUM_OPTIONS: Partial<Record<FacetKey, readonly string[]>> = {
  service_modes: ENUMS.ServiceMode,
  price_tiers: ENUMS.PriceTier,
  provider_types: ENUMS.ProviderType,
  vendor_types: ENUMS.VendorType,
  badges: ENUMS.BadgeType,
  part_conditions: ENUMS.PartCondition,
  delivery_options: ['pickup', 'local_delivery'],
};
/** Languages are open ISO codes: the selected ones and the 20 spoken by the most results. */
const LANGUAGE_LIMIT = 20;

export function isActive(f: FacetFilters, key: FacetKey): boolean {
  const v = f[key];
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'boolean') return v;
  return v !== undefined && v !== null;
}

function withOption(f: FacetFilters, key: FacetKey, value: string): FacetFilters {
  if (BOOLEAN_KEYS.has(key)) return { ...f, [key]: true };
  if (key === 'min_rating') return { ...f, min_rating: value };
  if (key === 'available_within_days') return { ...f, available_within_days: Number(value) };
  return { ...f, [key]: [value] };
}

function selected(f: FacetFilters, key: FacetKey, value: string): boolean {
  if (BOOLEAN_KEYS.has(key)) return f[key] === true;
  if (key === 'min_rating') return f.min_rating !== undefined && Number(f.min_rating) === Number(value);
  if (key === 'available_within_days') return f.available_within_days === Number(value);
  return ((f[key] as string[] | undefined) ?? []).includes(value);
}

function without<T extends FacetFilters>(f: T, key: FacetKey): T {
  const out = { ...f };
  delete out[key];
  return out;
}

/**
 * The facets of a filter set: for each option, the results with every current
 * filter except the facet's own selection plus this option (options of one Set
 * facet combine with OR, as the filters do); for each active filter, the
 * results without it. `count` runs the same selection as the search.
 */
export function computeFacets<T extends FacetFilters>(o: {
  target: FacetTarget;
  filters: T;
  count: (f: T) => number;
  resultCount: number;
  capped: boolean;
  /** Languages spoken by the retrieved providers (the language options). */
  languages: Iterable<string>;
}): SearchFacets {
  const f = o.filters;
  const facets: SearchFacet[] = [];
  const keys = facetKeys(o.target);
  for (const key of keys) {
    const base = without(f, key);
    const options =
      key === 'min_rating'
        ? RATING_OPTIONS
        : key === 'available_within_days'
          ? AVAILABILITY_OPTIONS
          : BOOLEAN_KEYS.has(key)
            ? ['true']
            : key === 'languages'
              ? [...new Set([...(f.languages ?? []), ...o.languages])].sort()
              : (ENUM_OPTIONS[key] ?? []);
    let counts = options.map((value) => ({
      value,
      count: o.count(withOption(base, key, value) as T),
      selected: selected(f, key, value),
    }));
    if (key === 'languages')
      counts = [
        ...counts.filter((c) => c.selected),
        ...counts
          .filter((c) => !c.selected && c.count > 0)
          .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
          .slice(0, LANGUAGE_LIMIT),
      ];
    facets.push({ key, counts: counts.slice(0, 50) });
  }
  const withoutFilter = keys.filter((k) => isActive(f, k)).map((key) => ({ key, count_without: o.count(without(f, key)) }));
  return { result_count: o.resultCount, capped: o.capped, facets, without_filter: withoutFilter };
}
