// map.pins (40 §14.2; 54 §5.5): one pin per business location in the
// viewport, public fields and public points only (SEC-OUT-4), clustered by
// zoom. Filters highlight (matches_filters false → the client dims the pin)
// instead of hiding; the vehicle filter keeps relevant pins unless fewer than
// 3 would remain. With a search session the pins carry its ranks and reason
// summaries (the same ranking everywhere, 54 §5.4). Never a featured pin.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { openNow, validateBBox, type BBox, type GeoPoint, type HoursSpec } from '#libs/geo/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra, SearchDocument } from '#libs/infra/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { ratingString } from '#modules/trust/interface/trust.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { principalKey } from '#libs/auth/index.js';
import { cluster } from '../domain/clustering.js';
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
        vehicle = { brand: b.filters.brand_node_id, model: b.filters.model_node_id ?? null, year: b.filters.year ?? null };

      // Ranks and reasons of the search session the map belongs to.
      const ranks = new Map<string, { rank: number; reasons: Reason[] }>();
      if (b.search_session_id) {
        const s = await this.search.session(scope, b.search_session_id);
        for (const r of await this.search.results(scope, s.row.id, 0, 1000))
          if (r.target_entity_type === 'organization' && !ranks.has(r.target_entity_id))
            ranks.set(r.target_entity_id, {
              rank: r.rank,
              reasons: (typeof r.reasons === 'string' ? JSON.parse(r.reasons) : r.reasons) as Reason[],
            });
      }

      const geo = { field: 'locations.point', bbox: b.viewport.bbox };
      const docs = new Map<string, { doc: SearchDocument; roles: Set<'provider' | 'vendor'>; matches: boolean }>();
      const f = b.filters;
      for (const layer of b.layers) {
        const index = layer === 'providers' ? INDEX.providers : INDEX.vendors;
        const all = await this.infra.search.search(index, { geo, size: 1000 });
        const filters = f ? this.#filters(layer, f) : [];
        const matching = filters.length
          ? new Set((await this.infra.search.search(index, { geo, filters, size: 1000 })).hits.map((h) => h.id))
          : null;
        for (const h of all.hits) {
          const e = docs.get(h.id) ?? { doc: h.source, roles: new Set(), matches: false };
          e.roles.add(layer === 'providers' ? 'provider' : 'vendor');
          e.matches ||= !matching || matching.has(h.id);
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
      const now = new Date();
      const bbox = b.viewport.bbox;
      const pins = entries.flatMap(([id, e]) =>
        ((e.doc.locations as LocationDoc[] | undefined) ?? [])
          .filter((l) => l.point.lat >= bbox.south && l.point.lat <= bbox.north && l.point.lng >= bbox.west && l.point.lng <= bbox.east)
          .map((l) => {
            const ranked = ranks.get(id);
            return {
              id: l.location_id,
              point: l.point,
              pin: {
                pin_id: l.location_id,
                organization_id: id,
                roles: [...e.roles],
                point: l.point,
                visibility: l.visibility,
                service_radius_km: l.service_radius_km,
                name: String(e.doc.name).slice(0, 120),
                overall_rating: ratingString((e.doc.overall_rating as number | null) ?? null),
                badge: ((e.doc.badges as string[] | undefined) ?? [])[0] ?? null,
                open_now: openNow(l.hours as HoursSpec | null, l.timezone, now),
                matches_filters: e.matches,
                relevant_to_vehicle: relevant(id, e.doc),
                matching_item_count: vehicle && e.roles.has('vendor') ? (itemCounts.get(id) ?? 0) : null,
                rank: ranked && ranked.rank <= 1000 ? ranked.rank : null,
                reason_summary: ranked?.reasons[0] ? reasonSummary(ranked.reasons[0], ctx.locale, labels) : null,
              },
            };
          }),
      );
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
        attribution: '© OpenStreetMap contributors' as const,
      };
    });
    return { body };
  }

  #filters(layer: 'providers' | 'vendors', f: SearchFilters) {
    const out = [];
    if (f.min_rating) out.push({ field: 'overall_rating', gte: Number(f.min_rating) });
    if (f.verified_only) out.push({ field: 'verified', eq: true });
    if (layer === 'providers') {
      if (f.service_system_node_ids?.length || f.service_task_node_ids?.length)
        out.push({ field: 'service_node_ids', in: [...(f.service_system_node_ids ?? []), ...(f.service_task_node_ids ?? [])] });
      if (f.service_modes?.length) out.push({ field: 'service_modes', in: f.service_modes });
      if (f.price_tiers?.length) out.push({ field: 'price_tier', in: f.price_tiers });
      if (f.provider_types?.length) out.push({ field: 'provider_type', in: f.provider_types });
      if (f.badges?.length) out.push({ field: 'badges', in: f.badges });
      if (f.fleet_friendly) out.push({ field: 'fleet_friendly', eq: true });
      if (f.ev_capable) out.push({ field: 'ev_ready', eq: true });
      if (f.warranty_offered) out.push({ field: 'warranty_offered', eq: true });
      if (f.languages?.length) out.push({ field: 'languages', in: f.languages });
    } else {
      if (f.vendor_types?.length) out.push({ field: 'vendor_type', in: f.vendor_types });
      if (f.part_category_node_ids?.length) out.push({ field: 'part_category_node_ids', in: f.part_category_node_ids });
      if (f.delivery_options?.length) out.push({ field: 'delivery_options', in: f.delivery_options });
      if (f.trade_pricing) out.push({ field: 'trade_customers_supported', eq: true });
    }
    return out as Parameters<Infra['search']['search']>[1]['filters'] & object;
  }
}
