// Public inventory reads (40 §14.3): public.org_inventory_search and
// public.inventory_get. Items of a published vendor that are active and
// public, or trade_only for members of an organization with an approved trade
// account (RLS trade_read once the trade context is set); the trade price is
// shown only to those callers (InventoryRead, SEC-OUT-1). At least one of
// text, category or vehicle is required (SEC-BF-4). A vehicle_id must be the
// caller's own vehicle and never leaves the server.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { normalizeSearchText } from '#libs/i18n/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { PublicOrgCards, PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { bestConfidence, type FitmentConfidence } from '../domain/rules.js';
import { InventoryRead, type FitmentVehicle } from '../interface/inventory.js';

const RANK: Record<FitmentConfidence, number> = { confirmed: 3, likely: 2, uncertain: 1 };
/** Candidates considered per search before paging (the vendor's matching public items). */
const MAX_CANDIDATES = 1000;

/** LIKE pattern for a literal substring. */
const contains = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** 40 public.* as_organization_id: the caller must be a member of that provider or fleet (trade prices, trade-only items). */
export async function tradeContext(ctx: OperationContext, scope: TxScope, asOrganizationId: string | undefined): Promise<void> {
  if (!asOrganizationId) return;
  if (ctx.principal.kind !== 'user') throw new ApiError('UNAUTHENTICATED', { detail: 'as_organization_id needs a signed-in member' });
  const org = await ctx.authorizeOrg(asOrganizationId, ['P*', 'F*']);
  await scope.setOrganization(org.id, org.role);
}

/** A vehicle of the caller (personal, or of the context fleet) for fitment, or the taxonomy vehicle of the body. */
export async function fitmentVehicle(
  ctx: OperationContext,
  scope: TxScope,
  vehicles: VehicleCards,
  b: { vehicle_id?: string; vehicle?: FitmentVehicle },
): Promise<FitmentVehicle | null> {
  if (b.vehicle_id) {
    if (ctx.principal.kind !== 'user') throw new ApiError('UNAUTHENTICATED', { detail: 'vehicle_id needs sign-in' });
    const v = await vehicles.visible(scope, b.vehicle_id);
    if (!v) throw ApiError.validation([{ pointer: '/vehicle_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    return { brand_node_id: v.brandNodeId, model_node_id: v.modelNodeId, series_node_id: v.seriesNodeId, year: v.year };
  }
  return b.vehicle ?? null;
}

type SearchBody = {
  text?: string;
  part_category_node_id?: string;
  vehicle_id?: string;
  vehicle?: FitmentVehicle;
  as_organization_id?: string;
  cursor?: string;
  limit?: number;
};

@Injectable()
@Operation('public.org_inventory_search')
export class PublicOrgInventorySearchHandler implements OperationHandler {
  constructor(
    private readonly read: InventoryRead,
    private readonly profiles: PublicProfiles,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {}

  async handle(ctx: OperationContext<SearchBody>): Promise<OperationResult> {
    const b = ctx.body;
    const limit = b.limit ?? 20;
    if (!b.text && !b.part_category_node_id && !b.vehicle_id && !b.vehicle)
      // 40 VALIDATION_FAILED(filter_required): one of text, category or vehicle.
      throw ApiError.validation([{ pointer: '/text', code: 'conditional_required' }]);
    const vendorId = ctx.params.org_id!;
    const offset = (ctx.cursor as { o?: number } | undefined)?.o ?? 0;
    const body = await ctx.tx(
      async (scope) => {
        await tradeContext(ctx, scope, b.as_organization_id);
        const vehicle = await fitmentVehicle(ctx, scope, this.vehicles, b);
        if (!(await this.profiles.vendors(scope, [vendorId])).has(vendorId)) throw new ApiError('NOT_FOUND');
        if (vehicle?.model_node_id)
          await this.taxonomy.requireDescendant(vehicle.model_node_id, vehicle.brand_node_id, '/vehicle/model_node_id');
        let q = scope.db
          .selectFrom('inventory.inventory_items as i')
          .select(['i.id', 'i.data_quality_score'])
          .where('i.vendor_organization_id', '=', vendorId)
          .where('i.status', '=', 'active')
          .where('i.visibility', 'in', ['public', 'trade_only'])
          .where('i.deleted_at', 'is', null);
        if (b.text) {
          const raw = contains(b.text);
          const normalized = contains(normalizeSearchText(b.text, { dbLocale: this.config.db.locale }));
          q = q.where(
            sql<boolean>`(i.sku ILIKE ${raw} OR core.normalize_search_text(i.name_translations::text) LIKE ${normalized}
                          OR coalesce(i.normalized_name, '') LIKE ${normalized} OR coalesce(i.brand, '') ILIKE ${raw}
                          OR EXISTS (SELECT 1 FROM unnest(i.oem_numbers || i.aftermarket_numbers) AS n(v) WHERE n.v ILIKE ${raw}))`,
          );
        }
        if (b.part_category_node_id) q = q.where('i.part_category_node_id', 'in', await this.taxonomy.descendants(b.part_category_node_id));
        if (vehicle)
          q = q.where(
            sql<boolean>`EXISTS (SELECT 1 FROM inventory.inventory_fitment f WHERE f.inventory_item_id = i.id
                           AND f.brand_node_id = ${vehicle.brand_node_id}::uuid AND f.status = 'active' AND f.deleted_at IS NULL)`,
          );
        const candidates = await q.orderBy('i.data_quality_score', 'desc').orderBy('i.id').limit(MAX_CANDIDATES).execute();
        let ordered = candidates.map((c) => ({ id: c.id, quality: c.data_quality_score, rank: 0 }));
        if (vehicle) {
          const fitment = ordered.length
            ? await scope.db
                .selectFrom('inventory.inventory_fitment')
                .select(['inventory_item_id', 'brand_node_id', 'model_node_id', 'series_node_id', 'year_start', 'year_end', 'confidence'])
                .where(
                  'inventory_item_id',
                  'in',
                  ordered.map((o) => o.id),
                )
                .where('status', '=', 'active')
                .where('deleted_at', 'is', null)
                .execute()
            : [];
          ordered = ordered
            .map((o) => {
              const best = bestConfidence(
                fitment.filter((f) => f.inventory_item_id === o.id),
                vehicle,
              );
              return { ...o, rank: best ? RANK[best] : 0 };
            })
            .filter((o) => o.rank > 0)
            .sort((x, y) => y.rank - x.rank || y.quality - x.quality || (x.id < y.id ? -1 : 1));
        }
        const slice = ordered.slice(offset, offset + limit + 1);
        const cards = await this.read.publicCards(
          scope,
          slice.map((o) => o.id),
          { locale: ctx.locale, vehicle },
        );
        const page = slice.slice(0, limit).flatMap((o) => (cards.has(o.id) ? [cards.get(o.id)!] : []));
        return ctx.page(page, slice.length > limit ? { o: offset + limit } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('public.inventory_get')
export class PublicInventoryGetHandler implements OperationHandler {
  constructor(
    private readonly read: InventoryRead,
    private readonly profiles: PublicProfiles,
    private readonly cards: PublicOrgCards,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<undefined, { as_organization_id?: string }>): Promise<OperationResult> {
    const body = await ctx.tx(
      async (scope) => {
        await tradeContext(ctx, scope, ctx.query.as_organization_id);
        const item = await this.read.publicItem(scope, ctx.params.item_id!, { locale: ctx.locale });
        if (!item) throw new ApiError('NOT_FOUND');
        const [vendor, pins, media] = await Promise.all([
          this.cards.cards(scope, [item.vendor_organization_id], ctx.locale),
          this.profiles.pins(scope, [item.vendor_organization_id]),
          this.media.publicAttachmentViews(scope, 'inventory_item', [item.id]),
        ]);
        const card = vendor.get(item.vendor_organization_id);
        if (!card) throw new ApiError('NOT_FOUND');
        const vendorPins = pins.get(item.vendor_organization_id) ?? [];
        const { vendor_organization_id: _v, location_id, ...rest } = item;
        return {
          ...rest,
          vendor: card,
          location: vendorPins.find((p) => p.location_id === location_id) ?? vendorPins[0] ?? null,
          media: (media.get(item.id) ?? []).slice(0, 20),
        };
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
