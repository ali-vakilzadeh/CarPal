// Helpers shared by the inventory use cases (40 §13): the vendor member of
// {vnd} routes, item rules (40 InventoryItemWrite conditionals, 52
// InventoryItem), item and catalog quality (54 §7.2), keyset paging and the
// inventory.updated event.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import { normalizeSearchText } from '#libs/i18n/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgLocations, VendorCatalog } from '#modules/organization/interface/vendor-catalog.js';
import type { ItemRow } from '../api/projections.js';
import {
  catalogQualityScore,
  dataQualityScore,
  FULFILLMENT_RESPONSE_HOURS,
  FULFILLMENT_WINDOW_DAYS,
  fulfillmentRate,
} from '../domain/rules.js';

export interface VendorMember {
  userId: string;
  orgId: string;
  role: string;
}

/** The signed-in member and the authorized path organization ({vnd}, {org}). */
export function vendorMember(ctx: OperationContext): VendorMember {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id, role: org.role };
}

export function checkVersion(version: number, ifMatch: number | undefined): void {
  if (ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED');
  if (version !== ifMatch) throw new ApiError('VERSION_MISMATCH');
}

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

/** Page<T> from `limit + 1` rows ordered by id. */
export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], map: (r: R) => T) {
  const limit = ctx.query.limit;
  const page = rows.slice(0, limit);
  return ctx.page(page.map(map), rows.length > limit ? { id: page.at(-1)!.id } : null);
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** 40 InventoryItemWrite. */
export type InventoryItemWrite = {
  sku: string;
  name_translations: Record<string, string>;
  description_translations?: Record<string, string>;
  brand?: string;
  oem_numbers?: string[];
  aftermarket_numbers?: string[];
  part_origin: string;
  condition: string;
  part_category_node_id: string;
  position?: string[];
  price_public?: string;
  price_trade?: string;
  price_on_request: boolean;
  currency?: string;
  stock_quantity?: number;
  stock_status: string;
  location_id?: string;
  warranty_note?: string;
  notes?: string;
  visibility: string;
  status?: 'draft' | 'active' | 'hidden' | 'discontinued';
};

/** Item columns written from InventoryItemWrite (jsonb translations serialized). */
export function itemColumns(b: Partial<InventoryItemWrite>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = k === 'name_translations' || k === 'description_translations' ? json(v) : v;
  }
  return out;
}

/** 52 InventoryItem.normalized_name by rules (an accepted AI normalization replaces it, S9): the search form of the name. */
export function normalizedName(names: Record<string, string>): string | null {
  const name = names.en ?? Object.values(names)[0];
  return name ? normalizeSearchText(name).slice(0, 200) : null;
}

/** Conditionals of 40 InventoryItemWrite on the merged item (C: lines, 52 name 3–160 per locale). */
export function itemFieldErrors(m: Partial<InventoryItemWrite>): FieldError[] {
  const errors: FieldError[] = [];
  for (const [locale, v] of Object.entries(m.name_translations ?? {}))
    if ([...v].length < 3) errors.push({ pointer: `/name_translations/${locale}`, code: 'too_short', limit: '3' });
  if (!m.price_on_request && (m.price_public === undefined || m.price_public === null))
    errors.push({ pointer: '/price_public', code: 'conditional_required' });
  if ((m.price_public || m.price_trade) && !m.currency) errors.push({ pointer: '/currency', code: 'conditional_required' });
  return errors;
}

/** The merged write view of a stored item (for conditionals on a partial update). */
export function itemAsWrite(i: ItemRow): Partial<InventoryItemWrite> {
  return {
    sku: i.sku,
    name_translations: i.name_translations as Record<string, string>,
    ...(i.price_public !== null ? { price_public: i.price_public } : {}),
    ...(i.price_trade !== null ? { price_trade: i.price_trade } : {}),
    ...(i.currency !== null ? { currency: i.currency } : {}),
    price_on_request: i.price_on_request,
  };
}

/** The item fields behind data_quality_score (54 §7.2). */
export interface QualityFields {
  oem_numbers?: string[] | null;
  aftermarket_numbers?: string[] | null;
  part_category_node_id?: string | null;
  warranty_note?: string | null;
  description_translations?: unknown;
  stock_status?: string | null;
}

/** Active items count toward max_inventory_items (52). */
export const activating = (from: string | null, to: string | undefined): boolean => to === 'active' && from !== 'active';

@Injectable()
export class ItemReferences {
  constructor(private readonly locations: OrgLocations) {}

  /** location_id must be an active location of the vendor (SEC-AZ-4). */
  async check(scope: TxScope, orgId: string, b: Partial<InventoryItemWrite>): Promise<void> {
    if (b.location_id && !(await this.locations.isActive(scope, orgId, b.location_id))) throw notFoundAt('/location_id');
  }
}

/** inventory.updated (40 Appendix A): ids and what changed, for the search indexer (S6) and analytics. */
export async function inventoryUpdated(scope: TxScope, vendorOrgId: string, itemIds: readonly string[], change: string): Promise<void> {
  if (itemIds.length === 0) return;
  await publishEvent(scope, {
    type: 'inventory.updated',
    aggregateType: 'organization',
    aggregateId: vendorOrgId,
    payload: { item_ids: itemIds.slice(0, 500), change },
  });
}

/**
 * Item data quality and the vendor's catalog quality (54 §7.2), stored on
 * the items and, through the organization module, on the vendor profile.
 * Runs in the vendor member's or the system context.
 */
@Injectable()
export class CatalogQuality {
  constructor(
    private readonly media: MediaService,
    private readonly catalog: VendorCatalog,
  ) {}

  /** data_quality_score of an item as it will be stored (computed in the same write, so one write is one version). */
  static score(i: QualityFields, images: number): number {
    return dataQualityScore({
      images,
      partNumbers: (i.oem_numbers?.length ?? 0) > 0 || (i.aftermarket_numbers?.length ?? 0) > 0,
      category: !!i.part_category_node_id,
      warrantyNote: !!i.warranty_note,
      description: !!i.description_translations,
      stockStatus: !!i.stock_status,
    });
  }

  /** Clean images attached to one item (media). */
  async images(scope: TxScope, itemId: string): Promise<number> {
    return (await this.media.imageCounts(scope, 'inventory_item', [itemId])).get(itemId) ?? 0;
  }

  /** Recomputes data_quality_score of stored items (images change outside this module: imports, the daily rule). */
  async scoreItems(scope: TxScope, items: readonly ItemRow[]): Promise<void> {
    if (items.length === 0) return;
    const images = await this.media.imageCounts(
      scope,
      'inventory_item',
      items.map((i) => i.id),
    );
    for (const i of items) {
      const score = CatalogQuality.score(i, images.get(i.id) ?? 0);
      if (score !== i.data_quality_score)
        await scope.db.updateTable('inventory.inventory_items').set({ data_quality_score: score }).where('id', '=', i.id).execute();
    }
  }

  /** Recomputes every active item of the vendor (daily rule, imports). */
  async scoreCatalog(scope: TxScope, vendorOrgId: string): Promise<void> {
    let after: string | null = null;
    for (;;) {
      let q = scope.db
        .selectFrom('inventory.inventory_items')
        .selectAll()
        .where('vendor_organization_id', '=', vendorOrgId)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null);
      if (after) q = q.where('id', '>', after);
      const rows = await q.orderBy('id').limit(1000).execute();
      await this.scoreItems(scope, rows);
      if (rows.length < 1000) return;
      after = rows.at(-1)!.id;
    }
  }

  /** Inquiry figures of the last 90 days (54 §3.2): fulfillment counts and the average first response in minutes. */
  async inquiryFigures(scope: TxScope, vendorOrgId: string, period?: { from: string; to: string }) {
    const from = period ? sql`${period.from}::date` : sql`now() - make_interval(days => ${FULFILLMENT_WINDOW_DAYS})`;
    const to = period ? sql`${period.to}::date + 1` : sql`now()`;
    const hours = FULFILLMENT_RESPONSE_HOURS;
    const { rows } = await sql<{ received: number; eligible: number; fulfilled: number; response_minutes: string | null }>`
      SELECT count(*)::int AS received,
             count(*) FILTER (WHERE first_response_at IS NOT NULL
                                 OR (status <> 'cancelled' AND created_at < now() - make_interval(hours => ${hours})))::int AS eligible,
             count(*) FILTER (WHERE first_response_at IS NOT NULL
                                AND first_response_at <= created_at + make_interval(hours => ${hours})
                                AND status <> 'unavailable')::int AS fulfilled,
             avg(extract(epoch FROM first_response_at - created_at) / 60)
               FILTER (WHERE first_response_at IS NOT NULL) AS response_minutes
        FROM inventory.stock_inquiries
       WHERE vendor_organization_id = ${vendorOrgId}::uuid AND deleted_at IS NULL
         AND created_at >= ${from} AND created_at < ${to}`.execute(scope.db);
    const r = rows[0]!;
    return {
      received: Number(r.received),
      rate: fulfillmentRate(Number(r.eligible), Number(r.fulfilled)),
      responseMinutes: r.response_minutes === null ? null : Math.round(Number(r.response_minutes)),
    };
  }

  /** Catalog quality score and measured response time, written to the vendor profile when they change. */
  async refreshVendor(scope: TxScope, vendorOrgId: string): Promise<number> {
    const { rows } = await sql<{ active: number; confirmed: number; avg_quality: string | null }>`
      SELECT count(*)::int AS active,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM inventory.inventory_fitment f
                                             WHERE f.inventory_item_id = i.id AND f.status = 'active'
                                               AND f.confidence = 'confirmed' AND f.deleted_at IS NULL))::int AS confirmed,
             avg(data_quality_score) AS avg_quality
        FROM inventory.inventory_items i
       WHERE i.vendor_organization_id = ${vendorOrgId}::uuid AND i.status = 'active' AND i.deleted_at IS NULL`.execute(scope.db);
    const items = rows[0]!;
    const inquiries = await this.inquiryFigures(scope, vendorOrgId);
    const score = catalogQualityScore({
      activeItems: Number(items.active),
      confirmedFitmentItems: Number(items.confirmed),
      averageDataQuality: items.avg_quality === null ? null : Number(items.avg_quality),
      fulfillmentRate: inquiries.rate,
    });
    await this.catalog.record(scope, vendorOrgId, { catalogQualityScore: score, measuredResponseTimeMinutes: inquiries.responseMinutes });
    return score;
  }
}
