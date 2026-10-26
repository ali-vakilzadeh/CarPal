// The filter panel's model (Docs/90 S-SHARED-03, Docs/21 S-SHARED-03): which filters a mode offers, their names for
// "Remove filter: …", and option counts. SearchResponse carries no facet counts (DI-42), so a count is shown only when
// the whole result list is loaded (no next page) and the card has the field: open now, verified, rating, price
// indicator, availability, stock and condition — the number of these results that also match the option. Pure.
import type { ResultCard, SearchFilters } from '@carpal/api-contracts';
import type { ModeTab } from './request';

export type FilterKey = Exclude<
  keyof SearchFilters,
  | 'brand_node_id'
  | 'model_node_id'
  | 'series_node_id'
  | 'year'
  | 'service_system_node_ids'
  | 'service_task_node_ids'
  | 'part_category_node_ids'
  | 'languages'
  | 'provider_types'
  | 'vendor_types'
  | 'badges'
  | 'trade_pricing'
  | 'min_fitment_confidence'
  | 'preferred_partners_only'
  | 'max_response_time'
>;

const PROVIDER_FILTERS: FilterKey[] = [
  'open_now',
  'verified_only',
  'min_rating',
  'distance_km',
  'available_within_days',
  'price_tiers',
  'service_modes',
  'warranty_offered',
  'ev_capable',
  'fleet_friendly',
];
const PARTS_FILTERS: FilterKey[] = [
  'open_now',
  'verified_only',
  'min_rating',
  'distance_km',
  'stock_available',
  'part_conditions',
  'delivery_options',
];

export function filtersFor(mode: ModeTab): FilterKey[] {
  if (mode === 'parts' || mode === 'vendors') return PARTS_FILTERS;
  if (mode === 'providers') return PROVIDER_FILTERS;
  return [...new Set([...PROVIDER_FILTERS, ...PARTS_FILTERS])];
}

const DAY_MS = 86_400_000;

/** Does a result match one filter option (null = the card cannot tell)? */
export function matchesOption(r: ResultCard, key: FilterKey, value: unknown, now = Date.now()): boolean | null {
  const o = r.organization;
  switch (key) {
    case 'open_now':
      return r.open_now === true;
    case 'verified_only':
      return o.verified;
    case 'min_rating':
      return o.overall_rating !== null && Number(o.overall_rating) >= Number(value);
    case 'price_tiers':
      return o.price_tier === value;
    case 'available_within_days': {
      if (!r.next_available_slot) return false;
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return Date.parse(r.next_available_slot) <= end.getTime() + Number(value) * DAY_MS;
    }
    case 'stock_available':
      return r.item ? r.item.stock_status === 'in_stock' || r.item.stock_status === 'low_stock' : null;
    case 'part_conditions':
      return r.item ? r.item.condition === value : null;
    default:
      return null;
  }
}

/** How many of the loaded results match the option; null when the list is incomplete or the card cannot tell. */
export function optionCount(
  results: readonly ResultCard[],
  complete: boolean,
  key: FilterKey,
  value: unknown = true,
  now = Date.now(),
): number | null {
  if (!complete) return null;
  let n = 0;
  for (const r of results) {
    const m = matchesOption(r, key, value, now);
    if (m === null) return null;
    if (m) n++;
  }
  return n;
}

/** The active filters with their translation keys (for "Remove filter: …"). */
export function activeFilters(f: SearchFilters): FilterKey[] {
  const keys: FilterKey[] = [];
  for (const k of [...PROVIDER_FILTERS, ...PARTS_FILTERS])
    if (!keys.includes(k)) {
      const v = f[k];
      if (v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0)) keys.push(k);
    }
  return keys;
}

/** Reset (Docs/21 S-SHARED-03): clears to defaults; the vehicle and the category stay. */
export function resetFilters(f: SearchFilters): SearchFilters {
  const keep: (keyof SearchFilters)[] = [
    'brand_node_id',
    'model_node_id',
    'series_node_id',
    'year',
    'service_system_node_ids',
    'service_task_node_ids',
    'part_category_node_ids',
  ];
  const out: SearchFilters = {};
  for (const k of keep) if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}
