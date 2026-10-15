// Fleet reports, exports and imports (40 §18.2 fleet.report, export_create /
// exports_list / export_download, import_create / imports_list /
// import_error_report). Reports need fleet_reports_enabled; exports need
// export_enabled and run in W8 as formula-safe CSV files (SEC-IN-11) stored
// private and encrypted for the fleet, downloadable for 7 days through
// 5-minute signed URLs; vehicle imports run in W7 with the vehicles.create
// rules per row (max_vehicles holds for every created vehicle) and a
// row-error report.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, isApiError, type FieldError } from '#libs/contract/index.js';
import { CsvError, parseCsv, writeCsv } from '#libs/csv/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import {
  ContractValidator,
  NodeTypeChecker,
  normalizeString,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { acceptedJob, JobService, type JobContext, type JobOutcome } from '#libs/jobs/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards, VehicleService } from '#modules/vehicle/interface/vehicles.js';
import { toExport, toImportBatch, type ExportRow } from '../api/projections.js';
import { FleetPartners } from '../interface/fleet.js';
import { afterId, fleetMember, pageOf, vehicleLabels } from './fleet-ops.js';
import { FleetReports, GROUPINGS, type GroupBy, type ReportType } from './reports.js';

export const FLEET_EXPORT_QUEUE = 'fleet.export';
export const FLEET_IMPORT_QUEUE = 'fleet.import';
const EXPORT_TTL_MS = 7 * 86_400_000;

async function reportingCurrency(scope: TxScope, orgId: string): Promise<string | null> {
  const p = await scope.db
    .selectFrom('fleet.fleet_profiles')
    .select('reporting_currency')
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return p?.reporting_currency ?? null;
}

@Injectable()
@Operation('fleet.report')
export class FleetReportHandler implements OperationHandler {
  constructor(
    private readonly reports: FleetReports,
    private readonly entitlements: EntitlementChecker,
    private readonly partners: FleetPartners,
  ) {}

  async handle(ctx: OperationContext<undefined, { from: string; to: string; group_by?: GroupBy }>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const type = ctx.params.report_type as ReportType;
    const groupings = GROUPINGS[type];
    if (!groupings) throw new ApiError('NOT_FOUND');
    const groupBy = ctx.query.group_by ?? groupings[0]!;
    if (!groupings.includes(groupBy)) throw ApiError.validation([{ pointer: '/query/group_by', code: 'enum' }]);
    const body = await ctx.tx(async (scope) => {
      await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'fleet_reports_enabled', 0);
      const currency = type === 'costs' ? await reportingCurrency(scope, m.orgId) : null;
      const preferred =
        type === 'preferred_provider_performance'
          ? (await this.partners.preferredProviders(scope, m.orgId)).map((p) => p.organizationId)
          : [];
      const rows = await this.reports.build(
        scope,
        m.orgId,
        type,
        { from: ctx.query.from, to: ctx.query.to },
        groupBy,
        currency,
        ctx.locale,
        preferred,
      );
      return { report_type: type, from: ctx.query.from, to: ctx.query.to, currency, group_by: groupBy, rows };
    });
    return { body };
  }
}

// ------------------------------------------------------------------ exports

type ExportCreate = {
  export_type: 'cost_report' | 'service_history' | 'vehicle_list' | 'repair_frequency' | 'provider_usage';
  filters?: { from?: string; to?: string; vehicle_ids?: string[]; service_system_node_ids?: string[] };
  format: 'csv';
};

@Injectable()
@Operation('fleet.export_create')
export class FleetExportCreateHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly jobs: JobService,
  ) {}

  async handle(ctx: OperationContext<ExportCreate>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const f = b.filters ?? {};
    if (f.from && f.to && f.to < f.from) throw ApiError.validation([{ pointer: '/filters/to', code: 'order' }]);
    const job = await ctx.tx(async (scope) => {
      await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'export_enabled', 0);
      const row = await scope.db
        .insertInto('fleet.fleet_exports')
        .values({
          fleet_organization_id: m.orgId,
          export_type: b.export_type,
          filters: Object.keys(f).length ? JSON.stringify(f) : null,
          format: 'csv',
          requested_by: m.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const j = await this.jobs.create(scope, {
        kind: 'fleet_export',
        ownerUserId: m.userId,
        organizationId: m.orgId,
        owningModule: 'fleet',
        inputSummary: { export_id: row.id, export_type: b.export_type },
        queue: FLEET_EXPORT_QUEUE,
      });
      await writeAudit(scope, {
        action: 'fleet.export_requested',
        entityType: 'fleet_export',
        entityId: row.id,
        next: `${b.export_type} job ${j.id}`,
      });
      return j;
    });
    return acceptedJob(job);
  }
}

@Injectable()
@Operation('fleet.exports_list')
export class FleetExportsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('fleet.fleet_exports')
          .selectAll()
          .where('fleet_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toExport));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('fleet.export_download')
export class FleetExportDownloadHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const e = (await scope.db
        .selectFrom('fleet.fleet_exports')
        .selectAll()
        .where('id', '=', ctx.params.export_id!)
        .where('fleet_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()) as ExportRow | undefined;
      if (!e) throw new ApiError('NOT_FOUND');
      if (e.status !== 'completed' || !e.file_media_asset_id || (e.expires_at && e.expires_at <= new Date()))
        throw new ApiError('INVALID_TRANSITION', { detail: 'not_completed' });
      const url = await this.media.signedDownload(scope, e.file_media_asset_id);
      if (!url) throw new ApiError('INVALID_TRANSITION', { detail: 'not_completed' });
      await writeAudit(scope, { action: 'fleet.export_downloaded', entityType: 'fleet_export', entityId: e.id, next: e.export_type });
      return { url: url.url, expires_at: url.expiresAt.toISOString() };
    });
    return { body };
  }
}

/** W8 export-jobs: builds the CSV of a fleet export (system context, restricted to the job's fleet). */
@Injectable()
export class FleetExporter {
  constructor(
    private readonly tx: TxRunner,
    private readonly reports: FleetReports,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const exportId = (ctx.job.input_summary as { export_id?: string } | null)?.export_id;
    const orgId = ctx.job.organization_id;
    if (!exportId || !orgId) return { errorCode: 'INTERNAL' };
    const system = { actorType: 'system' as const };
    const e = await this.tx.run(system, (s) =>
      s.db
        .updateTable('fleet.fleet_exports')
        .set({ status: 'processing' })
        .where('id', '=', exportId)
        .where('fleet_organization_id', '=', orgId)
        .where('status', '=', 'queued')
        .returningAll()
        .executeTakeFirst(),
    );
    if (!e) return { errorCode: 'INVALID_TRANSITION' };
    try {
      return await this.tx.run(system, async (scope) => {
        const rows = await this.rows(scope, orgId, e);
        const asset = await this.media.storeGenerated(scope, {
          owner: { type: 'organization', id: orgId },
          uploadedBy: e.requested_by,
          purpose: 'system_export',
          mime: 'text/csv',
          bytes: Buffer.from(writeCsv(rows), 'utf8'),
        });
        await scope.db
          .updateTable('fleet.fleet_exports')
          .set({ status: 'completed', file_media_asset_id: asset, expires_at: new Date(Date.now() + EXPORT_TTL_MS) })
          .where('id', '=', e.id)
          .execute();
        return { result: { type: 'fleet_export' as const, id: e.id } };
      });
    } catch (err) {
      await this.tx.run(system, (s) => s.db.updateTable('fleet.fleet_exports').set({ status: 'failed' }).where('id', '=', e.id).execute());
      return { errorCode: isApiError(err) ? err.code : 'INTERNAL' };
    }
  }

  /** CSV rows of one export (header first). */
  private async rows(scope: TxScope, orgId: string, e: ExportRow): Promise<string[][]> {
    const f = (e.filters as { from?: string; to?: string; vehicle_ids?: string[]; service_system_node_ids?: string[] } | null) ?? {};
    const today = new Date().toISOString().slice(0, 10);
    const from = f.from ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const to = f.to ?? today;
    const locale: Locale = 'en';
    const profile = await scope.db
      .selectFrom('fleet.fleet_profiles')
      .select('reporting_currency')
      .where('organization_id', '=', orgId)
      .executeTakeFirst();
    const currency = profile?.reporting_currency ?? null;
    if (e.export_type === 'vehicle_list') {
      const vehicles = await this.vehicles.fleetVehicles(scope, orgId, f.vehicle_ids);
      const labels = await this.taxonomy.labels(
        vehicles.flatMap((v) => [v.brandNodeId, v.modelNodeId]),
        locale,
      );
      return [
        ['vehicle_id', 'nickname', 'brand', 'model', 'year', 'license_plate', 'vin_last4', 'status', 'mileage_km'],
        ...vehicles.map((v) => [
          v.id,
          v.nickname ?? '',
          labels.get(v.brandNodeId)?.text ?? '',
          labels.get(v.modelNodeId)?.text ?? '',
          String(v.year),
          v.licensePlate ?? '',
          v.vinLast4 ?? '',
          v.status,
          v.mileageKm === null ? '' : String(v.mileageKm),
        ]),
      ];
    }
    if (e.export_type === 'service_history') {
      let records = await this.vehicles.fleetServiceRecords(scope, orgId, from, to, f.vehicle_ids);
      if (f.service_system_node_ids?.length) records = records.filter((r) => f.service_system_node_ids!.includes(r.serviceSystemNodeId));
      const names = await vehicleLabels(this.vehicles, this.taxonomy, scope, orgId, [...new Set(records.map((r) => r.vehicleId))], locale);
      const systems = await this.taxonomy.labels(
        records.flatMap((r) => [r.serviceSystemNodeId, r.serviceTaskNodeId].filter((x): x is string => !!x)),
        locale,
      );
      return [
        [
          'service_record_id',
          'vehicle_id',
          'vehicle',
          'service_date',
          'service_system',
          'service_task',
          'provider_organization_id',
          'cost',
          'currency',
        ],
        ...records.map((r) => [
          r.id,
          r.vehicleId,
          names.get(r.vehicleId) ?? '',
          r.serviceDate,
          systems.get(r.serviceSystemNodeId)?.text ?? '',
          r.serviceTaskNodeId ? (systems.get(r.serviceTaskNodeId)?.text ?? '') : '',
          r.providerOrgId ?? '',
          r.costAmount ?? '',
          r.currency ?? '',
        ]),
      ];
    }
    const type: ReportType =
      e.export_type === 'cost_report' ? 'costs' : e.export_type === 'repair_frequency' ? 'repair_frequency' : 'provider_usage';
    const rows = await this.reports.build(
      scope,
      orgId,
      type,
      { from, to },
      GROUPINGS[type][0]!,
      type === 'costs' ? currency : null,
      locale,
    );
    return [
      ['key', 'label', 'value', 'count', ...(type === 'costs' ? ['currency'] : [])],
      ...rows.map((r) => [r.key, r.label, r.value, String(r.count), ...(type === 'costs' ? [currency ?? ''] : [])]),
    ];
  }
}

// ------------------------------------------------------------------ imports

/** Columns a fleet vehicle import may map (40 VehicleWrite without media and notes kept as text). */
export const IMPORT_FIELDS = [
  'vin',
  'license_plate',
  'nickname',
  'brand_node_id',
  'model_node_id',
  'series_node_id',
  'year',
  'engine_type_node_id',
  'fuel_type_node_id',
  'transmission',
  'drivetrain',
  'body_style',
  'color',
  'mileage_km',
  'ownership_start_date',
  'notes',
] as const;
const INTEGER_FIELDS = new Set(['year', 'mileage_km']);

type ImportCreate = { source_media_asset_id: string; column_mapping: { column: string; field: string }[] };

@Injectable()
@Operation('fleet.import_create')
export class FleetImportCreateHandler implements OperationHandler {
  constructor(
    private readonly media: MediaService,
    private readonly entitlements: EntitlementChecker,
    private readonly jobs: JobService,
  ) {}

  async handle(ctx: OperationContext<ImportCreate>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const errors: FieldError[] = b.column_mapping.flatMap((c, i) =>
      (IMPORT_FIELDS as readonly string[]).includes(c.field) ? [] : [{ pointer: `/column_mapping/${i}/field`, code: 'enum' as const }],
    );
    const fields = b.column_mapping.map((c) => c.field);
    for (const [i, f] of fields.entries())
      if (fields.indexOf(f) !== i) errors.push({ pointer: `/column_mapping/${i}/field`, code: 'not_unique' });
    // A vehicle needs its brand, model and year (40 VehicleWrite).
    for (const required of ['brand_node_id', 'model_node_id', 'year'])
      if (!fields.includes(required)) errors.push({ pointer: '/column_mapping', code: 'conditional_required' });
    if (errors.length) throw ApiError.validation(errors.slice(0, 50));
    const job = await ctx.tx(async (scope) => {
      await this.media.requireReady(scope, [b.source_media_asset_id], {
        owner: { type: 'organization', id: m.orgId },
        purposes: ['fleet_import_csv'],
        pointer: '/source_media_asset_id',
      });
      // ENT(max_vehicles): the fleet's plan allows vehicles at all; every row is checked again when created.
      await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'max_vehicles', 0);
      const batch = await scope.db
        .insertInto('fleet.fleet_import_batches')
        .values({
          fleet_organization_id: m.orgId,
          source_media_asset_id: b.source_media_asset_id,
          column_mapping: JSON.stringify(b.column_mapping),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return this.jobs.create(scope, {
        kind: 'fleet_import',
        ownerUserId: m.userId,
        organizationId: m.orgId,
        owningModule: 'fleet',
        inputSummary: { batch_id: batch.id },
        queue: FLEET_IMPORT_QUEUE,
      });
    });
    return acceptedJob(job);
  }
}

@Injectable()
@Operation('fleet.imports_list')
export class FleetImportsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('fleet.fleet_import_batches')
          .selectAll()
          .where('fleet_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toImportBatch));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('fleet.import_error_report')
export class FleetImportErrorReportHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const b = await scope.db
        .selectFrom('fleet.fleet_import_batches')
        .select(['error_report_media_asset_id'])
        .where('id', '=', ctx.params.batch_id!)
        .where('fleet_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!b?.error_report_media_asset_id) throw new ApiError('NOT_FOUND');
      const url = await this.media.signedDownload(scope, b.error_report_media_asset_id);
      if (!url) throw new ApiError('NOT_FOUND');
      return { url: url.url, expires_at: url.expiresAt.toISOString() };
    });
    return { body };
  }
}

const CHUNK = 200;

/** W7 import-jobs for fleets: one vehicle per row through VehicleService.createFleetVehicle, one savepoint per row. */
@Injectable()
export class FleetImporter {
  readonly #validator = new ContractValidator();

  constructor(
    private readonly tx: TxRunner,
    private readonly media: MediaService,
    private readonly vehicles: VehicleService,
    private readonly nodeTypes: NodeTypeChecker,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const batchId = (ctx.job.input_summary as { batch_id?: string } | null)?.batch_id;
    const orgId = ctx.job.organization_id;
    if (!batchId || !orgId) return { errorCode: 'INTERNAL' };
    const system = { actorType: 'system' as const };
    const batch = await this.tx.run(system, (s) =>
      s.db
        .updateTable('fleet.fleet_import_batches')
        .set({ status: 'validating' })
        .where('id', '=', batchId)
        .where('fleet_organization_id', '=', orgId)
        .where('status', '=', 'uploaded')
        .returningAll()
        .executeTakeFirst(),
    );
    if (!batch) return { errorCode: 'INVALID_TRANSITION' };
    const fail = async (code: string): Promise<JobOutcome> => {
      await this.tx.run(system, (s) =>
        s.db
          .updateTable('fleet.fleet_import_batches')
          .set({ status: 'failed', finished_at: new Date() })
          .where('id', '=', batch.id)
          .execute(),
      );
      return { errorCode: code };
    };
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
    const columns: { index: number; field: string }[] = [];
    for (const c of mapping) {
      const index = header.indexOf(c.column.trim());
      if (index < 0 || !(IMPORT_FIELDS as readonly string[]).includes(c.field)) return fail('VALIDATION_FAILED');
      columns.push({ index, field: c.field });
    }
    await this.tx.run(system, (s) =>
      s.db
        .updateTable('fleet.fleet_import_batches')
        .set({ status: 'processing', total_rows: parsed.records.length })
        .where('id', '=', batch.id)
        .execute(),
    );
    let createdCount = 0;
    const errors: { line: number; pointer: string; code: string; cells: string[] }[] = [];
    for (let start = 0; start < parsed.records.length; start += CHUNK) {
      if (ctx.signal.aborted) return fail('UNAVAILABLE');
      const chunk = parsed.records.slice(start, start + CHUNK);
      await this.tx.run(system, async (scope) => {
        for (const record of chunk) {
          await sql`SAVEPOINT import_row`.execute(scope.db);
          try {
            await this.#row(scope, orgId, ctx.job.owner_user_id, record.cells, columns);
            await sql`RELEASE SAVEPOINT import_row`.execute(scope.db);
            createdCount++;
          } catch (err) {
            await sql`ROLLBACK TO SAVEPOINT import_row`.execute(scope.db);
            const problems =
              isApiError(err) && err.errors?.length ? err.errors : [{ pointer: '/', code: isApiError(err) ? err.code : 'INTERNAL' }];
            for (const p of problems) errors.push({ line: record.line, pointer: p.pointer, code: p.code, cells: record.cells });
          }
        }
      });
      await ctx.progress(Math.floor((100 * Math.min(parsed.records.length, start + CHUNK)) / Math.max(1, parsed.records.length)));
    }
    const errorRows = new Set(errors.map((e) => e.line)).size;
    await this.tx.run(system, async (scope) => {
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
        .updateTable('fleet.fleet_import_batches')
        .set({
          status: errors.length ? (createdCount ? 'completed_with_errors' : 'failed') : 'completed',
          created_count: createdCount,
          error_count: errorRows,
          error_report_media_asset_id: report,
          finished_at: new Date(),
        })
        .where('id', '=', batch.id)
        .execute();
    });
    return { result: { type: 'fleet_import_batch', id: batch.id } };
  }

  /** One record: validated like a vehicles.create body (closed schema, node types), then created with the vehicle rules. */
  async #row(
    scope: TxScope,
    orgId: string,
    createdBy: string,
    cells: string[],
    columns: { index: number; field: string }[],
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    for (const c of columns) {
      const raw = normalizeString(cells[c.index] ?? '');
      if (!raw.ok) throw ApiError.validation([{ pointer: `/${c.field}`, code: 'forbidden_character' }]);
      const v = raw.value.trim();
      if (v === '') continue;
      if (INTEGER_FIELDS.has(c.field)) {
        if (!/^-?\d+$/.test(v)) throw ApiError.validation([{ pointer: `/${c.field}`, code: 'type' }]);
        body[c.field] = Number(v);
      } else body[c.field] = v;
    }
    const refs = this.#validator.validateBody('vehicles.create', 201, body);
    if (refs.length) await this.nodeTypes.check(refs);
    await this.vehicles.createFleetVehicle(scope, orgId, body, createdBy);
  }
}
