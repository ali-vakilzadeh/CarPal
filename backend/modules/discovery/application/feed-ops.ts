// feed.discover (40 §19.2; 52: the Discover feed is computed from the search
// projections and follows, never stored, and never a full social feed):
// followed organizations' posts, maintenance tips for the caller's vehicle,
// providers for that vehicle, nearby providers, showcases and Q&A. The cards
// (40 FeedCard, server-defined) carry public data only.
import { Injectable, Optional } from '@nestjs/common';
import type { GeoPoint } from '#libs/geo/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { CommunityRead } from '#modules/community/interface/community.js';
import { PublicOrgCards, PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { INDEX, type ProviderDoc } from '../infrastructure/projections.js';
import { SearchService, type LocationInput } from './search-service.js';

type FeedBody = { location: LocationInput; vehicle_id?: string; cursor?: string; limit?: number };
type Kind = 'nearby_provider' | 'showcase' | 'qna' | 'maintenance_tip' | 'followed_update' | 'recommended_for_vehicle';
interface FeedEntry {
  kind: Kind;
  ref: { type: 'organization' | 'portfolio_item' | 'post' | 'question' | 'maintenance_reminder'; id: string };
  card: Record<string, unknown>;
}

const NEARBY_KM = 25;
const MAX_ITEMS = 100;

@Injectable()
@Operation('feed.discover')
export class FeedDiscoverHandler implements OperationHandler {
  constructor(
    private readonly search: SearchService,
    private readonly cards: PublicOrgCards,
    private readonly profiles: PublicProfiles,
    private readonly vehicles: VehicleCards,
    @InjectInfra() private readonly infra: Infra,
    @Optional() private readonly community?: CommunityRead,
  ) {}

  async handle(ctx: OperationContext<FeedBody>): Promise<OperationResult> {
    const b = ctx.body;
    const limit = b.limit ?? 20;
    const offset = (ctx.cursor as { o?: number } | undefined)?.o ?? 0;
    const userId = ctx.principal.kind === 'user' ? ctx.principal.userId : null;
    const body = await ctx.tx(
      async (scope) => {
        const r = await this.search.resolve(ctx, scope, {
          search_mode: 'all',
          entry_point: 'search_box',
          location: b.location,
          ...(b.vehicle_id ? { vehicle_id: b.vehicle_id } : {}),
        });
        const origin: GeoPoint | null = r.origin;
        const entries: FeedEntry[] = [];

        if (userId && this.community) {
          const followed = await this.community.followedOrgIds(scope, userId, 50);
          for (const p of await this.community.recentPosts(scope, followed, 10))
            entries.push({
              kind: 'followed_update',
              ref: { type: 'post', id: p.id },
              card: {
                organization_id: p.organization_id,
                post_type: p.post_type,
                title: p.title,
                excerpt: p.body.slice(0, 280),
                published_at: p.published_at.toISOString(),
              },
            });
        }
        if (b.vehicle_id)
          for (const m of await this.vehicles.openReminders(scope, b.vehicle_id, 5))
            entries.push({
              kind: 'maintenance_tip',
              ref: { type: 'maintenance_reminder', id: m.id },
              card: { title: m.title, reminder_type: m.reminder_type, status: m.status, priority: m.priority },
            });

        const geo = origin
          ? r.bbox
            ? { field: 'locations.point', origin, bbox: r.bbox }
            : { field: 'locations.point', origin, radiusKm: NEARBY_KM, pointRadiusField: 'service_radius_km' }
          : undefined;
        const nearby = (await this.infra.search.search(INDEX.providers, { ...(geo ? { geo } : {}), size: 50 })).hits;
        const orgIds = nearby.map((h) => h.id);
        const vehicle = r.vehicle;
        const forVehicle = vehicle
          ? nearby.filter((h) => (h.source as ProviderDoc).brand_node_ids.includes(vehicle.brand)).slice(0, 5)
          : [];
        const cards = await this.cards.cards(scope, orgIds, ctx.locale);
        const orgCard = (id: string, distanceKm: number | null) => {
          const c = cards.get(id);
          return c ? { organization: c, distance_km: distanceKm === null ? null : String(Math.round(distanceKm * 10) / 10) } : null;
        };
        for (const h of forVehicle) {
          const card = orgCard(h.id, h.distanceKm);
          if (card)
            entries.push({
              kind: 'recommended_for_vehicle',
              ref: { type: 'organization', id: h.id },
              card: { ...card, brand_node_id: vehicle!.brand },
            });
        }
        for (const h of nearby.slice(0, 10)) {
          if (forVehicle.some((x) => x.id === h.id)) continue;
          const card = orgCard(h.id, h.distanceKm);
          if (card) entries.push({ kind: 'nearby_provider', ref: { type: 'organization', id: h.id }, card });
        }

        // Showcases of nearby providers (published portfolio items, publicly servable media only).
        if (orgIds.length) {
          const showcases = (
            await this.infra.search.search(INDEX.community, {
              filters: [
                { field: 'entity_type', eq: 'portfolio_item' },
                { field: 'organization_id', in: orgIds },
              ],
              size: 20,
            })
          ).hits
            .sort((a, b2) => String(b2.source.published_at).localeCompare(String(a.source.published_at)))
            .slice(0, 5);
          const items = await this.profiles.portfolioItems(
            scope,
            showcases.map((h) => String(h.source.entity_id)),
            ctx.locale,
          );
          for (const item of items.values()) {
            const media = item.media as { thumbnail_url?: string | null; url?: string | null }[];
            entries.push({
              kind: 'showcase',
              ref: { type: 'portfolio_item', id: item.id },
              card: {
                title: item.title,
                organization: cards.get(item.organization_id) ?? null,
                service_system: item.service_system,
                thumbnail_url: media[0]?.thumbnail_url ?? media[0]?.url ?? null,
                published_at: item.published_at,
              },
            });
          }
        }

        if (this.community) {
          const nodes = vehicle ? [vehicle.brand, vehicle.model].filter((x): x is string => !!x) : undefined;
          for (const q of await this.community.recentQuestions(scope, { ...(nodes ? { nodeIds: nodes } : {}), limit: 5 }))
            entries.push({
              kind: 'qna',
              ref: { type: 'question', id: q.id },
              card: { title: q.title, status: q.status, answer_count: q.answer_count, created_at: q.created_at.toISOString() },
            });
        }

        const all = entries.slice(0, MAX_ITEMS);
        const page = all.slice(offset, offset + limit);
        return ctx.page(page, offset + limit < all.length ? { o: offset + limit } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}
