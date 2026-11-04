// The filter panel's model (Docs/90 S-SHARED-03, Docs/21 S-SHARED-03): which filters a mode offers, which are active
// (for "Remove filter: …") and Reset. Option counts come from the server facets (facets.ts, P14.T2). Pure.
import type { SearchFilters } from '@carpal/api-contracts';
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
