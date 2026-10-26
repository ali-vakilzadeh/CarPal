// Search requests (P6.T1/T2, Docs/40 §14.1-14.2, GD-14): what a search is made of and how it travels.
//   - The page URL is /<locale>/search/<session_id>?<enumerated filters>: the mode, the sort, filter switches and
//     taxonomy/vehicle ids only. Never the query text, coordinates or a map area (TR-7): those stay in the search
//     session and, for re-running it, in this tab's sessionStorage (storage.ts).
//   - Guests never send vehicle_id or user_position (401, BA-16): their car goes as brand/model/series filters and
//     their location is a chosen city or a map area.
//   - Changes the session can take (chips, filters, location, vehicle filter, sort) go through search.refine; a new
//     mode, text or vehicle runs search.run again. A session that can no longer be read re-runs the stored request
//     (DI-17, GD-09 amendment 4).
// Pure functions.
import type {
  EntryPoint,
  IntentChip,
  InterpretedIntent,
  LocationInput,
  PartCondition,
  PriceTier,
  SearchFilters,
  SearchMode,
  SearchRequest,
} from '@carpal/api-contracts';

/** Mode tabs: Showcases is hidden until a showcase search exists (DI-19); Q&A only with qna.enabled. */
export const MODE_TABS = ['all', 'providers', 'parts', 'vendors', 'qna'] as const satisfies readonly SearchMode[];
export type ModeTab = (typeof MODE_TABS)[number];
export const SORTS = ['best_match', 'distance', 'rating'] as const;
export type Sort = (typeof SORTS)[number];

export const PAGE_SIZE = 20;
export const DISTANCES_KM = [5, 10, 25, 50, 100] as const;
export const DEFAULT_DISTANCE_KM = 50; // backend default radius (OQ-14 proposal)
export const RATINGS = ['3.0', '3.5', '4.0', '4.5'] as const;
export const AVAILABILITY_DAYS = [0, 7] as const; // today, this week
export const PRICE_TIERS = ['budget', 'mid_range', 'premium'] as const satisfies readonly PriceTier[];
export const PART_CONDITIONS = ['new', 'used', 'refurbished', 'remanufactured'] as const satisfies readonly PartCondition[];
export const DELIVERY = ['pickup', 'local_delivery'] as const;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CITY = /^[a-z0-9_-]{1,60}$/;
const MAX_IDS = 10;

/** Everything about a search that may appear in the page URL. */
export interface UrlState {
  mode: ModeTab;
  sort: Sort;
  filters: SearchFilters;
  /** false = "For my car" off: all nearby results for the chosen car (vf=0). */
  vehicleFilter: boolean;
  /** A chosen pilot city (region city_key); absent for "near me" and map areas. */
  city: string | null;
}

export const EMPTY_URL_STATE: UrlState = { mode: 'all', sort: 'best_match', filters: {}, vehicleFilter: true, city: null };

const one = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
const many = <T extends string>(v: string | null, allowed: readonly T[]): T[] | undefined => {
  const list = [...new Set((v ?? '').split(',').filter((x): x is T => (allowed as readonly string[]).includes(x)))];
  return list.length ? list : undefined;
};
const ids = (v: string | null): string[] | undefined => {
  const list = [...new Set((v ?? '').split(',').filter((x) => ID.test(x)))].slice(0, MAX_IDS);
  return list.length ? list.map((x) => x.toLowerCase()) : undefined;
};
const id = (v: string | null): string | undefined => (v && ID.test(v) ? v.toLowerCase() : undefined);
const flag = (v: string | null) => (v === '1' ? true : undefined);
const int = (v: string | null, min: number, max: number) => {
  const n = v !== null && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

/** Reads the enumerated search state of a page URL; anything unknown or malformed is dropped. */
export function parseUrlState(q: URLSearchParams, cities: readonly string[] = []): UrlState {
  const f: SearchFilters = {
    distance_km: int(q.get('km'), 1, 200),
    min_rating: one(q.get('rating'), RATINGS),
    verified_only: flag(q.get('verified')),
    open_now: flag(q.get('open')),
    available_within_days: int(q.get('avail'), 0, 30),
    price_tiers: many(q.get('price'), PRICE_TIERS),
    service_modes: q.get('mobile') === '1' ? ['mobile'] : undefined,
    warranty_offered: flag(q.get('warranty')),
    ev_capable: flag(q.get('ev')),
    fleet_friendly: flag(q.get('fleet')),
    stock_available: flag(q.get('stock')),
    part_conditions: many(q.get('cond'), PART_CONDITIONS),
    delivery_options: many(q.get('delivery'), DELIVERY),
    service_system_node_ids: ids(q.get('sys')),
    part_category_node_ids: ids(q.get('cat')),
    brand_node_id: id(q.get('brand')),
    model_node_id: id(q.get('model')),
    series_node_id: id(q.get('series')),
    year: int(q.get('year'), 1950, 2100),
  };
  const city = q.get('city');
  return {
    mode: one(q.get('mode'), MODE_TABS) ?? 'all',
    sort: one(q.get('sort'), SORTS) ?? 'best_match',
    filters: compactFilters(f),
    vehicleFilter: q.get('vf') !== '0',
    city: city && CITY.test(city) && (!cities.length || cities.includes(city)) ? city : null,
  };
}

/** Drops undefined, false and empty values, so equal filters compare equal. */
export function compactFilters(f: SearchFilters): SearchFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out as SearchFilters;
}

/** The query string of a state (stable order; defaults left out). */
export function urlStateQuery(s: UrlState): string {
  const f = s.filters;
  const q = new URLSearchParams();
  if (s.mode !== 'all') q.set('mode', s.mode);
  if (s.sort !== 'best_match') q.set('sort', s.sort);
  if (s.city) q.set('city', s.city);
  if (!s.vehicleFilter) q.set('vf', '0');
  const set = (k: string, v: string | number | boolean | readonly string[] | undefined) => {
    if (v === undefined || v === false) return;
    if (Array.isArray(v)) {
      if (v.length) q.set(k, [...v].sort().join(','));
    } else q.set(k, v === true ? '1' : String(v));
  };
  set('km', f.distance_km);
  set('rating', f.min_rating);
  set('verified', f.verified_only);
  set('open', f.open_now);
  set('avail', f.available_within_days);
  set('price', f.price_tiers);
  set('mobile', f.service_modes?.includes('mobile'));
  set('warranty', f.warranty_offered);
  set('ev', f.ev_capable);
  set('fleet', f.fleet_friendly);
  set('stock', f.stock_available);
  set('cond', f.part_conditions);
  set('delivery', f.delivery_options);
  set('sys', f.service_system_node_ids);
  set('cat', f.part_category_node_ids);
  set('brand', f.brand_node_id);
  set('model', f.model_node_id);
  set('series', f.series_node_id);
  set('year', f.year);
  const s2 = q.toString();
  return s2 ? `?${s2}` : '';
}

export const searchPath = (locale: string, sessionId: string, s: UrlState) =>
  `/${locale}/search/${encodeURIComponent(sessionId)}${urlStateQuery(s)}`;

/** The parts of a search that never go into a URL (kept per session in sessionStorage). */
export interface SearchContext {
  text: string;
  /** user_position or map_center are only ever here; a chosen city is mirrored in the URL. */
  location: LocationInput;
  /** A signed-in user's vehicle (the active car); null for none / guests. */
  vehicleId: string | null;
  intentOverride?: InterpretedIntent;
  entry: EntryPoint;
}

/** The request for search.run from the context and the URL state. Guests: no vehicle_id, no user_position. */
export function buildRequest(ctx: SearchContext, s: UrlState, o: { signedIn: boolean; fallbackCity: string }): SearchRequest {
  let location: LocationInput = ctx.location;
  if (s.city) location = { mode: 'chosen_city', city_key: s.city };
  if (location.mode === 'user_position' && !o.signedIn) location = { mode: 'chosen_city', city_key: o.fallbackCity };
  const text = ctx.text.trim().slice(0, 500);
  const vehicleId = o.signedIn ? ctx.vehicleId : null;
  const filters = compactFilters(s.filters);
  const req: SearchRequest = {
    search_mode: s.mode,
    entry_point: ctx.entry,
    location,
    sort: s.sort,
    limit: PAGE_SIZE,
    ...(text ? { query_text: text } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(vehicleId ? { vehicle_id: vehicleId } : {}),
    // A guest's brand filter is the vehicle context too (backend: vehicle = vehicle_id ?? the brand filters).
    ...(vehicleId || filters.brand_node_id ? { vehicle_filter_applied: s.vehicleFilter } : {}),
    ...(ctx.intentOverride ? { intent_override: ctx.intentOverride } : {}),
  };
  return req;
}

export type Change = { kind: 'refine'; body: RefineBody } | { kind: 'run' };
export type RefineBody = {
  intent_override?: InterpretedIntent;
  filters?: SearchFilters;
  location?: LocationInput;
  vehicle_filter_applied?: boolean;
  sort?: Sort;
};

/** How to get from one request to the next: search.refine when only refinable fields changed, else search.run. */
export function changeOf(prev: SearchRequest, next: SearchRequest): Change {
  if (
    prev.search_mode !== next.search_mode ||
    (prev.query_text ?? '') !== (next.query_text ?? '') ||
    (prev.vehicle_id ?? null) !== (next.vehicle_id ?? null) ||
    prev.entry_point !== next.entry_point
  )
    return { kind: 'run' };
  const body: RefineBody = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(prev.intent_override, next.intent_override) && next.intent_override) body.intent_override = next.intent_override;
  else if (!same(prev.intent_override, next.intent_override)) return { kind: 'run' };
  // search.refine replaces the filters as a whole; {} clears them.
  if (!same(compactFilters(prev.filters ?? {}), compactFilters(next.filters ?? {}))) body.filters = next.filters ?? {};
  if (!same(prev.location, next.location)) body.location = next.location;
  if ((prev.vehicle_filter_applied ?? true) !== (next.vehicle_filter_applied ?? true))
    body.vehicle_filter_applied = next.vehicle_filter_applied;
  if ((prev.sort ?? 'best_match') !== (next.sort ?? 'best_match')) body.sort = next.sort;
  return { kind: 'refine', body };
}

/** The request a refine leads to (mirrors the backend's search.refine merge). */
export function refined(prev: SearchRequest, body: RefineBody): SearchRequest {
  return {
    ...prev,
    ...(body.intent_override ? { intent_override: body.intent_override } : {}),
    ...(body.filters ? { filters: body.filters } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.vehicle_filter_applied !== undefined ? { vehicle_filter_applied: body.vehicle_filter_applied } : {}),
    ...(body.sort ? { sort: body.sort } : {}),
  };
}

// ---------------------------------------------------------------- chips

/** The intent without one chip ("removing a chip re-runs the search", Docs/21 C-SEARCH-01). */
export function withoutChip(intent: InterpretedIntent, index: number): InterpretedIntent {
  return { target_type: intent.target_type, chips: intent.chips.filter((c, i) => i !== index || !c.removable) };
}

/** The intent with one more chip from a taxonomy suggestion (at most 12 chips; the same node only once). */
export function withChip(intent: InterpretedIntent, chip: IntentChip): InterpretedIntent {
  if (chip.node_id && intent.chips.some((c) => c.node_id === chip.node_id)) return intent;
  return { target_type: intent.target_type, chips: [...intent.chips, chip].slice(0, 12) };
}

/** The chip kind of a taxonomy node type (null when the type cannot be a chip). */
export function chipKind(type: string): IntentChip['kind'] | null {
  if (type.startsWith('vehicle_')) return 'vehicle';
  if (type === 'service_system' || type === 'service_task' || type === 'symptom' || type === 'part_category') return type;
  return null;
}

/** True when the search looks for parts or sellers though the mode is All ("Switched to Parts …"). */
export function switchedToParts(mode: SearchMode, intent: InterpretedIntent): boolean {
  return mode === 'all' && (intent.target_type === 'inventory_item' || intent.target_type === 'vendor');
}

/** True for symptom-style text: Help Me is offered as a quiet line under the results (Docs/21 S-SHARED-01). */
export function looksLikeSymptom(intent: InterpretedIntent): boolean {
  return intent.chips.some((c) => c.kind === 'symptom');
}

/** The number of filters set (the Filters button badge). */
export function activeFilterCount(f: SearchFilters, ignore: readonly (keyof SearchFilters)[] = []): number {
  return Object.keys(compactFilters(f)).filter((k) => !ignore.includes(k as keyof SearchFilters)).length;
}

/** Filters without one key (the "Remove filter: …" widening actions and chips). */
export function withoutFilter(f: SearchFilters, key: keyof SearchFilters): SearchFilters {
  const next = { ...f };
  delete next[key];
  return compactFilters(next);
}

/** The next wider distance for "Widen to 25 km" (null when already at the widest). */
export function widerDistance(current: number | undefined): number | null {
  const now = current ?? DEFAULT_DISTANCE_KM;
  return DISTANCES_KM.find((d) => d > now) ?? (now < 200 ? 200 : null);
}
