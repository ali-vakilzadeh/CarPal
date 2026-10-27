// Search sessions (40 §14.2 search.run / search.page / search.refine; 52
// MatchSession, MatchResult; 54 §5). One run: caller checks (sign-in for a
// vehicle or a device position, location_usage consent, as_organization_id
// membership), rule-based interpretation into chips, the server-side safety
// check, retrieval from the search projections, ranking with structured
// reasons, the vehicle filter with its fallback, and the session with its
// ranked results stored in one transaction (search.started /
// search.zero_result analytics events in the outbox). Plan, payment or
// sponsorship never enter the ranking; no result is sponsored. Contract 1.1.0
// (S10): facet counts from a second retrieval without the facetable filters,
// the soonest sort, next_available_slot on cards and search.session_get,
// which answers the stored first page again.
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { ApiError } from '#libs/contract/index.js';
import { openNow, validateBBox, type BBox, type GeoPoint, type HoursSpec } from '#libs/geo/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import { searchTokens, type L10n, type Locale } from '#libs/i18n/index.js';
import { matchesFilter, type Infra, type SearchDocument, type SearchFilter, type SearchHit } from '#libs/infra/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { SafetyCheck, type Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { CommunityRead } from '#modules/community/interface/community.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { PublicOrgCards, type PublicOrgCard } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { FleetPartners } from '#modules/fleet/interface/fleet.js';
import {
  computeFacets,
  indexFilters,
  ITEM_FILTERS,
  PROVIDER_FILTERS,
  slotWithinDays,
  VENDOR_FILTERS,
  type SearchFacets,
} from '../domain/facets.js';
import { interpret, ngrams, type TermNode } from '../domain/intent.js';
import {
  FITMENT_WEIGHT,
  fitmentMatches,
  scoreItem,
  scoreProvider,
  scoreVendor,
  type ItemMatch,
  type MatchContext,
  type Reason,
  type Scored,
  type VehicleContext,
} from '../domain/ranking.js';
import { reasonNodeIds, reasonSummary, targetLabel, templateExplanation } from '../domain/reasons.js';
import {
  INDEX,
  NEXT_SLOT_DAYS,
  SearchProjections,
  type InventoryDoc,
  type LocationDoc,
  type ProviderDoc,
  type VendorDoc,
} from '../infrastructure/projections.js';

export type LocationInput =
  | { mode: 'user_position'; point: GeoPoint; accuracy_m?: number }
  | { mode: 'chosen_city'; city_key: string }
  | { mode: 'map_center'; viewport: { center: GeoPoint; zoom: number; bbox: BBox } };

export interface SearchFilters {
  distance_km?: number;
  min_rating?: string;
  verified_only?: boolean;
  service_system_node_ids?: string[];
  service_task_node_ids?: string[];
  part_category_node_ids?: string[];
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  year?: number;
  available_within_days?: number;
  service_modes?: string[];
  price_tiers?: string[];
  fleet_friendly?: boolean;
  ev_capable?: boolean;
  warranty_offered?: boolean;
  max_response_time?: string;
  languages?: string[];
  provider_types?: string[];
  vendor_types?: string[];
  badges?: string[];
  part_conditions?: string[];
  stock_available?: boolean;
  delivery_options?: string[];
  trade_pricing?: boolean;
  min_fitment_confidence?: 'confirmed' | 'likely' | 'uncertain';
  open_now?: boolean;
  preferred_partners_only?: boolean;
}

export interface IntentChip {
  kind: 'target_type' | 'vehicle' | 'service_system' | 'service_task' | 'symptom' | 'part_category' | 'shop_name' | 'location';
  node_id?: string;
  text?: string;
  label: L10n;
  removable: boolean;
}
export type TargetType = 'provider' | 'vendor' | 'inventory_item' | 'place';
export interface InterpretedIntent {
  target_type: TargetType;
  chips: IntentChip[];
}

export interface SearchRequest {
  query_text?: string;
  search_mode: 'all' | 'providers' | 'vendors' | 'parts' | 'showcases' | 'qna';
  entry_point: string;
  vehicle_id?: string;
  vehicle_filter_applied?: boolean;
  as_organization_id?: string;
  issue_id?: string;
  location: LocationInput;
  urgency_level?: Urgency;
  filters?: SearchFilters;
  intent_override?: InterpretedIntent;
  sort?: SearchSort;
  limit?: number;
  /** Contract 1.1.0: SearchResponse.facets. */
  facets?: boolean;
}
export type SearchSort = 'best_match' | 'distance' | 'rating' | 'soonest';
export type SafetyBlock = ReturnType<typeof safetyBlock>;

export interface RunOptions {
  previousChips?: IntentChip[];
  /** 52 MatchSession.source: search, or ai_triage for a Help Me match. */
  source?: 'search' | 'ai_triage';
  triageSessionId?: string;
  /** The issue the triage created (already authorized by the caller). */
  issueId?: string | null;
}

/**
 * What a session keeps beyond its columns (in interpreted_intent, never
 * returned as such): the request parts search.refine re-runs, and the
 * response parts search.session_get answers again (S10; sessions stored
 * before S10 have none of the last four).
 */
interface StoredIntent extends InterpretedIntent {
  location: LocationInput;
  sort: SearchSort;
  residual: string;
  facetsRequested?: boolean;
  safety?: SafetyBlock;
  fallback?: boolean;
  facets?: SearchFacets | null;
}

const DEFAULT_RADIUS_KM = 50;
const STORED_RESULTS = 100;
/** search.session_get reads a session for 24 hours (40 contract 1.1.0). */
export const SESSION_READ_MS = 24 * 3_600_000;
/** Time zone of a provider without locations in its document (pilot region). */
const DEFAULT_TZ = 'Asia/Tehran';
const SAFETY_LEVEL = (u: Urgency | null): 'none' | 'warning' | 'urgent' => (u === 'safety_critical' ? 'urgent' : u ? 'warning' : 'none');

export function safetyBlock(r: { safety_flag: boolean; urgency: Urgency | null }) {
  const level = r.safety_flag ? SAFETY_LEVEL(r.urgency ?? 'medium') : 'none';
  return {
    flag: r.safety_flag,
    level,
    message_i18n_key: level === 'none' ? null : `safety.banner.${level}`,
    urgent_help_available: level === 'urgent',
  };
}

/** One ranked candidate before storage. */
interface Candidate {
  targetType: 'organization' | 'inventory_item';
  targetId: string;
  orgId: string;
  scored: Scored;
  distanceKm: number | null;
  matchingItems: number | null;
  rating: number | null;
  reviews: number;
  inactive: boolean;
  urgentFit: boolean;
  /** Next open slot (ms) of a provider, null when none or passed (soonest sort). */
  slot: number | null;
  /** Open now at one of its locations (SearchFilters.open_now). */
  open: boolean;
}

/** A retrieved provider with its score (#collect); whether it is a result is decided per filter set (#select). */
interface ProviderEntry {
  doc: ProviderDoc;
  distanceKm: number | null;
  scored: Scored;
  open: boolean;
}
interface VendorEntry {
  doc: VendorDoc;
  distanceKm: number | null;
  scored: Scored;
  items: ItemMatch | undefined;
  open: boolean;
}
interface ItemHit {
  hit: SearchHit;
  doc: InventoryDoc;
  best: string | null;
  weight: number;
  /** SearchFilters.min_fitment_confidence (not facetable). */
  fitOk: boolean;
}
interface ItemEntry extends ItemHit {
  rating: { overall: number | null; count: number } | null;
  scored: Scored | null;
  open: boolean;
}
/** Hits of the first query (a) and of the retry without text (b). */
interface Hits<T> {
  a: T[];
  b: T[] | null;
}
interface Pool {
  providers: Hits<ProviderEntry> | null;
  vendors: VendorEntry[];
  items: Hits<ItemEntry> | null;
  preferred: Set<string>;
  vehicle: VehicleContext | null;
  services: Set<string>;
  parts: Set<string>;
  /** A retrieval reached its size limit. */
  capped: boolean;
  /** preferred_partners_only without partners: no results. */
  none: boolean;
}

/** The hits a filter set keeps: the first query's, or the retry's when the first leaves nothing (as the index queries do). */
function pick<T extends { doc: SearchDocument }>(a: T[], b: T[] | null, filters: SearchFilter[]): T[] {
  const keep = (x: T) => filters.every((g) => matchesFilter(x.doc, g));
  const first = a.filter(keep);
  return first.length || !b ? first : b.filter(keep);
}

export interface Resolved {
  req: SearchRequest;
  origin: GeoPoint | null;
  originMode: LocationInput['mode'];
  bbox: BBox | null;
  vehicle: VehicleContext | null;
  vehicleFromId: boolean;
  orgContext: string | null;
}

const decimal = (x: number, max: number): string => String(Math.min(max, Math.round(x * 10) / 10));

@Injectable()
export class SearchService {
  #cities: Map<string, string> | null = null;

  constructor(
    private readonly projections: SearchProjections,
    private readonly taxonomy: TaxonomyResolver,
    private readonly safety: SafetyCheck,
    private readonly region: RegionConfigService,
    private readonly vehicles: VehicleCards,
    private readonly consents: ConsentChecker,
    private readonly inventory: InventoryRead,
    private readonly cards: PublicOrgCards,
    @InjectInfra() private readonly infra: Infra,
    @Optional() private readonly community?: CommunityRead,
    @Optional() private readonly partners?: FleetPartners,
    @Optional() private readonly appointments?: AppointmentFacts,
  ) {}

  /** City names of the region config in every locale, analyzed → city_key. */
  cities(): Map<string, string> {
    if (this.#cities) return this.#cities;
    const out = new Map<string, string>();
    for (const locale of this.region.locales)
      for (const c of this.region.forLocale(locale).cities) {
        const key = searchTokens(c.label.text).join(' ');
        if (key) out.set(key, c.city_key);
        out.set(searchTokens(c.city_key.replace(/[_-]/g, ' ')).join(' '), c.city_key);
      }
    return (this.#cities = out);
  }

  cityCenter(key: string): GeoPoint | null {
    return this.region.forLocale('en').cities.find((c) => c.city_key === key)?.center ?? null;
  }

  // -------------------------------------------------------------- checks

  /** Caller checks before any work (40 search.run err), in the request's transaction. */
  async resolve(ctx: OperationContext, scope: TxScope, req: SearchRequest): Promise<Resolved> {
    const signedIn = ctx.principal.kind === 'user';
    if ((req.vehicle_id || req.location.mode === 'user_position') && !signedIn)
      throw new ApiError('UNAUTHENTICATED', { detail: 'vehicle_id or user_position without sign-in' });
    let orgContext: string | null = null;
    if (req.as_organization_id) {
      if (!signedIn) throw new ApiError('UNAUTHENTICATED', { detail: 'as_organization_id without sign-in' });
      const org = await ctx.authorizeOrg(req.as_organization_id, ['P*', 'F*']);
      await scope.setOrganization(org.id, org.role);
      orgContext = org.id;
    }
    let origin: GeoPoint | null;
    let bbox: BBox | null = null;
    const loc = req.location;
    if (loc.mode === 'user_position') {
      // SEC-OUT-4 / 52 MatchSession: device coordinates only under an active location_usage consent.
      const granted = await this.consents.isGranted(scope, {
        consentType: 'location_usage',
        subject: { type: 'user', id: (ctx.principal as { userId: string }).userId },
      });
      if (!granted) throw new ApiError('LOCATION_CONSENT_REQUIRED');
      origin = loc.point;
    } else if (loc.mode === 'chosen_city') {
      origin = this.cityCenter(loc.city_key);
      if (!origin) throw ApiError.validation([{ pointer: '/location/city_key', code: 'enum' }]);
    } else {
      const errors = validateBBox(loc.viewport.bbox, this.region.maxBboxDeg, '/location/viewport/bbox');
      if (errors.length) throw ApiError.validation(errors);
      origin = loc.viewport.center;
      bbox = loc.viewport.bbox;
    }
    let vehicle: VehicleContext | null = null;
    if (req.vehicle_id) {
      const v = await this.vehicles.visible(scope, req.vehicle_id);
      if (!v) throw ApiError.validation([{ pointer: '/vehicle_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      vehicle = { brand: v.brandNodeId, model: v.modelNodeId, series: v.seriesNodeId, year: v.year };
    }
    const f = req.filters;
    if (!vehicle && f?.brand_node_id)
      vehicle = { brand: f.brand_node_id, model: f.model_node_id ?? null, series: f.series_node_id ?? null, year: f.year ?? null };
    return { req, origin, originMode: loc.mode, bbox, vehicle, vehicleFromId: !!req.vehicle_id, orgContext };
  }

  // -------------------------------------------------------------- intent

  async #terms(tokens: string[]): Promise<Map<string, TermNode[]>> {
    const grams = ngrams(tokens);
    const out = new Map<string, TermNode[]>();
    if (grams.length === 0) return out;
    await this.projections.ensureTaxonomy();
    const { hits } = await this.infra.search.search(INDEX.taxonomy, {
      filters: [
        { field: 'terms', in: grams },
        { field: 'status', eq: 'active' },
      ],
      size: 500,
    });
    for (const h of hits)
      for (const t of (h.source.terms as string[]) ?? [])
        if (grams.includes(t)) out.set(t, [...(out.get(t) ?? []), { nodeId: h.id, type: String(h.source.type) }]);
    return out;
  }

  /** Chips from the text (or the edited chips), the target type and the free text left over. */
  async intent(r: Resolved, locale: Locale): Promise<{ intent: InterpretedIntent; residual: string; cityKey: string | null }> {
    const req = r.req;
    const fromMode: Record<SearchRequest['search_mode'], TargetType> = {
      all: 'place',
      providers: 'provider',
      vendors: 'vendor',
      parts: 'inventory_item',
      showcases: 'provider',
      qna: 'provider',
    };
    if (req.intent_override) {
      const chips = req.intent_override.chips;
      for (const [i, c] of chips.entries())
        if (c.node_id) {
          const n = await this.taxonomy.get(c.node_id);
          if (!n || n.status !== 'active')
            throw ApiError.validation(
              [{ pointer: `/intent_override/chips/${i}/node_id`, code: 'reference_not_found' }],
              'REFERENCE_NOT_FOUND',
            );
        }
      const shop = chips.find((c) => c.kind === 'shop_name')?.text ?? '';
      const city = chips.find((c) => c.kind === 'location')?.text ?? null;
      return {
        intent: { target_type: req.intent_override.target_type, chips },
        residual: searchTokens(shop).join(' '),
        cityKey: city && this.cityCenter(city) ? city : null,
      };
    }
    const tokens = searchTokens(req.query_text ?? '');
    const interp = interpret(tokens, await this.#terms(tokens), this.cities());
    let target = fromMode[req.search_mode];
    if (req.search_mode === 'all' && interp.targetHint) target = interp.targetHint;
    if (
      req.search_mode === 'all' &&
      !interp.targetHint &&
      interp.nodes.some((n) => n.type === 'part_category') &&
      !interp.nodes.some((n) => n.type.startsWith('service_') || n.type === 'symptom')
    )
      target = 'vendor';
    const labels = await this.taxonomy.labels(
      interp.nodes.map((n) => n.nodeId),
      locale,
    );
    const kindOf = (type: string): IntentChip['kind'] =>
      type.startsWith('vehicle_') ? 'vehicle' : (type as 'service_system' | 'service_task' | 'symptom' | 'part_category');
    const chips: IntentChip[] = [{ kind: 'target_type', text: target, label: targetLabel(target, locale), removable: false }];
    for (const n of interp.nodes) {
      const label = labels.get(n.nodeId);
      if (label) chips.push({ kind: kindOf(n.type), node_id: n.nodeId, label, removable: true });
    }
    if (interp.cityKey) {
      const city = this.region.forLocale(locale).cities.find((c) => c.city_key === interp.cityKey);
      chips.push({ kind: 'location', text: interp.cityKey, label: city?.label ?? { text: interp.cityKey, locale }, removable: true });
    }
    if (interp.residual)
      chips.push({
        kind: 'shop_name',
        text: interp.residual.slice(0, 120),
        label: { text: interp.residual.slice(0, 120), locale },
        removable: true,
      });
    return { intent: { target_type: target, chips: chips.slice(0, 12) }, residual: interp.residual, cityKey: interp.cityKey };
  }

  // -------------------------------------------------------------- retrieval

  #geo(r: Resolved, origin: GeoPoint | null) {
    if (r.bbox) return { field: 'locations.point', ...(origin ? { origin } : {}), bbox: r.bbox };
    if (!origin) return undefined;
    return {
      field: 'locations.point',
      origin,
      radiusKm: r.req.filters?.distance_km ?? DEFAULT_RADIUS_KM,
      pointRadiusField: 'service_radius_km',
    };
  }

  /** Requested services: system and task chips, filters, and the systems and tasks mapped from symptom chips (54 §5.5). */
  async #services(intent: InterpretedIntent, f: SearchFilters | undefined): Promise<Set<string>> {
    const out = new Set<string>([...(f?.service_system_node_ids ?? []), ...(f?.service_task_node_ids ?? [])]);
    for (const c of intent.chips) {
      if (!c.node_id) continue;
      if (c.kind === 'service_system' || c.kind === 'service_task') out.add(c.node_id);
      if (c.kind === 'symptom')
        for (const m of await this.taxonomy.mappingsFrom(c.node_id))
          if (m.mappingType === 'symptom_to_system' || m.mappingType === 'symptom_to_task') out.add(m.targetId);
    }
    return out;
  }

  async #vehicleFromChips(intent: InterpretedIntent): Promise<VehicleContext | null> {
    const ids = intent.chips.filter((c) => c.kind === 'vehicle' && c.node_id).map((c) => c.node_id!);
    if (ids.length === 0) return null;
    const v: { brand?: string; model?: string; series?: string } = {};
    for (const id of ids) {
      const chain = await this.taxonomy.ancestors(id);
      for (const nodeId of chain) {
        const n = await this.taxonomy.get(nodeId);
        if (n?.type === 'vehicle_brand') v.brand ??= nodeId;
        if (n?.type === 'vehicle_model') v.model ??= nodeId;
        if (n?.type === 'vehicle_series') v.series ??= nodeId;
      }
    }
    return v.brand ? { brand: v.brand, model: v.model ?? null, series: v.series ?? null } : null;
  }

  /**
   * Provider filters outside the facets. Service match: the provider offers a
   * requested node or something below it (its service_node_ids hold offered
   * nodes with their ancestors), or offers a node above a requested one (a
   * brake-system shop for a brake-pad task). The facetable filters are
   * facets.ts PROVIDER_FILTERS.
   */
  #providerBase(services: Set<string>, lineage: Set<string>, f: SearchFilters | undefined): SearchFilter[] {
    const out: SearchFilter[] = [];
    if (services.size)
      out.push({
        any: [
          { field: 'service_node_ids', in: [...services] },
          { field: 'offered_node_ids', in: [...lineage] },
        ],
      });
    if (f?.max_response_time) {
      const order = ['within_2h', 'same_day', 'within_24h', 'within_48h'];
      out.push({ field: 'response_time_target', in: order.slice(0, order.indexOf(f.max_response_time) + 1) });
    }
    return out;
  }

  /**
   * Index hits of the part criteria (public items, or trade-only items of
   * vendors with an approved trade account of the context organization) and
   * the hits of the retry without text, which a run uses when the first query
   * finds nothing. `b` is fetched only then, or always for a facet pool.
   */
  async #itemHits(
    r: Resolved,
    vehicle: VehicleContext | null,
    parts: Set<string>,
    residual: string,
    trade: Set<string>,
    origin: GeoPoint | null,
    o: { itemFilters: SearchFilter[]; pool: boolean; onCap: (n: number, size: number) => void },
  ): Promise<{ a: ItemHit[]; b: ItemHit[] | null }> {
    // The vehicle rates fitment here; the "for my car" filter (with its fallback) applies to the ranked results.
    const f = r.req.filters;
    const filters: SearchFilter[] = [
      { any: [{ field: 'visibility', eq: 'public' }, ...(trade.size ? [{ field: 'vendor_organization_id', in: [...trade] }] : [])] },
      ...(parts.size ? [{ field: 'part_category_node_ids', in: [...parts] }] : []),
      ...o.itemFilters,
    ];
    const geo = this.#geo(r, origin);
    const text = residual ? { query: residual, fields: { name: 3, normalized_name: 2, sku: 3, part_numbers: 3, brand: 1 } } : undefined;
    const minRank = f?.min_fitment_confidence ? FITMENT_WEIGHT[f.min_fitment_confidence]! : 0;
    const toHits = (hits: SearchHit[]): ItemHit[] =>
      hits.map((h) => {
        const doc = h.source as InventoryDoc;
        const matching = vehicle ? doc.fitment.filter((x) => fitmentMatches(x, vehicle)) : [];
        const best = matching.reduce<string | null>(
          (a, x) => (!a || (FITMENT_WEIGHT[x.confidence] ?? 0) > (FITMENT_WEIGHT[a] ?? 0) ? x.confidence : a),
          null,
        );
        const weight = best ? (FITMENT_WEIGHT[best] ?? 0) : 0;
        return { hit: h, doc, best, weight, fitOk: !vehicle || !f?.min_fitment_confidence || weight >= minRank };
      });
    const a = (await this.infra.search.search(INDEX.inventory, { filters, ...(text ? { text } : {}), ...(geo ? { geo } : {}), size: 1000 }))
      .hits;
    o.onCap(a.length, 1000);
    const retry = !!text && (parts.size > 0 || !!vehicle);
    const b =
      retry && (o.pool || a.length === 0)
        ? (await this.infra.search.search(INDEX.inventory, { filters, ...(geo ? { geo } : {}), size: 1000 })).hits
        : null;
    if (b) o.onCap(b.length, 1000);
    return { a: toHits(a), b: b ? toHits(b) : null };
  }

  /**
   * Retrieval and scoring: everything a filter set can be selected from. A run
   * (`pool: false`) retrieves with every filter, exactly as before facets; a
   * facet pool (`pool: true`, SearchRequest.facets) retrieves without the
   * facetable filters (facets.ts) so #select can count each option. Scores
   * never depend on the facetable filters.
   */
  async #collect(
    scope: TxScope,
    r: Resolved,
    intent: InterpretedIntent,
    residual: string,
    origin: GeoPoint | null,
    userId: string | null,
    o: { pool: boolean; now: Date },
  ): Promise<Pool> {
    const req = r.req;
    const f = req.filters;
    const services = await this.#services(intent, f);
    const lineage = new Set(services);
    for (const id of services) for (const a of await this.taxonomy.ancestors(id)) lineage.add(a);
    const parts = new Set<string>([
      ...(f?.part_category_node_ids ?? []),
      ...intent.chips.filter((c) => c.kind === 'part_category' && c.node_id).map((c) => c.node_id!),
    ]);
    const vehicle = r.vehicle ?? (await this.#vehicleFromChips(intent));
    const favorites = userId && this.community ? await this.community.favoriteOrgIds(scope, userId) : new Set<string>();
    const trade = r.orgContext ? await this.inventory.tradeVendorIds(scope) : new Set<string>();
    const urgency = req.urgency_level ?? null;
    const maxDistanceKm = r.bbox
      ? Math.max(r.bbox.north - r.bbox.south, r.bbox.east - r.bbox.west) * 111 * 0.5
      : (f?.distance_km ?? DEFAULT_RADIUS_KM);
    // Capabilities in a requested node or above it count for the request (54 §5.1 capability fit).
    // Searching as a fleet: its preferred providers get the 54 §5.1 bonus (and are the only results with preferred_partners_only).
    const preferred = new Set(
      r.orgContext && this.partners ? (await this.partners.preferredProviders(scope, r.orgContext)).map((p) => p.organizationId) : [],
    );
    const ctx: MatchContext = { services: lineage, partCategories: parts, vehicle, urgency, maxDistanceKm, favorites, preferred };
    const geo = this.#geo(r, origin);
    const target = intent.target_type;
    const pool: Pool = { providers: null, vendors: [], items: null, preferred, vehicle, services, parts, capped: false, none: false };
    // SearchFilters.preferred_partners_only: the searching fleet's active preferred providers only (none without a fleet context).
    if (f?.preferred_partners_only && preferred.size === 0) return { ...pool, none: true };
    const size = o.pool ? 1000 : 500;
    const onCap = (n: number, max: number) => {
      if (n >= max) pool.capped = true;
    };
    const open = (locations: LocationDoc[] | undefined) =>
      (locations ?? []).some((l) => openNow(l.hours as HoursSpec | null, l.timezone, o.now) === true);

    if (target === 'provider' || target === 'place') {
      const filters = [...this.#providerBase(services, lineage, f), ...(o.pool ? [] : indexFilters(PROVIDER_FILTERS, f))];
      const text = residual ? { query: residual, fields: { name: 3, description: 1 } } : undefined;
      const a = (await this.infra.search.search(INDEX.providers, { filters, ...(text ? { text } : {}), ...(geo ? { geo } : {}), size }))
        .hits;
      onCap(a.length, size);
      const retry = !!text && (services.size > 0 || !!vehicle);
      const b =
        retry && (o.pool || a.length === 0)
          ? (await this.infra.search.search(INDEX.providers, { filters, ...(geo ? { geo } : {}), size })).hits
          : null;
      if (b) onCap(b.length, size);
      const scored = new Map<string, ProviderEntry>();
      const entry = (h: SearchHit): ProviderEntry => {
        let e = scored.get(h.id);
        if (!e) {
          const doc = h.source as ProviderDoc;
          e = { doc, distanceKm: h.distanceKm, scored: scoreProvider(doc, h.distanceKm, ctx), open: open(doc.locations) };
          scored.set(h.id, e);
        }
        return e;
      };
      pool.providers = { a: a.map(entry), b: b ? b.map(entry) : null };
    }
    // Preferred partners are providers (52 FleetPreferredPartner preferred_provider): no vendor results under the filter.
    if (!f?.preferred_partners_only && (target === 'vendor' || target === 'place' || target === 'inventory_item')) {
      const partIntent = parts.size > 0 || target === 'inventory_item' || (!!residual && target !== 'place');
      // Part condition and stock narrow the items of a parts search (facetable there); for sellers they shape the matching items.
      const itemFilters = target === 'inventory_item' && o.pool ? [] : indexFilters(ITEM_FILTERS, f);
      const hits =
        partIntent || vehicle
          ? await this.#itemHits(r, vehicle, parts, residual, trade, origin, {
              itemFilters,
              pool: o.pool && target === 'inventory_item',
              onCap,
            })
          : { a: [], b: null };
      if (target === 'inventory_item') {
        const vendorRatings = new Map<string, { overall: number | null; count: number }>();
        for (const id of new Set([...hits.a, ...(hits.b ?? [])].map((i) => i.doc.vendor_organization_id))) {
          const v = (await this.infra.search.get(INDEX.vendors, id)) as VendorDoc | null;
          if (v) vendorRatings.set(id, { overall: v.overall_rating, count: v.review_count });
        }
        const entry = (i: ItemHit): ItemEntry => {
          const rating = vendorRatings.get(i.doc.vendor_organization_id) ?? null;
          return {
            ...i,
            rating,
            open: open(i.doc.locations),
            scored: rating
              ? scoreItem({ ...i.doc, fitmentWeight: i.weight, bestConfidence: i.best }, rating, i.hit.distanceKm, ctx, f?.part_conditions)
              : null,
          };
        };
        pool.items = { a: hits.a.map(entry), b: hits.b ? hits.b.map(entry) : null };
      } else {
        const items = pick(hits.a, hits.b, []).filter((i) => i.fitOk);
        const byVendor = new Map<string, ItemMatch>();
        for (const i of items) {
          const m = byVendor.get(i.doc.vendor_organization_id) ?? { count: 0, inStock: 0, fitment: 0, bestConfidence: null };
          m.count++;
          if (i.doc.stock_status === 'in_stock' || i.doc.stock_status === 'low_stock') m.inStock++;
          if (i.weight > m.fitment) {
            m.fitment = i.weight;
            m.bestConfidence = i.best;
          }
          byVendor.set(i.doc.vendor_organization_id, m);
        }
        const vendorFilters = o.pool ? [] : indexFilters(VENDOR_FILTERS, f);
        const vendorHits = new Map<string, SearchHit>();
        const vendors = async (q: { filters: SearchFilter[]; text?: { query: string; fields: Record<string, number> } }) => {
          const hs = (await this.infra.search.search(INDEX.vendors, { ...q, ...(geo ? { geo } : {}), size })).hits;
          onCap(hs.length, size);
          for (const h of hs) vendorHits.set(h.id, h);
        };
        if (!partIntent) {
          const text = residual ? { query: residual, fields: { name: 3, description: 1 } } : undefined;
          await vendors({ filters: vendorFilters, ...(text ? { text } : {}) });
        } else {
          // Vendors whose catalogue covers the categories, and every vendor with matching items.
          if (parts.size) await vendors({ filters: [...vendorFilters, { field: 'part_category_node_ids', in: [...parts] }] });
          if (byVendor.size) await vendors({ filters: [...vendorFilters, { field: 'organization_id', in: [...byVendor.keys()] }] });
        }
        for (const h of vendorHits.values()) {
          const d = h.source as VendorDoc;
          const items = byVendor.get(d.organization_id);
          if (f?.stock_available && !items?.inStock) continue;
          pool.vendors.push({
            doc: d,
            distanceKm: h.distanceKm,
            items,
            open: open(d.locations),
            scored: scoreVendor(
              d,
              items ?? (partIntent ? { count: 0, inStock: 0, fitment: 0, bestConfidence: null } : undefined),
              h.distanceKm,
              ctx,
            ),
          });
        }
      }
    }
    return pool;
  }

  /**
   * The results of one filter set from a pool: the index filters (the first
   * query's hits, or the retry's when they leave nothing), availability,
   * hybrid organizations as one place, open now and the "for my car" filter
   * with its fallback (54 §5.5). Unsorted.
   */
  #select(pool: Pool, req: SearchRequest, f: SearchFilters | undefined, now: Date): { kept: Candidate[]; fallback: boolean } {
    if (pool.none) return { kept: [], fallback: false };
    const candidates: Candidate[] = [];
    const nowMs = now.getTime();
    if (pool.providers) {
      for (const e of pick(pool.providers.a, pool.providers.b, indexFilters(PROVIDER_FILTERS, f))) {
        const d = e.doc;
        if (f?.preferred_partners_only && !pool.preferred.has(d.organization_id)) continue;
        // SearchFilters.available_within_days (S7; 0 = today, S10): an open slot in the window (providers without a calendar are left out).
        if (
          f?.available_within_days !== undefined &&
          !slotWithinDays(d.next_available_at, f.available_within_days, d.locations[0]?.timezone ?? DEFAULT_TZ, now)
        )
          continue;
        const slot = d.next_available_at ? Date.parse(d.next_available_at) : null;
        candidates.push({
          targetType: 'organization',
          targetId: d.organization_id,
          orgId: d.organization_id,
          scored: e.scored,
          distanceKm: e.distanceKm,
          matchingItems: null,
          rating: d.overall_rating,
          reviews: d.review_count,
          inactive: d.activity_status === 'inactive',
          urgentFit:
            e.scored.reasons.some((x) => x.reason_type === 'urgency_fit' && x.values.fast === true) || d.service_modes.includes('mobile'),
          slot: slot !== null && slot >= nowMs ? slot : null,
          open: e.open,
        });
      }
    }
    if (pool.items)
      for (const i of pick(pool.items.a, pool.items.b, indexFilters(ITEM_FILTERS, f))) {
        if (!i.fitOk || !i.rating || !i.scored) continue;
        candidates.push({
          targetType: 'inventory_item',
          targetId: i.doc.inventory_item_id,
          orgId: i.doc.vendor_organization_id,
          scored: i.scored,
          distanceKm: i.hit.distanceKm,
          matchingItems: null,
          rating: i.rating.overall,
          reviews: i.rating.count,
          inactive: false,
          urgentFit: false,
          slot: null,
          open: i.open,
        });
      }
    const vendorFilters = indexFilters(VENDOR_FILTERS, f);
    for (const v of pool.vendors) {
      if (!vendorFilters.every((g) => matchesFilter(v.doc, g))) continue;
      const existing = candidates.find((c) => c.orgId === v.doc.organization_id);
      // A hybrid organization is one place: it keeps its better side.
      if (existing) {
        if (v.scored.score > existing.scored.score) existing.scored = v.scored;
        existing.matchingItems = v.items?.count ?? existing.matchingItems;
        continue;
      }
      candidates.push({
        targetType: 'organization',
        targetId: v.doc.organization_id,
        orgId: v.doc.organization_id,
        scored: v.scored,
        distanceKm: v.distanceKm,
        matchingItems: v.items ? v.items.count : pool.vehicle ? 0 : null,
        rating: v.doc.overall_rating,
        reviews: v.doc.review_count,
        inactive: false,
        urgentFit: false,
        slot: null,
        open: v.open,
      });
    }
    let kept = f?.open_now ? candidates.filter((c) => c.open) : candidates;
    // "For my car" (54 §5.5): keep results relevant to the vehicle unless fewer than 3 would remain.
    let fallback = false;
    if (pool.vehicle && req.vehicle_filter_applied !== false) {
      const relevant = kept.filter((c) => c.scored.relevant_to_vehicle === true);
      if (relevant.length >= 3) kept = relevant;
      else fallback = true;
    }
    return { kept, fallback };
  }

  /** Runs retrieval and ranking; returns the ranked candidates, their number before the session cap and the vehicle-filter fallback flag. */
  async rank(
    scope: TxScope,
    r: Resolved,
    intent: InterpretedIntent,
    residual: string,
    origin: GeoPoint | null,
    userId: string | null,
  ): Promise<{
    candidates: Candidate[];
    total: number;
    capped: boolean;
    fallback: boolean;
    vehicle: VehicleContext | null;
    services: Set<string>;
    parts: Set<string>;
  }> {
    const now = new Date();
    const pool = await this.#collect(scope, r, intent, residual, origin, userId, { pool: false, now });
    const { kept, fallback } = this.#select(pool, r.req, r.req.filters, now);
    const sort = r.req.sort ?? 'best_match';
    const safetyCritical = r.req.urgency_level === 'safety_critical';
    const bestMatch = (a: Candidate, b: Candidate) =>
      b.scored.score - a.scored.score || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || (a.targetId < b.targetId ? -1 : 1);
    kept.sort((a, b) => {
      if (a.inactive !== b.inactive) return a.inactive ? 1 : -1; // 54 §6: inactive providers last
      if (sort === 'distance') return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || b.scored.score - a.scored.score;
      if (sort === 'rating') return (b.rating ?? -1) - (a.rating ?? -1) || b.reviews - a.reviews || b.scored.score - a.scored.score;
      // Soonest (contract 1.1.0): providers with an open slot by slot; the rest after, in best-match order. Scores are unchanged.
      if (sort === 'soonest') {
        if ((a.slot === null) !== (b.slot === null)) return a.slot === null ? 1 : -1;
        return (a.slot ?? 0) - (b.slot ?? 0) || bestMatch(a, b);
      }
      if (safetyCritical && a.urgentFit !== b.urgentFit) return a.urgentFit ? -1 : 1; // 54 §5.5 urgent providers first
      return bestMatch(a, b);
    });
    return {
      candidates: kept.slice(0, STORED_RESULTS),
      total: kept.length,
      capped: pool.capped,
      fallback,
      vehicle: pool.vehicle,
      services: pool.services,
      parts: pool.parts,
    };
  }

  /**
   * SearchRequest.facets (40 SearchFacets, contract 1.1.0): a second retrieval
   * without the facetable filters, from which each option's results are
   * selected exactly as the run selects its own. The run's results are untouched.
   */
  async facets(
    scope: TxScope,
    r: Resolved,
    intent: InterpretedIntent,
    residual: string,
    origin: GeoPoint | null,
    userId: string | null,
    run: { total: number; capped: boolean },
  ): Promise<SearchFacets> {
    const now = new Date();
    const pool = await this.#collect(scope, r, intent, residual, origin, userId, { pool: true, now });
    const languages = new Set<string>();
    for (const e of [...(pool.providers?.a ?? []), ...(pool.providers?.b ?? [])]) for (const l of e.doc.languages ?? []) languages.add(l);
    return computeFacets<SearchFilters>({
      target: intent.target_type,
      filters: r.req.filters ?? {},
      count: (g) => this.#select(pool, r.req, g, now).kept.length,
      resultCount: run.total,
      capped: pool.capped || run.capped,
      languages,
    });
  }

  /** Index documents of candidates (locations and hours for cards and pins). */
  async #docs(
    cands: readonly { targetType: string; targetId: string; orgId: string }[],
  ): Promise<Map<string, { locations: LocationDoc[] }>> {
    const out = new Map<string, { locations: LocationDoc[] }>();
    for (const c of cands) {
      if (out.has(c.targetId)) continue;
      const doc =
        c.targetType === 'inventory_item'
          ? await this.infra.search.get(INDEX.inventory, c.targetId)
          : ((await this.infra.search.get(INDEX.providers, c.orgId)) ?? (await this.infra.search.get(INDEX.vendors, c.orgId)));
      if (doc) out.set(c.targetId, doc as { locations: LocationDoc[] });
    }
    return out;
  }

  // -------------------------------------------------------------- sessions

  /** search.run / search.refine: interpret, rank, store the session and its results, answer the first page. */
  async run(ctx: OperationContext, req: SearchRequest, o: RunOptions = {}) {
    return ctx.tx((scope) => this.runIn(ctx, scope, req, o));
  }

  /** search.run in the caller's transaction (also Help Me matches, 40 triage.complete find_providers). */
  async runIn(ctx: OperationContext, scope: TxScope, req: SearchRequest, o: RunOptions = {}) {
    const locale = ctx.locale;
    const userId = ctx.principal.kind === 'user' ? ctx.principal.userId : null;
    const anonKey = ctx.principal.kind === 'anonymous' ? ctx.principal.anonKey : null;
    const limit = req.limit ?? 20;
    const safety = await this.safety.check(req.query_text ?? '');
    {
      const r = await this.resolve(ctx, scope, req);
      // SEC-BF-8 / SEC-AI-7: the server's safety check can only raise the urgency the client sent.
      const urgency = SafetyCheck.merge(safety.urgency, req.urgency_level ?? null);
      if (urgency) r.req = { ...r.req, urgency_level: urgency };
      const { intent, residual, cityKey } = await this.intent(r, locale);
      // A city named in the text moves the origin there unless the device position or a map area was sent.
      let origin = r.origin;
      let originMode: LocationInput['mode'] = r.originMode;
      if (cityKey && r.originMode === 'chosen_city') {
        origin = this.cityCenter(cityKey) ?? origin;
        originMode = 'chosen_city';
      }
      const ranked = await this.rank(scope, r, intent, residual, origin, userId);
      const facets = req.facets ? await this.facets(scope, r, intent, residual, origin, userId, ranked) : null;
      const firstOf = (kind: IntentChip['kind']) => intent.chips.find((c) => c.kind === kind && c.node_id)?.node_id ?? null;
      const block = safetyBlock({ safety_flag: safety.safety_flag, urgency: safety.urgency });
      const stored: StoredIntent = {
        ...intent,
        location: req.location,
        sort: req.sort ?? 'best_match',
        residual,
        facetsRequested: !!req.facets,
        safety: block,
        fallback: ranked.fallback,
        facets,
      };
      const session = await scope.db
        .insertInto('discovery.match_sessions')
        .values({
          requester_user_id: userId,
          anonymous_key_hash: userId ? null : anonKey,
          requester_organization_id: r.orgContext,
          source: o.source ?? 'search',
          issue_id: o.issueId ?? null,
          triage_session_id: o.triageSessionId ?? null,
          search_mode: req.search_mode,
          entry_point: req.entry_point,
          target_type: intent.target_type,
          vehicle_id: req.vehicle_id ?? null,
          query_text: req.query_text ?? null,
          interpreted_intent: JSON.stringify(stored),
          interpretation_source: 'rules',
          safety_flag: safety.safety_flag,
          symptom_node_id: firstOf('symptom'),
          service_system_node_id: firstOf('service_system'),
          service_task_node_id: firstOf('service_task'),
          part_category_node_id: firstOf('part_category'),
          latitude: origin?.lat ?? null,
          longitude: origin?.lng ?? null,
          distance_origin: originMode,
          map_viewport: req.location.mode === 'map_center' ? JSON.stringify(req.location.viewport) : null,
          vehicle_filter_applied: ranked.vehicle ? req.vehicle_filter_applied !== false : null,
          urgency_level: urgency,
          filters: req.filters ? JSON.stringify(req.filters) : null,
          locale,
        })
        .returning(['id', 'query_normalized'])
        .executeTakeFirstOrThrow();
      const labels = await this.taxonomy.labels(
        ranked.candidates.flatMap((c) => reasonNodeIds(c.scored.reasons)),
        locale,
      );
      const rows = ranked.candidates.length
        ? await scope.db
            .insertInto('discovery.match_results')
            .values(
              ranked.candidates.map((c, i) => ({
                match_session_id: session.id,
                target_entity_type: c.targetType,
                target_entity_id: c.targetId,
                rank: i + 1,
                match_score: String(c.scored.score),
                confidence: c.scored.confidence,
                reasons: JSON.stringify(c.scored.reasons),
                explanation_text: templateExplanation(c.scored.reasons, locale, labels),
                explanation_source: 'template',
                relevant_to_vehicle: c.scored.relevant_to_vehicle,
                matching_item_count: c.matchingItems,
              })),
            )
            .returningAll()
            .execute()
        : [];
      // Analytics (40 Appendix A): no query text, no ids of people.
      const analytics = {
        search_mode: req.search_mode,
        entry_point: req.entry_point,
        target_type: intent.target_type,
        result_count: rows.length,
        safety_flag: safety.safety_flag,
        vehicle_context: !!ranked.vehicle,
        distance_origin: originMode,
        locale,
      };
      await publishEvent(scope, { type: 'search.started', aggregateType: 'match_session', aggregateId: session.id, payload: analytics });
      if (rows.length === 0)
        await publishEvent(scope, {
          type: 'search.zero_result',
          aggregateType: 'match_session',
          aggregateId: session.id,
          payload: analytics,
        });
      if (o.previousChips && JSON.stringify(o.previousChips) !== JSON.stringify(intent.chips))
        await publishEvent(scope, {
          type: 'search.chip_edited',
          aggregateType: 'match_session',
          aggregateId: session.id,
          payload: { search_mode: req.search_mode, chips_before: o.previousChips.length, chips_after: intent.chips.length },
        });
      const sorted = rows.sort((a, b) => a.rank - b.rank);
      const page = sorted.slice(0, limit);
      const cards = await this.resultCards(scope, { id: session.id, origin, locale, vehicle: ranked.vehicle }, page);
      return {
        session_id: session.id,
        query_normalized: session.query_normalized ?? null,
        interpreted_intent: { target_type: intent.target_type, chips: intent.chips },
        interpretation_source: 'rules' as const,
        safety: block,
        results: cards,
        next_cursor: sorted.length > limit ? ctx.cursorFor('search.page', { session_id: session.id }, { o: limit }) : null,
        vehicle_filter_fallback: ranked.fallback,
        facets,
      };
    }
  }

  /**
   * search.session_get: the stored first page of a session of the caller
   * again, with what the run answered (chips, safety, fallback, facets) and
   * cards from current public data; no ranking, no analytics event. 404 after
   * 24 hours. Sessions stored before S10 answer their safety flag as a
   * warning-level block and no facets.
   */
  async sessionPage(ctx: OperationContext, scope: TxScope, id: string, limit: number) {
    const s = await this.session(scope, id);
    if (Date.parse(String(s.row.created_at)) < Date.now() - SESSION_READ_MS) throw new ApiError('NOT_FOUND');
    await this.sessionContext(ctx, scope, s.row.requester_organization_id);
    const rows = await this.results(scope, s.row.id, 0, limit);
    const cards = await this.resultCards(
      scope,
      { id: s.row.id, origin: s.origin, locale: ctx.locale, vehicle: s.vehicle },
      rows.slice(0, limit),
    );
    const st = s.stored;
    return {
      session_id: s.row.id,
      query_normalized: s.row.query_normalized ?? null,
      interpreted_intent: { target_type: st.target_type, chips: st.chips },
      interpretation_source: (s.row.interpretation_source ?? 'rules') as 'rules' | 'rules_plus_ai',
      safety: st.safety ?? safetyBlock({ safety_flag: !!s.row.safety_flag, urgency: (s.row.urgency_level as Urgency | null) ?? null }),
      results: cards,
      next_cursor: rows.length > limit ? ctx.cursorFor('search.page', { session_id: s.row.id }, { o: limit }) : null,
      vehicle_filter_fallback: st.fallback ?? false,
      facets: st.facets ?? null,
    };
  }

  /** Stored results → 40 ResultCard (current public cards; results of organizations no longer public are skipped). */
  async resultCards(
    scope: TxScope,
    s: { id: string; origin: GeoPoint | null; locale: Locale; vehicle: VehicleContext | null },
    rows: readonly {
      id: string;
      target_entity_type: string;
      target_entity_id: string;
      rank: number;
      match_score: string | number;
      confidence: string;
      reasons: unknown;
      explanation_text: string | null;
      relevant_to_vehicle: boolean | null;
      matching_item_count: number | null;
    }[],
  ) {
    const docs = await this.#docs(
      rows.map((r) => ({ targetType: r.target_entity_type, targetId: r.target_entity_id, orgId: r.target_entity_id })),
    );
    const itemIds = rows.filter((r) => r.target_entity_type === 'inventory_item').map((r) => r.target_entity_id);
    const items = itemIds.length
      ? await this.inventory.publicCards(scope, itemIds, {
          locale: s.locale,
          vehicle: s.vehicle
            ? {
                brand_node_id: s.vehicle.brand,
                model_node_id: s.vehicle.model ?? null,
                series_node_id: s.vehicle.series ?? null,
                year: s.vehicle.year ?? null,
              }
            : null,
        })
      : new Map();
    const orgOf = new Map<string, string>();
    for (const r of rows)
      orgOf.set(
        r.id,
        r.target_entity_type === 'inventory_item'
          ? String(((docs.get(r.target_entity_id) ?? {}) as { vendor_organization_id?: string }).vendor_organization_id ?? '')
          : r.target_entity_id,
      );
    const cards = await this.cards.cards(scope, [...new Set(orgOf.values())].filter(Boolean), s.locale);
    const reasonsOf = (r: (typeof rows)[number]) =>
      Array.isArray(r.reasons) ? (r.reasons as Reason[]) : (JSON.parse(String(r.reasons)) as Reason[]);
    const labels = await this.taxonomy.labels(
      rows.flatMap((r) => reasonNodeIds(reasonsOf(r))),
      s.locale,
    );
    const now = new Date();
    const slots = await this.#nextSlots(scope, rows, docs, now);
    const out = [];
    for (const r of rows) {
      const org: PublicOrgCard | undefined = cards.get(orgOf.get(r.id)!);
      if (!org) continue;
      const item = r.target_entity_type === 'inventory_item' ? items.get(r.target_entity_id) : null;
      if (r.target_entity_type === 'inventory_item' && !item) continue;
      const locations = docs.get(r.target_entity_id)?.locations ?? [];
      const nearest = s.origin ? [...locations].sort((a, b) => dist(s.origin!, a.point) - dist(s.origin!, b.point))[0] : locations[0];
      const reasons = reasonsOf(r);
      out.push({
        result_id: r.id,
        rank: r.rank,
        target: { type: r.target_entity_type, id: r.target_entity_id },
        organization: org,
        item: item ?? null,
        location: nearest
          ? {
              location_id: nearest.location_id,
              point: nearest.point,
              visibility: nearest.visibility,
              service_radius_km: nearest.service_radius_km,
              city: nearest.city,
            }
          : null,
        distance_km: nearest && s.origin ? decimal(dist(s.origin, nearest.point), 9999.9) : null,
        match_score: String(Math.round(Number(r.match_score) * 100) / 100),
        confidence: r.confidence,
        reasons: reasons.map((x) => ({ reason_type: x.reason_type, summary: reasonSummary(x, s.locale, labels), values: x.values })),
        explanation: {
          text: (r.explanation_text || templateExplanation(reasons, s.locale, labels) || '-').slice(0, 1000),
          source: 'template' as const,
        },
        relevant_to_vehicle: r.relevant_to_vehicle,
        matching_item_count: r.matching_item_count,
        next_available_slot: r.target_entity_type === 'organization' ? (slots.get(r.target_entity_id) ?? null) : null,
        open_now: nearest ? openNow(nearest.hours as HoursSpec | null, nearest.timezone, now) : null,
        is_sponsored: false as const,
      });
    }
    return out;
  }

  /**
   * ResultCard.next_available_slot (contract 1.1.0): the provider's projected
   * earliest open slot in the next 30 days, re-read from the public calendar
   * in the caller's transaction (as public.availability reads it) when it has
   * passed; never a past slot.
   */
  async #nextSlots(
    scope: TxScope,
    rows: readonly { target_entity_type: string; target_entity_id: string }[],
    docs: Map<string, { locations: LocationDoc[] }>,
    now: Date,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const stale: string[] = [];
    for (const r of rows) {
      if (r.target_entity_type !== 'organization') continue;
      const next = (docs.get(r.target_entity_id) as Partial<ProviderDoc> | undefined)?.next_available_at ?? null;
      if (next && Date.parse(next) < now.getTime()) stale.push(r.target_entity_id);
      else out.set(r.target_entity_id, next);
    }
    for (const id of stale) out.set(id, (await this.appointments?.nextOpenSlot(scope, id, now, NEXT_SLOT_DAYS))?.toISOString() ?? null);
    return out;
  }

  /** A session of the caller (RLS requester_all) with what paging and refining need. */
  async session(scope: TxScope, id: string) {
    const s = await scope.db
      .selectFrom('discovery.match_sessions')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!s) throw new ApiError('NOT_FOUND');
    const stored = (typeof s.interpreted_intent === 'string' ? JSON.parse(s.interpreted_intent) : s.interpreted_intent) as StoredIntent;
    let vehicle: VehicleContext | null = null;
    if (s.vehicle_id) {
      const v = await this.vehicles.visible(scope, s.vehicle_id);
      if (v) vehicle = { brand: v.brandNodeId, model: v.modelNodeId, series: v.seriesNodeId, year: v.year };
    }
    const origin = s.latitude !== null && s.longitude !== null ? { lat: Number(s.latitude), lng: Number(s.longitude) } : null;
    return { row: s, stored, origin, vehicle };
  }

  /** The caller's trade context of a stored session (re-authorized on every page). */
  async sessionContext(ctx: OperationContext, scope: TxScope, orgId: string | null): Promise<void> {
    if (!orgId) return;
    const org = await ctx.authorizeOrg(orgId, ['P*', 'F*']);
    await scope.setOrganization(org.id, org.role);
  }

  /** The stored request of a session, for search.refine. */
  storedRequest(s: Awaited<ReturnType<SearchService['session']>>): SearchRequest {
    const row = s.row;
    return {
      ...(row.query_text ? { query_text: row.query_text } : {}),
      search_mode: (row.search_mode ?? 'all') as SearchRequest['search_mode'],
      entry_point: row.entry_point ?? 'search_box',
      ...(row.vehicle_id ? { vehicle_id: row.vehicle_id } : {}),
      ...(row.vehicle_filter_applied !== null ? { vehicle_filter_applied: row.vehicle_filter_applied } : {}),
      ...(row.requester_organization_id ? { as_organization_id: row.requester_organization_id } : {}),
      location: s.stored.location,
      ...(row.urgency_level ? { urgency_level: row.urgency_level as Urgency } : {}),
      ...(row.filters ? { filters: (typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters) as SearchFilters } : {}),
      sort: s.stored.sort,
      ...(s.stored.facetsRequested ? { facets: true } : {}),
    };
  }

  /** Results of a session from a rank offset (search.page). */
  async results(scope: TxScope, sessionId: string, offset: number, limit: number) {
    return scope.db
      .selectFrom('discovery.match_results')
      .selectAll()
      .where('match_session_id', '=', sessionId)
      .where('deleted_at', 'is', null)
      .orderBy('rank')
      .offset(offset)
      .limit(limit + 1)
      .execute();
  }

  /** match acceptance metric (search.result_event): first view and first selection. */
  async markResult(scope: TxScope, sessionId: string, resultId: string, event: 'viewed' | 'selected'): Promise<void> {
    const col = event === 'viewed' ? 'viewed_at' : 'selected_at';
    const r = await scope.db
      .updateTable('discovery.match_results')
      .set({ [col]: sql`coalesce(${sql.ref(col)}, now())` })
      .where('id', '=', resultId)
      .where('match_session_id', '=', sessionId)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
  }
}

const rad = (d: number): number => (d * Math.PI) / 180;
export function dist(a: GeoPoint, b: GeoPoint): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
