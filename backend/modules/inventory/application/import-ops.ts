// CSV inventory imports (40 §13.2, 52 InventoryImportBatch, Plan WP7):
// inventory.import_create (ASYNC: a batch row and a 202 Job; W7 runs it,
// importer.ts) / imports_list / import_get / import_error_report. Needs the
// inventory_bulk_import_enabled entitlement and a clean text/csv upload of
// the vendor (purpose inventory_import_csv).
import { Injectable } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { acceptedJob, JobService } from '#libs/jobs/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { toImportBatch, type BatchRow } from '../api/projections.js';
import { isImportField } from '../domain/import-row.js';
import { afterId, failIf, json, pageOf, vendorMember, type VendorMember } from './common.js';

export const IMPORT_QUEUE = 'inventory.import';

type ImportCreate = {
  source_media_asset_id: string;
  column_mapping: { column: string; field: string }[];
  ai_normalization_requested: boolean;
};

/** Mapping rules: known fields, each field and column once, and the SKU (rows are matched to items by SKU). */
function mappingErrors(mapping: ImportCreate['column_mapping']): FieldError[] {
  const errors: FieldError[] = [];
  const fields = new Set<string>();
  const columns = new Set<string>();
  for (const [i, m] of mapping.entries()) {
    if (!isImportField(m.field)) errors.push({ pointer: `/column_mapping/${i}/field`, code: 'enum' });
    else if (fields.has(m.field)) errors.push({ pointer: `/column_mapping/${i}/field`, code: 'not_unique' });
    if (columns.has(m.column)) errors.push({ pointer: `/column_mapping/${i}/column`, code: 'not_unique' });
    fields.add(m.field);
    columns.add(m.column);
  }
  if (!fields.has('sku')) errors.push({ pointer: '/column_mapping', code: 'conditional_required' });
  return errors;
}

async function loadBatch(scope: TxScope, m: VendorMember, batchId: string): Promise<BatchRow> {
  const row = await scope.db
    .selectFrom('inventory.inventory_import_batches')
    .selectAll()
    .where('id', '=', batchId)
    .where('vendor_organization_id', '=', m.orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('inventory.import_create')
export class InventoryImportCreateHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly media: MediaService,
    private readonly jobs: JobService,
  ) {}

  async handle(ctx: OperationContext<ImportCreate>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    failIf(mappingErrors(b.column_mapping));
    const job = await ctx.tx(async (scope) => {
      await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'inventory_bulk_import_enabled', 0);
      // The vendor's own CSV upload, scanned clean (409 MEDIA_NOT_READY before the scan).
      await this.media.requireReady(scope, [b.source_media_asset_id], {
        owner: { type: 'organization', id: m.orgId },
        purposes: ['inventory_import_csv'],
        pointer: '/source_media_asset_id',
      });
      const batch = await scope.db
        .insertInto('inventory.inventory_import_batches')
        .values({
          vendor_organization_id: m.orgId,
          source_media_asset_id: b.source_media_asset_id,
          column_mapping: json(b.column_mapping)!,
          // Recorded for the AI normalization of imported rows (S9); rows are imported by rules now.
          ai_normalization_requested: b.ai_normalization_requested,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.jobs.create(scope, {
        kind: 'inventory_import',
        ownerUserId: m.userId,
        organizationId: m.orgId,
        owningModule: 'inventory',
        inputSummary: { batch_id: batch.id, columns: b.column_mapping.length },
        queue: IMPORT_QUEUE,
      });
    });
    return acceptedJob(job);
  }
}

@Injectable()
@Operation('inventory.imports_list')
export class InventoryImportsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('inventory.inventory_import_batches')
          .selectAll()
          .where('vendor_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toImportBatch) };
  }
}

@Injectable()
@Operation('inventory.import_get')
export class InventoryImportGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const row = await ctx.tx((scope) => loadBatch(scope, m, ctx.params.batch_id!), { readOnly: true });
    return { body: toImportBatch(row) };
  }
}

@Injectable()
@Operation('inventory.import_error_report')
export class InventoryImportErrorReportHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const batch = await loadBatch(scope, m, ctx.params.batch_id!);
      if (!batch.error_report_media_asset_id) throw new ApiError('NOT_FOUND', { detail: 'no_errors' });
      // 5-minute attachment URL of the formula-safe CSV (SEC-IN-11, SEC-UP-4).
      const signed = await this.media.signedDownload(scope, batch.error_report_media_asset_id);
      if (!signed) throw new ApiError('NOT_FOUND', { detail: 'no_errors' });
      return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
    });
    return { body };
  }
}
