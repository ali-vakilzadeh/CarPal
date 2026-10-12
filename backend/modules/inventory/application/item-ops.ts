// Vendor inventory items (40 §13.2): inventory.list / search / create / get /
// update / delete / bulk_update / duplicate_mark. Items are the vendor's
// own (RLS vendor_all); active items are limited by max_inventory_items
// inside the write transaction (SEC-AZ-9); the SKU is unique per vendor.
// Every change emits inventory.updated (search indexer, S6) and refreshes
// the item and catalog quality (54 §7.2).
import { Injectable } from '@nestjs/common';
import { sql, type SelectQueryBuilder } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors, type DB } from '#libs/db/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { acceptedJob, JobService } from '#libs/jobs/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { toInventoryItem, type ItemRow } from '../api/projections.js';
import {
  activating,
  afterId,
  CatalogQuality,
  checkVersion,
  failIf,
  inventoryUpdated,
  itemAsWrite,
  itemColumns,
  itemFieldErrors,
  ItemReferences,
  normalizedName,
  notFoundAt,
  vendorMember,
  type InventoryItemWrite,
  type VendorMember,
} from './common.js';

registerConstraintErrors({
  // 40 inventory.create: 409 DUPLICATE(sku), unique within the vendor.
  inventory_items_sku_uq: { code: 'DUPLICATE', pointer: '/sku', fieldCode: 'not_unique' },
});

export const BULK_QUEUE = 'inventory.bulk_update';

@Injectable()
export class ItemViews {
  constructor(private readonly media: MediaService) {}

  async many(scope: TxScope, rows: readonly ItemRow[]) {
    const ids = rows.map((r) => r.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const fit = await scope.db
        .selectFrom('inventory.inventory_fitment')
        .select(['inventory_item_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('inventory_item_id', 'in', ids)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .groupBy('inventory_item_id')
        .execute();
      for (const f of fit) counts.set(f.inventory_item_id, Number(f.n));
    }
    const media = await this.media.attachmentViews(scope, 'inventory_item', ids);
    return rows.map((r) => toInventoryItem(r, { media: media.get(r.id) ?? [], fitmentCount: counts.get(r.id) ?? 0 }));
  }

  async one(scope: TxScope, row: ItemRow) {
    return (await this.many(scope, [row]))[0]!;
  }
}

/** One of the vendor's items (not removed). */
export async function loadItem(scope: TxScope, m: VendorMember, itemId: string, lock = false): Promise<ItemRow> {
  const q = scope.db
    .selectFrom('inventory.inventory_items')
    .selectAll()
    .where('id', '=', itemId)
    .where('vendor_organization_id', '=', m.orgId)
    .where('status', '<>', 'removed')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

type ListQuery = {
  status?: string;
  visibility?: string;
  stock_status?: string;
  part_category_node_id?: string;
  missing_fitment?: boolean;
  missing_images?: boolean;
  sort: 'updated_desc' | 'quality_asc' | 'sku_asc';
  limit: number;
};
/** Keyset position per sort: (updated_at, id), (data_quality_score, id) or (sku, id). */
type ListPosition = { k: string | number; id: string } | undefined;

type ItemQuery = SelectQueryBuilder<DB, 'inventory.inventory_items', ItemRow>;

function keyset(q: ItemQuery, sort: ListQuery['sort'], pos: ListPosition): ItemQuery {
  if (sort === 'updated_desc') {
    if (pos) q = q.where(sql<boolean>`(updated_at, id) < (${new Date(String(pos.k))}, ${pos.id}::uuid)`);
    return q.orderBy('updated_at', 'desc').orderBy('id', 'desc');
  }
  if (sort === 'quality_asc') {
    if (pos) q = q.where(sql<boolean>`(data_quality_score, id) > (${Number(pos.k)}, ${pos.id}::uuid)`);
    return q.orderBy('data_quality_score').orderBy('id');
  }
  if (pos) q = q.where(sql<boolean>`(sku, id) > (${String(pos.k)}, ${pos.id}::uuid)`);
  return q.orderBy('sku').orderBy('id');
}

const positionOf = (r: ItemRow, sort: ListQuery['sort']): ListPosition => ({
  k: sort === 'updated_desc' ? new Date(r.updated_at).toISOString() : sort === 'quality_asc' ? r.data_quality_score : r.sku,
  id: r.id,
});

@Injectable()
@Operation('inventory.list')
export class InventoryListHandler implements OperationHandler {
  constructor(
    private readonly views: ItemViews,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        const fetch = (pos: ListPosition, n: number) => {
          let s: ItemQuery = scope.db
            .selectFrom('inventory.inventory_items')
            .selectAll()
            .where('vendor_organization_id', '=', m.orgId)
            .where('deleted_at', 'is', null);
          s = q.status ? s.where('status', '=', q.status) : s.where('status', '<>', 'removed');
          if (q.visibility) s = s.where('visibility', '=', q.visibility);
          if (q.stock_status) s = s.where('stock_status', '=', q.stock_status);
          if (q.part_category_node_id) s = s.where('part_category_node_id', '=', q.part_category_node_id);
          if (q.missing_fitment !== undefined) {
            const has = sql<boolean>`EXISTS (SELECT 1 FROM inventory.inventory_fitment f WHERE f.inventory_item_id = inventory_items.id
                                               AND f.status = 'active' AND f.deleted_at IS NULL)`;
            s = s.where(q.missing_fitment ? sql<boolean>`NOT ${has}` : has);
          }
          return keyset(s, q.sort, pos).limit(n).execute();
        };
        // missing_images needs the media module's attachments: filter chunk by chunk until the page is full.
        const rows: ItemRow[] = [];
        let pos = ctx.cursor as ListPosition;
        const chunkSize = Math.max(q.limit + 1, 100);
        for (;;) {
          const chunk = await fetch(pos, chunkSize);
          let keep = chunk;
          if (q.missing_images !== undefined) {
            const images = await this.media.imageCounts(
              scope,
              'inventory_item',
              chunk.map((r) => r.id),
            );
            keep = chunk.filter((r) => ((images.get(r.id) ?? 0) === 0) === q.missing_images);
          }
          rows.push(...keep.slice(0, q.limit + 1 - rows.length));
          if (rows.length > q.limit || chunk.length < chunkSize) break;
          pos = positionOf(chunk.at(-1)!, q.sort);
        }
        const page = rows.slice(0, q.limit);
        return ctx.page(await this.views.many(scope, page), rows.length > q.limit ? positionOf(page.at(-1)!, q.sort) : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** LIKE pattern for a literal substring. */
const contains = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

@Injectable()
@Operation('inventory.search')
export class InventorySearchHandler implements OperationHandler {
  constructor(private readonly views: ItemViews) {}

  async handle(ctx: OperationContext<{ text: string; cursor?: string; limit?: number }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const limit = ctx.body.limit ?? 20;
    const pattern = contains(ctx.body.text);
    const folded = contains(normalizedName({ en: ctx.body.text }) ?? ctx.body.text);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        // SKU, OEM/aftermarket numbers or name (all locales, and the normalized search form); parameters only (SEC-IN-6).
        let q = scope.db
          .selectFrom('inventory.inventory_items')
          .selectAll()
          .where('vendor_organization_id', '=', m.orgId)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null)
          .where(
            sql<boolean>`(sku ILIKE ${pattern} OR normalized_name LIKE ${folded} OR name_translations::text ILIKE ${pattern}
                          OR EXISTS (SELECT 1 FROM unnest(oem_numbers || aftermarket_numbers) AS n(v) WHERE n.v ILIKE ${pattern}))`,
          );
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        return ctx.page(await this.views.many(scope, page), rows.length > limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('inventory.create')
export class InventoryCreateHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly refs: ItemReferences,
    private readonly quality: CatalogQuality,
    private readonly views: ItemViews,
  ) {}

  async handle(ctx: OperationContext<InventoryItemWrite>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    failIf(itemFieldErrors(b));
    const status = b.status ?? 'draft';
    const body = await ctx.tx(async (scope) => {
      await this.refs.check(scope, m.orgId, b);
      // ENT(max_inventory_items): an active item counts; a draft only needs the entitlement.
      await requireEntitlement(
        this.entitlements,
        scope,
        { type: 'organization', id: m.orgId },
        'max_inventory_items',
        status === 'active' ? 1 : 0,
      );
      const row = await scope.db
        .insertInto('inventory.inventory_items')
        .values({
          ...itemColumns(b),
          vendor_organization_id: m.orgId,
          sku: b.sku,
          name_translations: JSON.stringify(b.name_translations),
          part_origin: b.part_origin,
          condition: b.condition,
          part_category_node_id: b.part_category_node_id,
          stock_status: b.stock_status,
          normalized_name: normalizedName(b.name_translations),
          // A new item has no images yet.
          data_quality_score: CatalogQuality.score(b, 0),
          status,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await inventoryUpdated(scope, m.orgId, [row.id], 'created');
      await this.quality.refreshVendor(scope, m.orgId);
      return this.views.one(scope, row);
    });
    return created(body, `/v1/orgs/${m.orgId}/vendor/inventory/${body.id}`);
  }
}

@Injectable()
@Operation('inventory.get')
export class InventoryGetHandler implements OperationHandler {
  constructor(private readonly views: ItemViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const body = await ctx.tx(async (scope) => this.views.one(scope, await loadItem(scope, m, ctx.params.item_id!)), { readOnly: true });
    return { body };
  }
}

@Injectable()
@Operation('inventory.update')
export class InventoryUpdateHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly refs: ItemReferences,
    private readonly quality: CatalogQuality,
    private readonly views: ItemViews,
  ) {}

  async handle(ctx: OperationContext<Partial<InventoryItemWrite>>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const i = await loadItem(scope, m, ctx.params.item_id!, true);
      checkVersion(i.version, ctx.ifMatch);
      failIf(itemFieldErrors({ ...itemAsWrite(i), ...b }));
      await this.refs.check(scope, m.orgId, b);
      // ENT(max_inventory_items: if activating).
      if (activating(i.status, b.status))
        await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'max_inventory_items', 1);
      const set = itemColumns(b);
      if (b.name_translations) set.normalized_name = normalizedName(b.name_translations);
      const score = CatalogQuality.score({ ...i, ...b }, await this.quality.images(scope, i.id));
      if (score !== i.data_quality_score) set.data_quality_score = score;
      const row = Object.keys(set).length
        ? await scope.db.updateTable('inventory.inventory_items').set(set).where('id', '=', i.id).returningAll().executeTakeFirstOrThrow()
        : i;
      await inventoryUpdated(scope, m.orgId, [row.id], 'updated');
      await this.quality.refreshVendor(scope, m.orgId);
      return this.views.one(scope, row);
    });
    return { body };
  }
}

@Injectable()
@Operation('inventory.delete')
export class InventoryDeleteHandler implements OperationHandler {
  constructor(private readonly quality: CatalogQuality) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    await ctx.tx(async (scope) => {
      const i = await loadItem(scope, m, ctx.params.item_id!, true);
      // Removed items leave public search at once (inventory.updated) and free their SKU.
      await scope.db.updateTable('inventory.inventory_items').set({ status: 'removed' }).where('id', '=', i.id).execute();
      await writeAudit(scope, { action: 'inventory.item_removed', entityType: 'inventory_item', entityId: i.id, previous: i.status });
      await inventoryUpdated(scope, m.orgId, [i.id], 'removed');
      await this.quality.refreshVendor(scope, m.orgId);
    });
    return { body: ACK };
  }
}

type BulkPatch = { stock_status?: string; visibility?: string; status?: 'active' | 'hidden' | 'discontinued'; price_on_request?: boolean };

@Injectable()
@Operation('inventory.bulk_update')
export class InventoryBulkUpdateHandler implements OperationHandler {
  constructor(private readonly jobs: JobService) {}

  async handle(ctx: OperationContext<{ item_ids: string[]; patch: BulkPatch }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    if (Object.keys(b.patch).length === 0) failIf([{ pointer: '/patch', code: 'too_short', limit: '1' }]);
    const row = await ctx.tx((scope) =>
      this.jobs.create(scope, {
        kind: 'bulk_inventory_update',
        ownerUserId: m.userId,
        organizationId: m.orgId,
        owningModule: 'inventory',
        // Item ids and the patch are not personal data; the worker reads them from the durable job row.
        inputSummary: { item_ids: b.item_ids, patch: b.patch },
        queue: BULK_QUEUE,
      }),
    );
    return acceptedJob(row);
  }
}

@Injectable()
@Operation('inventory.duplicate_mark')
export class InventoryDuplicateMarkHandler implements OperationHandler {
  constructor(private readonly views: ItemViews) {}

  async handle(ctx: OperationContext<{ duplicate_of_item_id: string | null }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const target = ctx.body.duplicate_of_item_id;
    const body = await ctx.tx(async (scope) => {
      const i = await loadItem(scope, m, ctx.params.item_id!, true);
      if (target !== null) {
        // Another of the vendor's own items (52 InventoryItem.duplicate_of_item_id; AI never sees other vendors' data).
        const t = target === i.id ? null : await loadItem(scope, m, target).catch(() => null);
        if (!t) throw notFoundAt('/duplicate_of_item_id');
      }
      const row = await scope.db
        .updateTable('inventory.inventory_items')
        .set({ duplicate_of_item_id: target })
        .where('id', '=', i.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.views.one(scope, row);
    });
    return { body };
  }
}
