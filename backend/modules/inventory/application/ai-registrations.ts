// The inventory module's parts of the AI facade (S9; 40 ai.inventory_normalize,
// ai.fitment_suggest, ai.inventory_gaps): context packages of the vendor's own
// items only (never another vendor's data, SEC-AI-4), the sink that stores AI
// fitment as source ai_suggested rows waiting for fitment.decide (status
// pending_vendor_confirmation: not shown, not searched), and the applier of
// an accepted normalization suggestion.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AiContextSources, SuggestionAppliers } from '#modules/ai-mcp/interface/ai.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { inventoryUpdated } from './common.js';

const first = (t: unknown): string | null => {
  const m = (t ?? {}) as Record<string, string>;
  return m.en ?? Object.values(m)[0] ?? null;
};

type FitmentRow = {
  brand_node_id: string;
  model_node_id: string | null;
  year_start: number | null;
  year_end: number | null;
  confidence: string;
};

@Injectable()
export class InventoryAiRegistrations implements OnModuleInit {
  constructor(
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyResolver,
    @Optional() private readonly sources?: AiContextSources,
    @Optional() private readonly appliers?: SuggestionAppliers,
  ) {}

  #items(scope: TxScope, orgId: string) {
    return scope.db
      .selectFrom('inventory.inventory_items')
      .select(['id', 'name_translations', 'description_translations', 'part_category_node_id', 'warranty_note', 'brand'])
      .where('vendor_organization_id', '=', orgId)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null);
  }

  onModuleInit(): void {
    this.sources?.register('vendor.items', async (scope, who, args) => {
      if (!who.orgId) return null;
      let rows;
      if (Array.isArray(args.item_ids)) {
        const ids = [...new Set(args.item_ids as string[])].slice(0, 500);
        rows = ids.length ? await this.#items(scope, who.orgId).where('id', 'in', ids).execute() : [];
        if (rows.length !== ids.length) return null;
      } else if (typeof args.import_batch_id === 'string') {
        const batch = await scope.db
          .selectFrom('inventory.inventory_import_batches')
          .select('id')
          .where('id', '=', args.import_batch_id)
          .where('vendor_organization_id', '=', who.orgId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!batch) return null;
        rows = await this.#items(scope, who.orgId).where('import_batch_id', '=', batch.id).orderBy('id').limit(500).execute();
      } else return null;
      const images = await this.media.imageCounts(
        scope,
        'inventory_item',
        rows.map((r) => r.id),
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: first(r.name_translations),
          part_category_node_id: r.part_category_node_id,
          image_count: images.get(r.id) ?? 0,
          warranty_info: r.warranty_note,
        })),
      };
    });

    this.sources?.register('vendor.item', async (scope, who, args) => {
      if (!who.orgId || typeof args.item_id !== 'string') return null;
      const r = await this.#items(scope, who.orgId).where('id', '=', args.item_id).executeTakeFirst();
      if (!r) return null;
      return {
        id: r.id,
        name: first(r.name_translations),
        description: first(r.description_translations),
        brand: r.brand,
        part_category_node_id: r.part_category_node_id,
      };
    });

    this.sources?.register('vendor.catalog', async (scope, who) => {
      if (!who.orgId) return null;
      const rows = await scope.db
        .selectFrom('inventory.inventory_items')
        .select('part_category_node_id')
        .distinct()
        .where('vendor_organization_id', '=', who.orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .execute();
      return { vendor_category_node_ids: rows.map((r) => r.part_category_node_id) };
    });

    this.sources?.registerSink('vendor.fitment_suggestions', async (scope, who, insightId, payload, subject) => {
      if (!who.orgId || subject.type !== 'inventory_item') return 0;
      const item = await this.#items(scope, who.orgId).where('id', '=', subject.id).executeTakeFirst();
      if (!item) return 0;
      const existing = await scope.db
        .selectFrom('inventory.inventory_fitment')
        .select(['brand_node_id', 'model_node_id'])
        .where('inventory_item_id', '=', item.id)
        .where('status', '<>', 'rejected')
        .where('deleted_at', 'is', null)
        .execute();
      const seen = new Set(existing.map((e) => `${e.brand_node_id}|${e.model_node_id ?? ''}`));
      const rows = ((payload.rows as FitmentRow[] | undefined) ?? []).filter(
        (r) => !seen.has(`${r.brand_node_id}|${r.model_node_id ?? ''}`),
      );
      if (rows.length === 0) return 0;
      await scope.db
        .insertInto('inventory.inventory_fitment')
        .values(
          rows.map((r) => ({
            inventory_item_id: item.id,
            brand_node_id: r.brand_node_id,
            model_node_id: r.model_node_id,
            year_start: r.year_start,
            year_end: r.year_end,
            confidence: r.confidence,
            source: 'ai_suggested',
            ai_insight_id: insightId,
            status: 'pending_vendor_confirmation',
          })),
        )
        .execute();
      return rows.length;
    });

    this.appliers?.register('inventory_item', async (scope, s) => {
      if (!s.organizationId) throw new ApiError('NOT_FOUND');
      const item = await this.#items(scope, s.organizationId).where('id', '=', s.targetId).executeTakeFirst();
      if (!item) throw new ApiError('NOT_FOUND');
      const p = s.payload as { normalized_name?: string; part_category_node_id?: string };
      if (p.part_category_node_id)
        await this.taxonomy.require(p.part_category_node_id, ['part_category'], '/edited_payload/part_category_node_id');
      const set = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) return;
      await scope.db.updateTable('inventory.inventory_items').set(set).where('id', '=', item.id).execute();
      await inventoryUpdated(scope, s.organizationId, [item.id], 'ai_normalization');
    });
  }
}
