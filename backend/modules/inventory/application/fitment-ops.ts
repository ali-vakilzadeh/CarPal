// Fitment (40 §13.2, 52 InventoryFitment, 54 §7.1): fitment.list / create /
// update / delete / decide. Vendor-entered rows are source manual and
// active; "confirmed" records the vendor's own confirmation (confirmed_by).
// AI suggestions (S9) arrive as ai_suggested + pending_vendor_confirmation
// and only fitment.decide confirms them.
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldErrorCode } from '#libs/contract/index.js';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toFitment, type FitmentRow } from '../api/projections.js';
import { loadItem } from './item-ops.js';
import { afterId, CatalogQuality, checkVersion, failIf, inventoryUpdated, pageOf, vendorMember, type VendorMember } from './common.js';

type FitmentWrite = {
  brand_node_id: string;
  model_node_id?: string;
  series_node_id?: string;
  year_start?: number;
  year_end?: number;
  engine_type_node_id?: string;
  fuel_type_node_id?: string;
  notes?: string;
  confidence: 'confirmed' | 'likely' | 'uncertain';
};

/** A row problem as a FieldErrorCode (skipped rows of fitment.create, field errors elsewhere). */
async function rowProblem(taxonomy: TaxonomyResolver, f: Partial<FitmentWrite>): Promise<{ pointer: string; code: FieldErrorCode } | null> {
  if (f.series_node_id && !f.model_node_id) return { pointer: '/model_node_id', code: 'conditional_required' };
  if (f.year_start !== undefined && f.year_end !== undefined && f.year_end < f.year_start) return { pointer: '/year_end', code: 'order' };
  // 52: model under the brand, series under the model.
  for (const [child, parent, pointer] of [
    [f.model_node_id, f.brand_node_id, '/model_node_id'],
    [f.series_node_id, f.model_node_id, '/series_node_id'],
  ] as const) {
    if (!child || !parent) continue;
    try {
      await taxonomy.requireDescendant(child, parent, pointer);
    } catch (err) {
      if (err instanceof ApiError) return { pointer, code: 'reference_not_found' };
      throw err;
    }
  }
  return null;
}

async function loadFitment(scope: TxScope, itemId: string, fitmentId: string, lock = false): Promise<FitmentRow> {
  const q = scope.db
    .selectFrom('inventory.inventory_fitment')
    .selectAll()
    .where('id', '=', fitmentId)
    .where('inventory_item_id', '=', itemId)
    .where('status', '<>', 'inactive')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

const same = (a: Partial<FitmentWrite>, r: FitmentRow): boolean =>
  a.brand_node_id === r.brand_node_id &&
  (a.model_node_id ?? null) === r.model_node_id &&
  (a.series_node_id ?? null) === r.series_node_id &&
  (a.year_start ?? null) === r.year_start &&
  (a.year_end ?? null) === r.year_end &&
  (a.engine_type_node_id ?? null) === r.engine_type_node_id &&
  (a.fuel_type_node_id ?? null) === r.fuel_type_node_id;

/** Fitment changes move the catalog figures (54 §7.2 fitment coverage). */
async function fitmentChanged(scope: TxScope, quality: CatalogQuality, m: VendorMember, itemId: string, change: string) {
  await inventoryUpdated(scope, m.orgId, [itemId], change);
  await quality.refreshVendor(scope, m.orgId);
}

@Injectable()
@Operation('fitment.list')
export class FitmentListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      async (scope) => {
        const item = await loadItem(scope, m, ctx.params.item_id!);
        let q = scope.db
          .selectFrom('inventory.inventory_fitment')
          .selectAll()
          .where('inventory_item_id', '=', item.id)
          .where('deleted_at', 'is', null);
        q = ctx.query.status ? q.where('status', '=', ctx.query.status) : q.where('status', '<>', 'inactive');
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toFitment) };
  }
}

@Injectable()
@Operation('fitment.create')
export class FitmentCreateHandler implements OperationHandler {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly quality: CatalogQuality,
  ) {}

  async handle(ctx: OperationContext<{ items: FitmentWrite[] }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const items = ctx.body.items;
    // Node types of every row were checked by the pipeline (GD-17); chains and duplicates are skipped per row.
    const problems = await Promise.all(items.map((f) => rowProblem(this.taxonomy, f)));
    const body = await ctx.tx(async (scope) => {
      const item = await loadItem(scope, m, ctx.params.item_id!, true);
      const existing = await scope.db
        .selectFrom('inventory.inventory_fitment')
        .selectAll()
        .where('inventory_item_id', '=', item.id)
        .where('status', 'in', ['active', 'pending_vendor_confirmation'])
        .where('deleted_at', 'is', null)
        .execute();
      const created: FitmentRow[] = [];
      const skipped: { index: number; code: FieldErrorCode }[] = [];
      for (const [index, f] of items.entries()) {
        const problem = problems[index];
        if (problem) {
          skipped.push({ index, code: problem.code });
          continue;
        }
        if ([...existing, ...created].some((r) => same(f, r))) {
          skipped.push({ index, code: 'not_unique' });
          continue;
        }
        created.push(
          await scope.db
            .insertInto('inventory.inventory_fitment')
            .values({
              inventory_item_id: item.id,
              brand_node_id: f.brand_node_id,
              model_node_id: f.model_node_id ?? null,
              series_node_id: f.series_node_id ?? null,
              year_start: f.year_start ?? null,
              year_end: f.year_end ?? null,
              engine_type_node_id: f.engine_type_node_id ?? null,
              fuel_type_node_id: f.fuel_type_node_id ?? null,
              notes: f.notes ?? null,
              confidence: f.confidence,
              source: 'manual',
              // "confirmed" requires the vendor's own confirmation, which this operation records (40 fitment.create).
              confirmed_by: f.confidence === 'confirmed' ? m.userId : null,
              status: 'active',
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
      if (created.length) await fitmentChanged(scope, this.quality, m, item.id, 'fitment');
      return { created: created.map(toFitment), skipped };
    });
    return { body };
  }
}

@Injectable()
@Operation('fitment.update')
export class FitmentUpdateHandler implements OperationHandler {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly quality: CatalogQuality,
  ) {}

  async handle(ctx: OperationContext<Partial<FitmentWrite>>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const item = await loadItem(scope, m, ctx.params.item_id!);
      const f = await loadFitment(scope, item.id, ctx.params.fitment_id!, true);
      checkVersion(f.version, ctx.ifMatch);
      const merged: Partial<FitmentWrite> = {
        brand_node_id: b.brand_node_id ?? f.brand_node_id,
        ...((b.model_node_id ?? f.model_node_id) ? { model_node_id: (b.model_node_id ?? f.model_node_id)! } : {}),
        ...((b.series_node_id ?? f.series_node_id) ? { series_node_id: (b.series_node_id ?? f.series_node_id)! } : {}),
        ...((b.year_start ?? f.year_start) !== null ? { year_start: (b.year_start ?? f.year_start)! } : {}),
        ...((b.year_end ?? f.year_end) !== null ? { year_end: (b.year_end ?? f.year_end)! } : {}),
      };
      const problem = await rowProblem(this.taxonomy, merged);
      if (problem) {
        if (problem.code === 'reference_not_found')
          throw new ApiError('TAXONOMY_MISMATCH', { errors: [{ pointer: problem.pointer, code: 'reference_not_found' }] });
        failIf([problem]);
      }
      const confirming = b.confidence === 'confirmed' && f.confidence !== 'confirmed';
      const updated = await scope.db
        .updateTable('inventory.inventory_fitment')
        .set({
          ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
          ...(confirming ? { confirmed_by: m.userId } : {}),
          ...(b.confidence && b.confidence !== 'confirmed' ? { confirmed_by: null } : {}),
        })
        .where('id', '=', f.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await fitmentChanged(scope, this.quality, m, item.id, 'fitment');
      return updated;
    });
    return { body: toFitment(row) };
  }
}

@Injectable()
@Operation('fitment.delete')
export class FitmentDeleteHandler implements OperationHandler {
  constructor(private readonly quality: CatalogQuality) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    await ctx.tx(async (scope) => {
      const item = await loadItem(scope, m, ctx.params.item_id!);
      const f = await loadFitment(scope, item.id, ctx.params.fitment_id!, true);
      await scope.db.updateTable('inventory.inventory_fitment').set({ status: 'inactive' }).where('id', '=', f.id).execute();
      await fitmentChanged(scope, this.quality, m, item.id, 'fitment');
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('fitment.decide')
export class FitmentDecideHandler implements OperationHandler {
  constructor(private readonly quality: CatalogQuality) {}

  async handle(ctx: OperationContext<{ decision: 'confirm' | 'reject' }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const row = await ctx.tx(async (scope) => {
      const item = await loadItem(scope, m, ctx.params.item_id!);
      const f = await loadFitment(scope, item.id, ctx.params.fitment_id!, true);
      if (f.status !== 'pending_vendor_confirmation') throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
      const confirm = ctx.body.decision === 'confirm';
      // 52: only the vendor's confirmation sets "confirmed".
      const updated = await scope.db
        .updateTable('inventory.inventory_fitment')
        .set(confirm ? { status: 'active', confidence: 'confirmed', confirmed_by: m.userId } : { status: 'rejected' })
        .where('id', '=', f.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: confirm ? 'inventory.fitment_confirmed' : 'inventory.fitment_rejected',
        entityType: 'inventory_fitment',
        entityId: f.id,
        previous: `${f.source}:${f.confidence}`,
      });
      await fitmentChanged(scope, this.quality, m, item.id, 'fitment');
      return updated;
    });
    return { body: toFitment(row) };
  }
}
