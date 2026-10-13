// InventoryRead (interface/inventory.ts): reads in the caller's RLS context.
// A public item needs its vendor published and the organization active, the
// item active and not hidden (52 §21); trade_only items are visible only
// under RLS trade_read (an approved trade account of the context
// organization), and only those callers get the trade price (SEC-OUT-1).
import { Injectable } from '@nestjs/common';
import { l10n, type Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import type { FitmentRow, ItemRow } from '../api/projections.js';
import { bestConfidence, type FitmentConfidence } from '../domain/rules.js';
import {
  InventoryRead,
  type FitmentVehicle,
  type InquiryVisit,
  type InventorySearchSource,
  type PublicInventoryCard,
  type PublicInventoryItemParts,
} from '../interface/inventory.js';

type Translations = Record<string, string>;

@Injectable()
export class DbInventoryRead extends InventoryRead {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
  ) {
    super();
  }

  async visibleIds(scope: TxScope, ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Set();
    const rows = await scope.db
      .selectFrom('inventory.inventory_items')
      .select(['id', 'vendor_organization_id', 'status', 'visibility'])
      .where('id', 'in', unique)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .execute();
    const own = rows.filter((r) => r.vendor_organization_id === scope.context.orgId);
    const others = rows.filter(
      (r) => r.vendor_organization_id !== scope.context.orgId && r.status === 'active' && r.visibility !== 'hidden',
    );
    const published = await this.profiles.vendors(
      scope,
      others.map((r) => r.vendor_organization_id),
    );
    return new Set([...own.map((r) => r.id), ...others.filter((r) => published.has(r.vendor_organization_id)).map((r) => r.id)]);
  }

  /** Public rows among `ids`: active, not hidden, of published vendors (RLS adds trade_only only for approved trade customers). */
  async #publicRows(scope: TxScope, ids: readonly string[]): Promise<ItemRow[]> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return [];
    const rows = await scope.db
      .selectFrom('inventory.inventory_items')
      .selectAll()
      .where('id', 'in', unique)
      .where('status', '=', 'active')
      .where('visibility', 'in', ['public', 'trade_only'])
      .where('deleted_at', 'is', null)
      .execute();
    const published = await this.profiles.vendors(
      scope,
      rows.map((r) => r.vendor_organization_id),
    );
    return rows.filter((r) => published.has(r.vendor_organization_id));
  }

  /** Vendors with which the context organization has an approved trade account (RLS customer_read). */
  async #tradeVendors(scope: TxScope, vendorIds: readonly string[]): Promise<Set<string>> {
    const org = scope.context.orgId;
    if (!org || vendorIds.length === 0) return new Set();
    const rows = await scope.db
      .selectFrom('inventory.vendor_trade_accounts')
      .select('vendor_organization_id')
      .where('trade_customer_organization_id', '=', org)
      .where('vendor_organization_id', 'in', [...new Set(vendorIds)])
      .where('status', '=', 'approved')
      .where('deleted_at', 'is', null)
      .execute();
    return new Set(rows.map((r) => r.vendor_organization_id));
  }

  async #fitment(scope: TxScope, itemIds: readonly string[]): Promise<Map<string, FitmentRow[]>> {
    const out = new Map<string, FitmentRow[]>();
    if (itemIds.length === 0) return out;
    const rows = await scope.db
      .selectFrom('inventory.inventory_fitment')
      .selectAll()
      .where('inventory_item_id', 'in', [...itemIds])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute();
    for (const f of rows) out.set(f.inventory_item_id, [...(out.get(f.inventory_item_id) ?? []), f]);
    return out;
  }

  async #cards(scope: TxScope, rows: ItemRow[], o: { locale: Locale; vehicle?: FitmentVehicle | null }) {
    const trade = await this.#tradeVendors(
      scope,
      rows.map((r) => r.vendor_organization_id),
    );
    const categories = await this.taxonomy.labels(
      rows.map((r) => r.part_category_node_id),
      o.locale,
    );
    const images = await this.media.publicImageUrls(
      scope,
      'inventory_item',
      rows.map((r) => r.id),
    );
    const fitment = o.vehicle
      ? await this.#fitment(
          scope,
          rows.map((r) => r.id),
        )
      : new Map<string, FitmentRow[]>();
    const out = new Map<string, PublicInventoryCard & { is_trade_price: boolean }>();
    for (const r of rows) {
      const useTrade = trade.has(r.vendor_organization_id) && r.price_trade !== null;
      const amount = useTrade ? r.price_trade : r.price_public;
      const name = l10n(r.name_translations as Translations, o.locale);
      const category = categories.get(r.part_category_node_id);
      if (!name || !category) continue;
      out.set(r.id, {
        id: r.id,
        name,
        part_origin: r.part_origin,
        condition: r.condition,
        part_category: category,
        price: amount !== null && r.currency ? { amount, currency: r.currency } : null,
        price_on_request: r.price_on_request,
        stock_status: r.stock_status,
        fitment_confidence_for_vehicle: o.vehicle ? bestConfidence(fitment.get(r.id) ?? [], o.vehicle) : null,
        image_url: images.get(r.id) ?? null,
        is_trade_price: useTrade,
      });
    }
    return out;
  }

  async publicCards(
    scope: TxScope,
    ids: readonly string[],
    o: { locale: Locale; vehicle?: FitmentVehicle | null },
  ): Promise<Map<string, PublicInventoryCard>> {
    const out = new Map<string, PublicInventoryCard>();
    for (const [id, { is_trade_price: _trade, ...card }] of await this.#cards(scope, await this.#publicRows(scope, ids), o))
      out.set(id, card);
    return out;
  }

  async publicItem(scope: TxScope, id: string, o: { locale: Locale }): Promise<PublicInventoryItemParts | null> {
    const [row] = await this.#publicRows(scope, [id]);
    if (!row) return null;
    const card = (await this.#cards(scope, [row], o)).get(row.id);
    if (!card) return null;
    const fitment = (await this.#fitment(scope, [row.id])).get(row.id) ?? [];
    const labels = await this.taxonomy.labels(
      fitment.flatMap((f) => [f.brand_node_id, f.model_node_id, f.series_node_id, f.engine_type_node_id]).filter((x): x is string => !!x),
      o.locale,
    );
    const label = (nodeId: string | null) => (nodeId ? (labels.get(nodeId) ?? null) : null);
    return {
      ...card,
      vendor_organization_id: row.vendor_organization_id,
      location_id: row.location_id,
      description: l10n(row.description_translations as Translations | null, o.locale),
      brand: row.brand,
      oem_numbers: row.oem_numbers,
      aftermarket_numbers: row.aftermarket_numbers,
      position: row.position,
      warranty_note: row.warranty_note,
      fitment: fitment
        .filter((f) => label(f.brand_node_id))
        .slice(0, 200)
        .map((f) => ({
          brand: label(f.brand_node_id)!,
          model: label(f.model_node_id),
          series: label(f.series_node_id),
          year_start: f.year_start,
          year_end: f.year_end,
          engine: label(f.engine_type_node_id),
          confidence: f.confidence as FitmentConfidence,
        })),
    };
  }

  async searchSources(scope: TxScope, ids: readonly string[]): Promise<Map<string, InventorySearchSource>> {
    const rows = await this.#publicRows(scope, ids);
    const fitment = await this.#fitment(
      scope,
      rows.map((r) => r.id),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          vendor_organization_id: r.vendor_organization_id,
          name_translations: r.name_translations as Translations,
          normalized_name: r.normalized_name,
          sku: r.sku,
          part_numbers: [...(r.oem_numbers ?? []), ...(r.aftermarket_numbers ?? [])],
          brand: r.brand,
          part_category_node_id: r.part_category_node_id,
          part_origin: r.part_origin,
          condition: r.condition,
          stock_status: r.stock_status,
          visibility: r.visibility as 'public' | 'trade_only',
          // 52 §10: price_public of public items only; trade prices are never indexed.
          price_public: r.visibility === 'public' ? r.price_public : null,
          currency: r.currency,
          price_on_request: r.price_on_request,
          data_quality_score: r.data_quality_score,
          location_id: r.location_id,
          fitment: (fitment.get(r.id) ?? []).map((f) => ({
            brand_node_id: f.brand_node_id,
            model_node_id: f.model_node_id,
            series_node_id: f.series_node_id,
            year_start: f.year_start,
            year_end: f.year_end,
            engine_type_node_id: f.engine_type_node_id,
            confidence: f.confidence,
          })),
        },
      ]),
    );
  }

  async vendorItemIds(scope: TxScope, vendorOrgId: string): Promise<string[]> {
    const rows = await scope.db
      .selectFrom('inventory.inventory_items')
      .select('id')
      .where('vendor_organization_id', '=', vendorOrgId)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .limit(50_000)
      .execute();
    return rows.map((r) => r.id);
  }

  async tradeVendorIds(scope: TxScope): Promise<Set<string>> {
    const org = scope.context.orgId;
    if (!org) return new Set();
    const rows = await scope.db
      .selectFrom('inventory.vendor_trade_accounts')
      .select('vendor_organization_id')
      .where('trade_customer_organization_id', '=', org)
      .where('status', '=', 'approved')
      .where('deleted_at', 'is', null)
      .execute();
    return new Set(rows.map((r) => r.vendor_organization_id));
  }

  async inquiryVisits(
    scope: TxScope,
    f: { ids?: readonly string[]; vendorOrgId?: string; requesterUserId?: string; completedSince?: Date; limit?: number },
  ): Promise<InquiryVisit[]> {
    if (f.ids && f.ids.length === 0) return [];
    let q = scope.db
      .selectFrom('inventory.stock_inquiries')
      .select(['id', 'vendor_organization_id', 'requester_user_id', 'requester_type', 'status', 'closed_at'])
      .where('deleted_at', 'is', null);
    if (f.ids) q = q.where('id', 'in', [...f.ids].slice(0, 500));
    if (f.vendorOrgId) q = q.where('vendor_organization_id', '=', f.vendorOrgId);
    if (f.requesterUserId) q = q.where('requester_user_id', '=', f.requesterUserId);
    if (f.completedSince) q = q.where('status', '=', 'completed').where('closed_at', '>=', f.completedSince);
    const rows = await q
      .orderBy('id', 'desc')
      .limit(Math.min(f.limit ?? 50, 500))
      .execute();
    return rows.map((r) => ({
      id: r.id,
      vendorOrgId: r.vendor_organization_id,
      requesterUserId: r.requester_user_id,
      requesterType: r.requester_type,
      status: r.status,
      completedAt: r.status === 'completed' && r.closed_at ? new Date(r.closed_at) : null,
    }));
  }
}
