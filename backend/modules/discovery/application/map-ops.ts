// map.pins (40 §14.2; 54 §5.5): one pin per business location in the
// viewport, public fields and public points only (SEC-OUT-4), clustered by
// zoom. Filters highlight (matches_filters false → the client dims the pin)
// instead of hiding; the vehicle filter keeps relevant pins unless fewer than
// 3 would remain. With a search session the pins carry its ranks and reason
// summaries (the same ranking everywhere, 54 §5.4). Never a featured pin.
// Contract 1.1.0 (S10): open_now per location and available_within_days per
// provider take part in the highlight, only_matching leaves the other pins
// out before clustering, counts cover the viewport, and pins carry the
// profile slug, card fields and the session's result id.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { openNow, validateBBox, type BBox, type GeoPoint, type HoursSpec } from '#libs/geo/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { matchesFilter, type Infra, type SearchDocument, type SearchFilter } from '#libs/infra/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { ratingString } from '#modules/trust/interface/trust.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { principalKey } from '#libs/auth/index.js';
import { cluster } from '../domain/clustering.js';
import { indexFilters, PROVIDER_FILTERS, slotWithinDays, VENDOR_FILTERS } from '../domain/facets.js';
import { fitmentMatches, type Reason, type VehicleContext } from '../domain/ranking.js';
import { reasonNodeIds, reasonSummary } from '../domain/reasons.js';
import { INDEX, type InventoryDoc, type LocationDoc } from '../infrastructure/projections.js';
import { SearchService, type SearchFilters } from './search-service.js';

type MapQuery = {
  viewport: { center: GeoPoint; zoom: number; bbox: BBox };
  layers: ('providers' | 'vendors')[];
  search_session_id?: string;
  vehicle_id?: string;
  vehicle_filter_applied?: boolean;
  filters?: SearchFilters;
  as_organization_id?: string;
  only_matching?: boolean;
};

/** "First call of a map session": one map.opened per caller per half hour. */
const MAP_SESSION_MS = 30 * 60_000;

@Injectable()
@Operation('map.pins')
export class MapPinsHandler implements OperationHandler {
  constructor(
    private readonly search: SearchService,
    private readonly region: RegionConfigService,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  async handle(ctx: OperationContext<MapQuery>): Promise<OperationResult> {
    const b = ctx.body;
    // 40 map.pins 422 VALIDATION_FAILED(bbox_too_large): the span per axis is limited by the region config.
    const bboxErrors = validateBBox(b.viewport.bbox, this.region.maxBboxDeg, '/viewport/bbox');
    if (bboxErrors.length) throw ApiError.validation(bboxErrors);
    if ((b.vehicle_id || b.as_organization_id) && ctx.principal.kind !== 'user') throw new ApiError('UNAUTHENTICATED');
    const body = await ctx.tx(async (scope) => {
      if (b.as_organization_id) {
        const org = await ctx.authorizeOrg(b.as_organization_id, ['P*', 'F*']);
        await scope.setOrganization(org.id, org.role);
      }
      let vehicle: VehicleContext | null = null;
      if (b.vehicle_id) {
        const v = await this.vehicles.visible(scope, b.vehicle_id);
        if (!v) throw ApiError.validation([{ pointer: '/vehicle_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
        vehicle = { brand: v.brandNodeId, model: v.modelNodeId, series: v.seriesNodeId, year: v.year };
      } else if (b.filters?.brand_node_id)
        vehicle = {
          brand: b.filters.brand_node_id,
          model: b.filters.model_node_id ?? null,
          series: b.filters.series_node_id ?? null,
          year: b.filters.year ?? null,
        };

      // Ranks, reasons and result ids of the search session the map belongs to.
      const ranks = new Map<string, { rank: number; reasons: Reason[]; resultId: string }>();
      if (b.search_session_id) {
        const s = await this.search.session(scope, b.search_session_id);
        for (const r of await this.search.results(scope, s.row.id, 0, 1000))
          if (r.target_entity_type === 'organization' && !ranks.has(r.target_entity_id))
            ranks.set(r.target_entity_id, {
              rank: r.rank,
              reasons: (typeof r.reasons === 'string' ? JSON.parse(r.reasons) : r.reasons) as Reason[],
              resultId: r.id,
            });
      }

      const now = new Date();
      const geo = { field: 'locations.point', bbox: b.viewport.bbox };
      const docs = new Map<string, { doc: SearchDocument; roles: Set<'provider' | 'vendor'>; matches: boolean }>();
      const f = b.filters;
      for (const layer of b.layers) {
        const index = layer === 'providers' ? INDEX.providers : INDEX.vendors;
        const all = await this.infra.search.search(index, { geo, size: 1000 });
        // The search's filters, judged on the documents with the index's own semantics (matchesFilter).
        const filters = f ? this.#filters(layer, f) : [];
        const matches = (d: SearchDocument): boolean =>
          filters.every((g) => matchesFilter(d, g)) &&
          // SearchFilters.available_within_days (S10): the provider's next open slot, as in search (vendors keep no calendar).
          (layer !== 'providers' ||
            f?.available_within_days === undefined ||
            slotWithinDays(
              d.next_available_at as string | null,
              f.available_within_days,
              ((d.locations as LocationDoc[] | undefined) ?? [])[0]?.timezone ?? 'Asia/Tehran',
              now,
            ));
        for (const h of all.hits) {
          const e = docs.get(h.id) ?? { doc: h.source, roles: new Set(), matches: false };
          e.roles.add(layer === 'providers' ? 'provider' : 'vendor');
          e.matches ||= matches(h.source);
          docs.set(h.id, e);
        }
      }

      // Vehicle relevance: provider coverage, or vendor items that fit (grouped per seller, 54 §5.5).
      const itemCounts = new Map<string, number>();
      if (vehicle && b.layers.includes('vendors'))
        for (const h of (
          await this.infra.search.search(INDEX.inventory, {
            geo,
            filters: [
              { field: 'fitment_brand_ids', eq: vehicle.brand },
              { field: 'visibility', eq: 'public' },
            ],
            size: 1000,
          })
        ).hits) {
          const d = h.source as InventoryDoc;
          if (d.fitment.some((x) => fitmentMatches(x, vehicle!)))
            itemCounts.set(d.vendor_organization_id, (itemCounts.get(d.vendor_organization_id) ?? 0) + 1);
        }
      const relevant = (id: string, d: SearchDocument): boolean | null =>
        vehicle ? ((d.brand_node_ids as string[] | undefined) ?? []).includes(vehicle.brand) || (itemCounts.get(id) ?? 0) > 0 : null;

      let entries = [...docs.entries()];
      let fallback = false;
      if (vehicle && b.vehicle_filter_applied !== false) {
        const kept = entries.filter(([id, e]) => relevant(id, e.doc) === true);
        if (kept.length >= 3) entries = kept;
        else fallback = true;
      }
      const labels = await this.taxonomy.labels(
        [...ranks.values()].flatMap((r) => reasonNodeIds(r.reasons)),
        ctx.locale,
      );
      const bbox = b.viewport.bbox;
      const inView = entries.flatMap(([id, e]) =>
        ((e.doc.locations as LocationDoc[] | undefined) ?? [])
          .filter((l) => l.point.lat >= bbox.south && l.point.lat <= bbox.north && l.point.lng >= bbox.west && l.point.lng <= bbox.east)
          .map((l) => {
            const ranked = ranks.get(id);
            const open = openNow(l.hours as HoursSpec | null, l.timezone, now);
            return {
              id: l.location_id,
              point: l.point,
              pin: {
                pin_id: l.location_id,
                organization_id: id,
                slug: (e.doc.slug as string | null | undefined) ?? null,
                organization_type: orgType(e.doc, e.roles),
                roles: [...e.roles],
                point: l.point,
                visibility: l.visibility,
                service_radius_km: l.service_radius_km,
                name: String(e.doc.name).slice(0, 120),
                verified: e.doc.verified === true,
                overall_rating: ratingString((e.doc.overall_rating as number | null) ?? null),
                review_count: Number(e.doc.review_count ?? 0),
                badge: ((e.doc.badges as string[] | undefined) ?? [])[0] ?? null,
                open_now: open,
                // SearchFilters.open_now is judged per location (S10).
                matches_filters: e.matches && (!f?.open_now || open === true),
                relevant_to_vehicle: relevant(id, e.doc),
                matching_item_count: vehicle && e.roles.has('vendor') ? (itemCounts.get(id) ?? 0) : null,
                rank: ranked && ranked.rank <= 1000 ? ranked.rank : null,
                reason_summary: ranked?.reasons[0] ? reasonSummary(ranked.reasons[0], ctx.locale, labels) : null,
                result_id: ranked?.resultId ?? null,
              },
            };
          }),
      );
      // MapResponse.counts: locations in view before only_matching, clustering and the cap.
      const matching = inView.filter((p) => p.pin.matches_filters).length;
      const pins = b.only_matching ? inView.filter((p) => p.pin.matches_filters) : inView;
      // Ranked and highlighted pins first, so the cap keeps the most useful ones.
      pins.sort(
        (x, y) =>
          (x.pin.rank ?? 1e9) - (y.pin.rank ?? 1e9) ||
          Number(y.pin.matches_filters) - Number(x.pin.matches_filters) ||
          (x.id < y.id ? -1 : 1),
      );
      const grouped = cluster(pins, b.viewport.zoom);
      if (!b.search_session_id) {
        const key = `map:opened:${principalKey(ctx.principal)}`;
        if (await this.infra.kv.set(key, '1', { ttlMs: MAP_SESSION_MS, mode: 'NX' }))
          await publishEvent(scope, {
            type: 'map.opened',
            aggregateType: 'map_session',
            aggregateId: uuidv7(),
            payload: { zoom: b.viewport.zoom, layers: b.layers, vehicle_context: !!vehicle, locale: ctx.locale },
          });
      }
      return {
        pins: grouped.pins.map((p) => p.pin),
        clusters: grouped.clusters,
        vehicle_filter_fallback: fallback,
        counts: { matching, others: b.only_matching ? 0 : inView.length - matching },
        attribution: '© OpenStreetMap contributors' as const,
      };
    });
    return { body };
  }

  /** The search's document filters of a layer (facets.ts, shared with search) plus the map's service and category highlight. */
  #filters(layer: 'providers' | 'vendors', f: SearchFilters): SearchFilter[] {
    if (layer === 'providers') {
      const out = indexFilters(PROVIDER_FILTERS, f);
      if (f.service_system_node_ids?.length || f.service_task_node_ids?.length)
        out.push({ field: 'service_node_ids', in: [...(f.service_system_node_ids ?? []), ...(f.service_task_node_ids ?? [])] });
      if (f.max_response_time) {
        const order = ['within_2h', 'same_day', 'within_24h', 'within_48h'];
        out.push({ field: 'response_time_target', in: order.slice(0, order.indexOf(f.max_response_time) + 1) });
      }
      return out;
    }
    const out = indexFilters(VENDOR_FILTERS, f);
    if (f.part_category_node_ids?.length) out.push({ field: 'part_category_node_ids', in: f.part_category_node_ids });
    return out;
  }
}

/** 40 OrgType of a pin: from the document (S10 projections), else from the layers it was found in. */
function orgType(doc: SearchDocument, roles: Set<'provider' | 'vendor'>): string {
  if (typeof doc.organization_type === 'string') return doc.organization_type;
  return roles.size === 2 ? 'hybrid_provider_vendor' : roles.has('vendor') ? 'vendor' : 'provider';
}
