// inventory module (41 §2.1 M6; 40 §13). Three Nest modules share this folder:
//   InventoryModule        (global, every deployable) InventoryRead for other
//                          modules (service records now, discovery in S6),
//                          the W7 import and bulk-update logic, catalog
//                          quality, and the registrations: billing
//                          UsageCounters max_inventory_items; organization
//                          item counter (vendor.publish) and vendor insight
//                          sources; media target 'inventory_item'; identity
//                          ConsentScopes 'stock_inquiry'.
//   InventoryApiModule     §13 operations on the api host (inventory-api.module.ts)
//   InventoryWorkerModule  W15 rules on the worker (inventory-worker.module.ts)
// The W7 queues run in workers/import-jobs.
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { UsageCounters } from '#modules/billing/interface/billing.js';
import { ConsentScopes } from '#modules/identity/interface/identity.js';
import { AttachmentTargets, MediaService } from '#modules/media/interface/media.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { CatalogQuality, ItemReferences } from './application/common.js';
import { InventoryBulkUpdater, InventoryImporter } from './application/importer.js';
import { rateString } from './domain/rules.js';
import { DbInventoryRead } from './infrastructure/inventory-read.js';
import { InventoryRead } from './interface/inventory.js';
import { InventoryAdminRegistrations } from './application/admin-registrations.js';
import { InventoryAiRegistrations } from './application/ai-registrations.js';

export { InventoryBulkUpdater, InventoryImporter } from './application/importer.js';
export { IMPORT_QUEUE } from './application/import-ops.js';
export { BULK_QUEUE } from './application/item-ops.js';

async function activeItemIds(scope: TxScope, vendorOrgId: string): Promise<string[]> {
  const rows = await scope.db
    .selectFrom('inventory.inventory_items')
    .select('id')
    .where('vendor_organization_id', '=', vendorOrgId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .execute();
  return rows.map((r) => r.id);
}

async function countActive(scope: TxScope, vendorOrgId: string): Promise<number> {
  const row = await scope.db
    .selectFrom('inventory.inventory_items')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('vendor_organization_id', '=', vendorOrgId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

@Injectable()
export class InventoryRegistrations implements OnModuleInit {
  constructor(
    private readonly quality: CatalogQuality,
    private readonly media: MediaService,
    @Optional() private readonly counters?: UsageCounters,
    @Optional() private readonly ext?: OrganizationExtensions,
    @Optional() private readonly targets?: AttachmentTargets,
    @Optional() private readonly scopes?: ConsentScopes,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
  ) {}

  onModuleInit(): void {
    // admin.taxonomy_merge (S8): item categories follow a merged node.
    this.taxonomyRefs?.register('inventory', (scope, from, into) =>
      repointColumns(scope, [['inventory.inventory_items', 'part_category_node_id']], from, into),
    );
    // 52 InventoryItem: active items count toward max_inventory_items (read after the subscriber lock).
    this.counters?.register('max_inventory_items', (scope, s) =>
      s.type === 'organization' ? countActive(scope, s.id) : Promise.resolve(0),
    );
    // 52 §21 vendor publish rule: ≥ 1 active item (or "catalog coming soon").
    this.ext?.registerItemCounter(countActive);
    this.ext?.registerInsight(
      'vendor.inquiries_received',
      async (scope, orgId, period) => (await this.quality.inquiryFigures(scope, orgId, period)).received,
    );
    this.ext?.registerInsight('vendor.inquiry_fulfillment_rate', async (scope, orgId, period) =>
      rateString((await this.quality.inquiryFigures(scope, orgId, period)).rate),
    );
    this.ext?.registerInsight('vendor.items_missing_fitment', async (scope, orgId) => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM inventory.inventory_items i
         WHERE i.vendor_organization_id = ${orgId}::uuid AND i.status = 'active' AND i.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM inventory.inventory_fitment f
                            WHERE f.inventory_item_id = i.id AND f.status = 'active' AND f.deleted_at IS NULL)`.execute(scope.db);
      return Number(rows[0]?.n ?? 0);
    });
    this.ext?.registerInsight('vendor.items_missing_images', async (scope, orgId) => {
      const ids = await activeItemIds(scope, orgId);
      const images = await this.media.imageCounts(scope, 'inventory_item', ids);
      return ids.filter((id) => (images.get(id) ?? 0) === 0).length;
    });
    // Item images and documents belong to the vendor; any vendor member (V*) attaches them.
    this.targets?.register('inventory_item', async (scope, id) => {
      const i = await scope.db
        .selectFrom('inventory.inventory_items')
        .select('vendor_organization_id')
        .where('id', '=', id)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return i ? { owner: { type: 'organization', id: i.vendor_organization_id }, groups: ['V*'] } : null;
    });
    // A consent scoped to an inquiry is granted only by its requester (SEC-AZ-4).
    this.scopes?.register('stock_inquiry', async (scope, userId, id) => {
      const q = await scope.db
        .selectFrom('inventory.stock_inquiries')
        .select('id')
        .where('id', '=', id)
        .where('requester_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!q;
    });
  }
}

@Global()
@Module({
  providers: [
    InventoryAdminRegistrations,
    { provide: InventoryRead, useClass: DbInventoryRead },
    CatalogQuality,
    ItemReferences,
    InventoryImporter,
    InventoryBulkUpdater,
    InventoryRegistrations,
    InventoryAiRegistrations,
  ],
  exports: [InventoryRead, CatalogQuality, ItemReferences, InventoryImporter, InventoryBulkUpdater],
})
export class InventoryModule {}
