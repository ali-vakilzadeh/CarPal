// W7 import-jobs (41 §2.4) for inventory: CSV imports and bulk updates, run
// by the worker deployable in the system context, always restricted to the
// job's vendor organization. Imports parse the file as data only (SEC-IN-11:
// strict RFC 4180, ≤ 20 MB, ≤ 20,000 rows, ≤ 64 columns, cells ≤ 2,000
// characters), validate every row like an API body, upsert items by SKU,
// keep going past bad rows and write a formula-safe CSV of row errors.
// vendor.inventory.imported is published when a batch finishes.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, isApiError } from '#libs/contract/index.js';
import { CsvError, parseCsv, writeCsv } from '#libs/csv/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { ContractValidator, normalizeString } from '#libs/http-pipeline/index.js';
import type { JobContext, JobOutcome } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgLocations } from '#modules/organization/interface/vendor-catalog.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import type { BatchRow, ItemRow } from '../api/projections.js';
import { isImportField, NEW_ITEM_DEFAULTS, rowToItem, type ImportField, type MappedColumn } from '../domain/import-row.js';
import {
  activating,
  CatalogQuality,
  inventoryUpdated,
  itemAsWrite,
  itemColumns,
  itemFieldErrors,
  normalizedName,
  type InventoryItemWrite,
} from './common.js';

/** Rows per transaction (one savepoint per row, so a bad row never loses the chunk). */
const CHUNK = 200;

interface RowError {
  line: number;
  pointer: string;
  code: string;
  cells: string[];
}

type Outcome = { kind: 'created' } | { kind: 'updated' } | { kind: 'error'; problems: readonly { pointer: string; code: string }[] };

@Injectable()
export class InventoryImporter {
  readonly #validator = new ContractValidator();

  constructor(
    private readonly tx: TxRunner,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyResolver,
    private readonly locations: OrgLocations,
    private readonly entitlements: EntitlementChecker,
    private readonly quality: CatalogQuality,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const summary = (ctx.job.input_summary ?? {}) as { batch_id?: string };
    const orgId = ctx.job.organization_id;
    if (!summary.batch_id || !orgId) return { errorCode: 'INTERNAL' };
    const system = { actorType: 'system' as const };
    const batch = await this.tx.run(system, (s) =>
      s.db
        .updateTable('inventory.inventory_import_batches')
        .set({ status: 'validating', started_at: new Date() })
        .where('id', '=', summary.batch_id!)
        .where('vendor_organization_id', '=', orgId)
        .where('status', '=', 'uploaded')
        .returningAll()
        .executeTakeFirst(),
    );
    if (!batch) return { errorCode: 'INVALID_TRANSITION' };
    const fail = async (code: string): Promise<JobOutcome> => {
      await this.tx.run(system, (s) =>
        s.db
          .updateTable('inventory.inventory_import_batches')
          .set({ status: 'failed', finished_at: new Date() })
          .where('id', '=', batch.id)
          .execute(),
      );
      return { errorCode: code };
    };

    // File level: the clean CSV, its dialect and limits, and every mapped column present.
    const content = await this.tx.run(system, (s) => this.media.readContent(s, batch.source_media_asset_id));
    if (!content || content.mime !== 'text/csv') return fail('MEDIA_NOT_READY');
    let parsed;
    try {
      parsed = parseCsv(content.bytes);
    } catch (err) {
      if (err instanceof CsvError) return fail(err.code === 'too_large' ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED');
      throw err;
    }
    const header = parsed.header.map((h) => h.trim());
    const mapping = batch.column_mapping as { column: string; field: string }[];
    const columns: MappedColumn[] = [];
    for (const m of mapping) {
      const index = header.indexOf(m.column.trim());
      if (index < 0 || !isImportField(m.field)) return fail('VALIDATION_FAILED');
      columns.push({ index, field: m.field as ImportField });
    }

    await this.tx.run(system, (s) =>
      s.db
        .updateTable('inventory.inventory_import_batches')
        .set({ status: 'processing', total_rows: parsed.records.length })
        .where('id', '=', batch.id)
        .execute(),
    );
    let createdCount = 0;
    let updatedCount = 0;
    const errors: RowError[] = [];
    for (let start = 0; start < parsed.records.length; start += CHUNK) {
      if (ctx.signal.aborted) return fail('UNAVAILABLE');
      const chunk = parsed.records.slice(start, start + CHUNK);
      await this.tx.run(system, async (scope) => {
        for (const record of chunk) {
          await sql`SAVEPOINT import_row`.execute(scope.db);
          let outcome: Outcome;
          try {
            outcome = await this.#row(scope, batch, orgId, record.cells, columns, header.length);
            await sql`RELEASE SAVEPOINT import_row`.execute(scope.db);
          } catch (err) {
            await sql`ROLLBACK TO SAVEPOINT import_row`.execute(scope.db);
            const code = isApiError(err) ? err.code : 'INTERNAL';
            outcome = { kind: 'error', problems: isApiError(err) && err.errors?.length ? err.errors : [{ pointer: '/', code }] };
          }
          if (outcome.kind === 'created') createdCount++;
          else if (outcome.kind === 'updated') updatedCount++;
          else if (outcome.kind === 'error')
            for (const p of outcome.problems) errors.push({ line: record.line, pointer: p.pointer, code: p.code, cells: record.cells });
        }
      });
      await ctx.progress(Math.floor((100 * Math.min(parsed.records.length, start + CHUNK)) / Math.max(1, parsed.records.length)));
    }

    const errorRows = new Set(errors.map((e) => e.line)).size;
    await this.tx.run(system, async (scope) => {
      // Formula-safe report (SEC-IN-11): line, field, code, then the row as uploaded.
      const report = errors.length
        ? await this.media.storeGenerated(scope, {
            owner: { type: 'organization', id: orgId },
            uploadedBy: ctx.job.owner_user_id,
            purpose: 'system_export',
            mime: 'text/csv',
            bytes: Buffer.from(
              writeCsv([['line', 'field', 'code', ...header], ...errors.map((e) => [String(e.line), e.pointer, e.code, ...e.cells])]),
            ),
          })
        : null;
      await scope.db
        .updateTable('inventory.inventory_import_batches')
        .set({
          status: errors.length ? 'completed_with_errors' : 'completed',
          created_count: createdCount,
          updated_count: updatedCount,
          error_count: errorRows,
          error_report_media_asset_id: report,
          finished_at: new Date(),
        })
        .where('id', '=', batch.id)
        .execute();
      await this.quality.scoreCatalog(scope, orgId);
      await this.quality.refreshVendor(scope, orgId);
      await publishEvent(scope, {
        type: 'vendor.inventory.imported',
        aggregateType: 'inventory_import_batch',
        aggregateId: batch.id,
        payload: {
          vendor_organization_id: orgId,
          created_count: createdCount,
          updated_count: updatedCount,
          error_count: errorRows,
          ai_normalization_requested: batch.ai_normalization_requested,
        },
      });
    });
    return { result: { type: 'inventory_import_batch', id: batch.id } };
  }

  /** One record: validated like an API body, then created, or merged into the item with the same SKU. */
  async #row(
    scope: TxScope,
    batch: BatchRow,
    orgId: string,
    cells: string[],
    columns: MappedColumn[],
    headerLength: number,
  ): Promise<Outcome> {
    const parsed = rowToItem(cells, columns, headerLength, (v) => normalizeString(v));
    if (parsed.problems.length) return { kind: 'error', problems: parsed.problems };
    const existing = typeof parsed.item.sku === 'string' ? await this.#bySku(scope, orgId, parsed.item.sku) : undefined;
    // An update row changes only the cells it has; a new item gets the 52 defaults.
    const item = existing
      ? Object.fromEntries(Object.entries(parsed.item).filter(([k]) => k !== 'sku'))
      : { ...NEW_ITEM_DEFAULTS, ...parsed.item };
    // The same schemas as inventory.create / inventory.update (closed, typed); then the business rules.
    try {
      this.#validator.validateBody(existing ? 'inventory.update' : 'inventory.create', existing ? 200 : 201, item);
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) return { kind: 'error', problems: err.errors };
      throw err;
    }
    const b = (existing ? { ...item, sku: existing.sku } : item) as unknown as InventoryItemWrite;
    const fieldErrors = itemFieldErrors(existing ? { ...itemAsWrite(existing), ...b } : b);
    if (fieldErrors.length) return { kind: 'error', problems: fieldErrors };
    if (b.part_category_node_id) await this.taxonomy.require(b.part_category_node_id, ['part_category'], '/part_category_node_id');
    if (b.location_id && !(await this.locations.isActive(scope, orgId, b.location_id)))
      return { kind: 'error', problems: [{ pointer: '/location_id', code: 'reference_not_found' }] };
    const subscriber = { type: 'organization' as const, id: orgId };
    if (activating(existing?.status ?? null, b.status))
      await requireEntitlement(this.entitlements, scope, subscriber, 'max_inventory_items', 1);
    else if (!existing) await requireEntitlement(this.entitlements, scope, subscriber, 'max_inventory_items', 0);
    if (existing) {
      const set = itemColumns(b);
      delete set.sku;
      if (b.name_translations) set.normalized_name = normalizedName(b.name_translations);
      await scope.db
        .updateTable('inventory.inventory_items')
        .set({ ...set, import_batch_id: batch.id })
        .where('id', '=', existing.id)
        .execute();
      return { kind: 'updated' };
    }
    await scope.db
      .insertInto('inventory.inventory_items')
      .values({
        ...itemColumns(b),
        vendor_organization_id: orgId,
        sku: b.sku,
        name_translations: JSON.stringify(b.name_translations),
        part_origin: b.part_origin,
        condition: b.condition,
        part_category_node_id: b.part_category_node_id,
        stock_status: b.stock_status,
        normalized_name: normalizedName(b.name_translations),
        status: b.status ?? 'draft',
        import_batch_id: batch.id,
      })
      .execute();
    return { kind: 'created' };
  }

  #bySku(scope: TxScope, orgId: string, sku: string): Promise<ItemRow | undefined> {
    return scope.db
      .selectFrom('inventory.inventory_items')
      .selectAll()
      .where('vendor_organization_id', '=', orgId)
      .where('sku', '=', sku)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }
}

type BulkInput = {
  item_ids?: string[];
  patch?: { stock_status?: string; visibility?: string; status?: string; price_on_request?: boolean };
};

/**
 * inventory.bulk_update (ASYNC): one transaction over up to 500 of the
 * vendor's items. Activations are checked against max_inventory_items
 * together (the job fails with INVENTORY_LIMIT_REACHED and changes
 * nothing); items that are unknown, removed, or would lose their price rule
 * (price_on_request false without a public price) are skipped.
 */
@Injectable()
export class InventoryBulkUpdater {
  constructor(
    private readonly tx: TxRunner,
    private readonly entitlements: EntitlementChecker,
    private readonly quality: CatalogQuality,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const input = (ctx.job.input_summary ?? {}) as BulkInput;
    const orgId = ctx.job.organization_id;
    const ids = input.item_ids ?? [];
    const patch = input.patch ?? {};
    if (!orgId || ids.length === 0) return { errorCode: 'INTERNAL' };
    try {
      await this.tx.run({ actorType: 'system' }, async (scope) => {
        const items = await scope.db
          .selectFrom('inventory.inventory_items')
          .selectAll()
          .where('id', 'in', ids)
          .where('vendor_organization_id', '=', orgId)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null)
          .forUpdate()
          .execute();
        const targets = items.filter((i) => !(patch.price_on_request === false && i.price_public === null));
        const activations = targets.filter((i) => activating(i.status, patch.status)).length;
        if (activations > 0)
          await requireEntitlement(this.entitlements, scope, { type: 'organization', id: orgId }, 'max_inventory_items', activations);
        if (targets.length === 0) return;
        await scope.db
          .updateTable('inventory.inventory_items')
          .set(patch)
          .where(
            'id',
            'in',
            targets.map((t) => t.id),
          )
          .execute();
        await inventoryUpdated(
          scope,
          orgId,
          targets.map((t) => t.id),
          'bulk_update',
        );
        await this.quality.refreshVendor(scope, orgId);
      });
    } catch (err) {
      if (isApiError(err) && err.status < 500) return { errorCode: err.code };
      throw err;
    }
    return { result: null };
  }
}
