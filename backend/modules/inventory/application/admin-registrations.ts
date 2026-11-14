// Inventory's plug-ins for the admin plane (S8): moderation targets for items
// (counterfeit, misleading listings: hidden or removed, restored) and fitment
// rows (inaccurate fitment: rejected), with inventory.updated so the search
// index follows; and its part of data subject requests (the user's stock
// inquiries are exported; they stay with the vendor as business records).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { excerpt, ModerationTargets, type ContentAction } from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { inventoryUpdated } from './common.js';

/** The listing name in the caller's language, else any language it has (CaseTargetSummary.excerpt, S18). */
function listingName(t: unknown, locale: string): string | null {
  const names = (t ?? {}) as Record<string, string>;
  return excerpt(names[locale] ?? Object.values(names)[0]);
}

async function applyToItem(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const i = await scope.db
    .selectFrom('inventory.inventory_items')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!i) return false;
  const next: Record<ContentAction, string | null> = {
    approve: i.status === 'pending_review' ? 'active' : null,
    hide: ['active', 'pending_review', 'draft'].includes(i.status) ? 'hidden' : null,
    remove: i.status !== 'removed' ? 'removed' : null,
    restore: ['hidden', 'removed'].includes(i.status) ? 'active' : null,
    request_changes: ['active', 'pending_review'].includes(i.status) ? 'draft' : null,
  };
  const status = next[action];
  if (!status) return false;
  await scope.db.updateTable('inventory.inventory_items').set({ status }).where('id', '=', i.id).execute();
  await inventoryUpdated(scope, i.vendor_organization_id, [i.id], action === 'remove' ? 'removed' : 'updated');
  return true;
}

async function applyToFitment(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const f = await scope.db
    .selectFrom('inventory.inventory_fitment as f')
    .innerJoin('inventory.inventory_items as i', 'i.id', 'f.inventory_item_id')
    .select(['f.id', 'f.status', 'f.inventory_item_id', 'i.vendor_organization_id'])
    .where('f.id', '=', id)
    .where('f.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!f) return false;
  const status =
    action === 'hide' || action === 'remove'
      ? f.status !== 'rejected'
        ? 'rejected'
        : null
      : action === 'restore' && f.status === 'rejected'
        ? 'active'
        : null;
  if (!status) return false;
  await scope.db.updateTable('inventory.inventory_fitment').set({ status }).where('id', '=', f.id).execute();
  await inventoryUpdated(scope, f.vendor_organization_id, [f.inventory_item_id], 'fitment');
  return true;
}

@Injectable()
export class InventoryAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
    this.targets?.register('inventory_item', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('inventory.inventory_items')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const i = await scope.db.selectFrom('inventory.inventory_items').selectAll().where('id', '=', id).executeTakeFirst();
        return i
          ? {
              type: 'inventory_item',
              id: i.id,
              available: true,
              vendor_organization_id: i.vendor_organization_id,
              sku: i.sku,
              name_translations: i.name_translations,
              status: i.status,
              visibility: i.visibility,
              created_at: i.created_at.toISOString(),
            }
          : null;
      },
      summaries: async (scope, ids, locale) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('inventory.inventory_items')
              .select(['id', 'name_translations'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: listingName(r.name_translations, locale), rating: null }]));
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('inventory.inventory_items').select('vendor_organization_id').where('id', '=', id).executeTakeFirst())
          ?.vendor_organization_id ?? null,
      apply: applyToItem,
    });
    this.targets?.register('inventory_fitment', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('inventory.inventory_fitment')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const f = await scope.db
          .selectFrom('inventory.inventory_fitment as f')
          .innerJoin('inventory.inventory_items as i', 'i.id', 'f.inventory_item_id')
          .selectAll('f')
          .select(['i.sku', 'i.name_translations', 'i.status as item_status'])
          .where('f.id', '=', id)
          .executeTakeFirst();
        return f
          ? {
              type: 'inventory_fitment',
              id: f.id,
              available: true,
              inventory_item_id: f.inventory_item_id,
              // S18 (BR-33): the listing the row belongs to (A-INV-01 "item as published").
              listing: { sku: f.sku, name_translations: f.name_translations, status: f.item_status },
              brand_node_id: f.brand_node_id,
              model_node_id: f.model_node_id,
              series_node_id: f.series_node_id,
              year_start: f.year_start,
              year_end: f.year_end,
              confidence: f.confidence,
              source: f.source,
              status: f.status,
            }
          : null;
      },
      // S18 (BR-27): the listing's name.
      summaries: async (scope, ids, locale) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('inventory.inventory_fitment as f')
              .innerJoin('inventory.inventory_items as i', 'i.id', 'f.inventory_item_id')
              .select(['f.id', 'i.name_translations'])
              .where('f.id', 'in', [...ids])
              .where('f.deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: listingName(r.name_translations, locale), rating: null }]));
      },
      subjectOrganization: async (scope, id) =>
        (
          await scope.db
            .selectFrom('inventory.inventory_fitment as f')
            .innerJoin('inventory.inventory_items as i', 'i.id', 'f.inventory_item_id')
            .select('i.vendor_organization_id')
            .where('f.id', '=', id)
            .executeTakeFirst()
        )?.vendor_organization_id ?? null,
      apply: applyToFitment,
    });
    this.personal?.register('inventory', {
      async export(scope, userId) {
        const rows = await scope.db
          .selectFrom('inventory.stock_inquiries')
          .select(['id', 'vendor_organization_id', 'inventory_item_id', 'quantity', 'status', 'created_at'])
          .where('requester_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        return [
          {
            section: 'stock_inquiries',
            records: rows.map((r) => ({
              id: r.id,
              fields: {
                vendor_organization_id: r.vendor_organization_id,
                inventory_item_id: r.inventory_item_id,
                quantity: r.quantity,
                status: r.status,
                created_at: r.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      // The consent-gated vehicle snapshot leaves the vendor's copy (the consent is withdrawn by identity).
      async erase(scope, userId) {
        const r = await scope.db
          .updateTable('inventory.stock_inquiries')
          .set({ vehicle_context_snapshot: null })
          .where('requester_user_id', '=', userId)
          .where('vehicle_context_snapshot', 'is not', null)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
    });
  }
}
