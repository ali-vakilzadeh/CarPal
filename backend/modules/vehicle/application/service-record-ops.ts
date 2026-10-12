// Service history (40 §12.2, 52 VehicleServiceRecord, MVP Module I):
// service_records.list / create / get / update / delete / evidence_add /
// evidence_remove under {V}, and provider.service_record_create on {prv}.
// Owners enter user_manual and invoice_upload records (self_reported until
// verified); a provider enters provider_logged records (provider_confirmed)
// for a customer's vehicle only with the owner's vehicle_data_sharing
// consent to that provider. Provider and appointment records cannot be
// edited by the owner (disputes, S7).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ConsentChecker, requireConsent } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toEvidence, toServiceRecord, type EvidenceRow, type ServiceRecordRow, type VehicleRow } from '../api/projections.js';
import { issueOpen, todayUtc } from '../domain/rules.js';
import { checkVersion, failIf, json, loadVehicle, notFoundAt, vehicleAccess, vehiclesPath } from './common.js';

type Money = { amount: string; currency: string };
type PartUsed = { name: string; part_number?: string; quantity: number; inventory_item_id?: string };

export type ServiceRecordWrite = {
  service_date: string;
  provider_organization_id?: string;
  service_system_node_id: string;
  service_task_node_id?: string;
  description?: string;
  parts_used?: PartUsed[];
  cost?: Money;
  cost_breakdown?: { labor?: string; parts?: string; tax?: string; other?: string };
  warranty_note?: string;
  mileage_km?: number;
  resolves_issue_id?: string;
  source_type: 'user_manual' | 'invoice_upload';
  visibility: 'private' | 'shared_with_providers' | 'fleet';
};

type ProviderServiceRecordWrite = Omit<ServiceRecordWrite, 'source_type' | 'visibility' | 'provider_organization_id'> & {
  vehicle_id?: string;
  appointment_id?: string;
};

/** Records the owner entered (40 service_records.update: provider and appointment records can only be disputed). */
const OWNER_SOURCES = ['user_manual', 'invoice_upload'];

@Injectable()
export class ServiceRecordRules {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly orgs: OrgCards,
    private readonly inventory: InventoryRead,
  ) {}

  /** Field rules of a (merged) write; references are checked in the caller's context (SEC-AZ-4). */
  async check(
    scope: TxScope,
    r: Partial<ServiceRecordWrite>,
    o: { fleet: boolean; vehicleId: string; written: Partial<ServiceRecordWrite> },
  ) {
    const errors: FieldError[] = [];
    if (r.service_date && r.service_date > todayUtc()) errors.push({ pointer: '/service_date', code: 'in_future' });
    if (r.visibility === 'fleet' && !o.fleet) errors.push({ pointer: '/visibility', code: 'conditional_forbidden' });
    if (r.cost_breakdown && !r.cost) errors.push({ pointer: '/cost', code: 'conditional_required' });
    failIf(errors);
    if (r.service_task_node_id && r.service_system_node_id)
      await this.taxonomy.requireDescendant(r.service_task_node_id, r.service_system_node_id, '/service_task_node_id');
    const w = o.written;
    if (w.provider_organization_id) {
      const card = (await this.orgs.cards(scope, [w.provider_organization_id])).get(w.provider_organization_id);
      if (!card || !['provider', 'hybrid_provider_vendor'].includes(card.organizationType) || ['archived', 'merged'].includes(card.status))
        throw notFoundAt('/provider_organization_id');
    }
    const items = (w.parts_used ?? []).map((p, i) => [i, p.inventory_item_id] as const).filter((x): x is [number, string] => !!x[1]);
    if (items.length) {
      const visible = await this.inventory.visibleIds(
        scope,
        items.map(([, id]) => id),
      );
      const missing = items.filter(([, id]) => !visible.has(id));
      if (missing.length)
        throw ApiError.validation(
          missing.map(([i]) => ({ pointer: `/parts_used/${i}/inventory_item_id`, code: 'reference_not_found' as const })),
          'REFERENCE_NOT_FOUND',
        );
    }
    if (w.resolves_issue_id) {
      const issue = await scope.db
        .selectFrom('vehicle.vehicle_issues')
        .select(['id', 'status'])
        .where('id', '=', w.resolves_issue_id)
        .where('vehicle_id', '=', o.vehicleId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!issue) throw notFoundAt('/resolves_issue_id');
    }
  }
}

/** The issue a record resolves becomes resolved (52 VehicleServiceRecord.resolves_issue_id). */
async function resolveIssue(scope: TxScope, issueId: string): Promise<void> {
  const issue = await scope.db
    .selectFrom('vehicle.vehicle_issues')
    .select('status')
    .where('id', '=', issueId)
    .forUpdate()
    .executeTakeFirst();
  if (issue && issueOpen(issue.status))
    await scope.db
      .updateTable('vehicle.vehicle_issues')
      .set({ status: 'resolved', resolved_at: new Date() })
      .where('id', '=', issueId)
      .execute();
}

/** An odometer reading taken with the service (52 VehicleMileageLog.source service_record). */
async function serviceMileage(scope: TxScope, vehicleId: string, date: string, km: number, userId: string): Promise<void> {
  await scope.db
    .insertInto('vehicle.vehicle_mileage_logs')
    .values({
      vehicle_id: vehicleId,
      mileage_km: km,
      recorded_at: new Date(`${date}T12:00:00Z`),
      source: 'service_record',
      recorded_by: userId,
    })
    .execute();
}

const columns = (b: Partial<ServiceRecordWrite>) => ({
  ...(b.service_date !== undefined ? { service_date: b.service_date } : {}),
  ...(b.provider_organization_id !== undefined ? { provider_organization_id: b.provider_organization_id } : {}),
  ...(b.service_system_node_id !== undefined ? { service_system_node_id: b.service_system_node_id } : {}),
  ...(b.service_task_node_id !== undefined ? { service_task_node_id: b.service_task_node_id } : {}),
  ...(b.description !== undefined ? { description: b.description } : {}),
  ...(b.parts_used !== undefined ? { parts_used: json(b.parts_used)! } : {}),
  ...(b.cost !== undefined ? { cost_amount: b.cost.amount, currency: b.cost.currency } : {}),
  ...(b.cost_breakdown !== undefined ? { cost_breakdown: json(b.cost_breakdown) } : {}),
  ...(b.warranty_note !== undefined ? { warranty_note: b.warranty_note } : {}),
  ...(b.mileage_km !== undefined ? { mileage_km: b.mileage_km } : {}),
  ...(b.resolves_issue_id !== undefined ? { resolves_issue_id: b.resolves_issue_id } : {}),
  ...(b.visibility !== undefined ? { visibility: b.visibility } : {}),
});

@Injectable()
export class ServiceRecordViews {
  constructor(private readonly orgs: OrgCards) {}

  async evidence(scope: TxScope, recordIds: readonly string[]): Promise<Map<string, EvidenceRow[]>> {
    const out = new Map<string, EvidenceRow[]>();
    if (recordIds.length === 0) return out;
    const rows = await scope.db
      .selectFrom('vehicle.service_record_evidence')
      .selectAll()
      .where('service_record_id', 'in', [...recordIds])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute();
    for (const e of rows) out.set(e.service_record_id, [...(out.get(e.service_record_id) ?? []), e]);
    return out;
  }

  async many(scope: TxScope, rows: readonly ServiceRecordRow[]) {
    const evidence = await this.evidence(
      scope,
      rows.map((r) => r.id),
    );
    const cards = await this.orgs.cards(
      scope,
      rows.map((r) => r.provider_organization_id).filter((x): x is string => !!x),
    );
    return rows.map((r) => {
      const card = r.provider_organization_id ? cards.get(r.provider_organization_id) : undefined;
      return toServiceRecord(r, evidence.get(r.id) ?? [], card ? toOrgSummary(card) : null);
    });
  }

  async one(scope: TxScope, row: ServiceRecordRow) {
    return (await this.many(scope, [row]))[0]!;
  }
}

async function loadRecord(scope: TxScope, v: VehicleRow, recordId: string, lock = false): Promise<ServiceRecordRow> {
  const q = scope.db
    .selectFrom('vehicle.vehicle_service_records')
    .selectAll()
    .where('id', '=', recordId)
    .where('vehicle_id', '=', v.id)
    .where('status', '<>', 'removed')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

const editable = (r: ServiceRecordRow): boolean => OWNER_SOURCES.includes(r.source_type) && r.status === 'active';

async function recordCreated(scope: TxScope, r: ServiceRecordRow): Promise<void> {
  await publishEvent(scope, {
    type: 'service_record.created',
    aggregateType: 'service_record',
    aggregateId: r.id,
    payload: {
      vehicle_id: r.vehicle_id,
      provider_organization_id: r.provider_organization_id,
      source_type: r.source_type,
      verification_status: r.verification_status,
      service_system_node_id: r.service_system_node_id,
    },
  });
}

type ListQuery = {
  from?: string;
  to?: string;
  service_system_node_id?: string;
  verification?: 'verified' | 'self_reported';
  limit: number;
};
type RecordPosition = { d: string; id: string } | undefined;

@Injectable()
@Operation('service_records.list')
export class ServiceRecordsListHandler implements OperationHandler {
  constructor(private readonly views: ServiceRecordViews) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const q = ctx.query;
    const pos = ctx.cursor as RecordPosition;
    const body = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let s = scope.db
          .selectFrom('vehicle.vehicle_service_records')
          .selectAll()
          .where('vehicle_id', '=', v.id)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null);
        if (q.from) s = s.where('service_date', '>=', q.from);
        if (q.to) s = s.where('service_date', '<=', q.to);
        if (q.service_system_node_id) s = s.where('service_system_node_id', '=', q.service_system_node_id);
        if (q.verification === 'verified') s = s.where('verification_status', '<>', 'self_reported');
        if (q.verification === 'self_reported') s = s.where('verification_status', '=', 'self_reported');
        // Timeline, newest service first (40): keyset on (service_date, id).
        if (pos) s = s.where(sql<boolean>`(service_date, id) < (${pos.d}::date, ${pos.id}::uuid)`);
        const rows = await s
          .orderBy('service_date', 'desc')
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const last = page.at(-1);
        return ctx.page(await this.views.many(scope, page), rows.length > q.limit && last ? { d: last.service_date, id: last.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('service_records.create')
export class ServiceRecordsCreateHandler implements OperationHandler {
  constructor(
    private readonly rules: ServiceRecordRules,
    private readonly views: ServiceRecordViews,
  ) {}

  async handle(ctx: OperationContext<ServiceRecordWrite>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      await this.rules.check(scope, b, { fleet: a.fleet, vehicleId: v.id, written: b });
      const row = await scope.db
        .insertInto('vehicle.vehicle_service_records')
        .values({
          ...columns(b),
          vehicle_id: v.id,
          service_date: b.service_date,
          service_system_node_id: b.service_system_node_id,
          source_type: b.source_type,
          // An invoice upload starts the invoice verification path (staff or AI, S8/S9); until then self-reported.
          verification_status: 'self_reported',
          created_by_type: a.fleet ? 'organization' : 'user',
          visibility: b.visibility,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.resolves_issue_id) await resolveIssue(scope, b.resolves_issue_id);
      if (b.mileage_km !== undefined) await serviceMileage(scope, v.id, b.service_date, b.mileage_km, a.userId);
      await recordCreated(scope, row);
      return this.views.one(scope, row);
    });
    return created(body, `${vehiclesPath(a)}/${ctx.params.vehicle_id}/service-records/${body.id}`);
  }
}

@Injectable()
@Operation('service_records.get')
export class ServiceRecordsGetHandler implements OperationHandler {
  constructor(private readonly views: ServiceRecordViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(
      async (scope) =>
        this.views.one(scope, await loadRecord(scope, await loadVehicle(scope, a, ctx.params.vehicle_id!), ctx.params.record_id!)),
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('service_records.update')
export class ServiceRecordsUpdateHandler implements OperationHandler {
  constructor(
    private readonly rules: ServiceRecordRules,
    private readonly views: ServiceRecordViews,
  ) {}

  async handle(ctx: OperationContext<Partial<Omit<ServiceRecordWrite, 'source_type'>>>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadRecord(scope, v, ctx.params.record_id!, true);
      checkVersion(r.version, ctx.ifMatch);
      if (!editable(r)) throw new ApiError('INVALID_TRANSITION', { detail: 'not_editable' });
      const merged: Partial<ServiceRecordWrite> = {
        service_date: b.service_date ?? r.service_date,
        service_system_node_id: b.service_system_node_id ?? r.service_system_node_id,
        ...((b.service_task_node_id ?? r.service_task_node_id)
          ? { service_task_node_id: (b.service_task_node_id ?? r.service_task_node_id)! }
          : {}),
        visibility: b.visibility ?? (r.visibility as ServiceRecordWrite['visibility']),
        ...((b.cost ?? r.cost_amount) ? { cost: b.cost ?? { amount: r.cost_amount!, currency: r.currency! } } : {}),
        ...((b.cost_breakdown ?? r.cost_breakdown)
          ? { cost_breakdown: (b.cost_breakdown ?? r.cost_breakdown) as ServiceRecordWrite['cost_breakdown'] }
          : {}),
      };
      await this.rules.check(scope, merged, { fleet: a.fleet, vehicleId: v.id, written: b });
      const row = await scope.db
        .updateTable('vehicle.vehicle_service_records')
        .set(columns(b))
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.resolves_issue_id && b.resolves_issue_id !== r.resolves_issue_id) await resolveIssue(scope, b.resolves_issue_id);
      if (b.mileage_km !== undefined && b.mileage_km !== r.mileage_km)
        await serviceMileage(scope, v.id, row.service_date, b.mileage_km, a.userId);
      return this.views.one(scope, row);
    });
    return { body };
  }
}

@Injectable()
@Operation('service_records.delete')
export class ServiceRecordsDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadRecord(scope, v, ctx.params.record_id!, true);
      if (!editable(r)) throw new ApiError('INVALID_TRANSITION', { detail: 'not_editable' });
      // Hidden, never erased: records used as review or capability evidence stay for audit (40 service_records.delete).
      await scope.db.updateTable('vehicle.vehicle_service_records').set({ status: 'removed' }).where('id', '=', r.id).execute();
      await writeAudit(scope, {
        action: 'vehicle.service_record_removed',
        entityType: 'service_record',
        entityId: r.id,
        previous: r.source_type,
      });
    });
    return { body: ACK };
  }
}

/** 40 ServiceRecord.evidence: List<ServiceRecordEvidence,20>. */
const MAX_EVIDENCE = 20;

@Injectable()
@Operation('service_records.evidence_add')
export class ServiceRecordsEvidenceAddHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(
    ctx: OperationContext<{ evidence_type: 'invoice' | 'photo' | 'document'; media_asset_id: string }>,
  ): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadRecord(scope, v, ctx.params.record_id!, true);
      const count = await scope.db
        .selectFrom('vehicle.service_record_evidence')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('service_record_id', '=', r.id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= MAX_EVIDENCE) failIf([{ pointer: '/media_asset_id', code: 'too_long', limit: String(MAX_EVIDENCE) }]);
      await this.media.requireReady(scope, [b.media_asset_id], {
        owner: a.owner,
        purposes: ['service_evidence', 'vehicle_document'],
        pointer: '/media_asset_id',
      });
      return scope.db
        .insertInto('vehicle.service_record_evidence')
        .values({ service_record_id: r.id, evidence_type: b.evidence_type, media_asset_id: b.media_asset_id })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(
      toEvidence(row),
      `${vehiclesPath(a)}/${ctx.params.vehicle_id}/service-records/${ctx.params.record_id}/evidence/${row.id}`,
    );
  }
}

@Injectable()
@Operation('service_records.evidence_remove')
export class ServiceRecordsEvidenceRemoveHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadRecord(scope, v, ctx.params.record_id!);
      const res = await scope.db
        .updateTable('vehicle.service_record_evidence')
        .set({ status: 'removed' })
        .where('id', '=', ctx.params.evidence_id!)
        .where('service_record_id', '=', r.id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('provider.service_record_create')
export class ProviderServiceRecordCreateHandler implements OperationHandler {
  constructor(
    private readonly rules: ServiceRecordRules,
    private readonly consents: ConsentChecker,
    private readonly views: ServiceRecordViews,
  ) {}

  async handle(ctx: OperationContext<ProviderServiceRecordWrite>): Promise<OperationResult> {
    const org = ctx.access.org;
    if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
    const b = ctx.body;
    // C: exactly one of vehicle_id and appointment_id.
    if (!b.vehicle_id && !b.appointment_id) failIf([{ pointer: '/vehicle_id', code: 'conditional_required' }]);
    if (b.vehicle_id && b.appointment_id) failIf([{ pointer: '/appointment_id', code: 'conditional_forbidden' }]);
    // Records through an appointment arrive with the appointment module (S7): fail closed until then.
    if (b.appointment_id) throw notFoundAt('/appointment_id');
    // The owner's issues are not visible to the provider.
    if (b.resolves_issue_id) throw notFoundAt('/resolves_issue_id');
    const vehicleId = b.vehicle_id!;
    const body = await ctx.tx(async (scope) => {
      // The provider cannot read the vehicle (RLS); its owner comes from the definer function and is never returned.
      const { rows } = await sql<{ owner: string | null }>`SELECT vehicle.vehicle_owner(${vehicleId}::uuid) AS owner`.execute(scope.db);
      const owner = rows[0]?.owner ?? null;
      if (!owner)
        throw new ApiError('CONSENT_REQUIRED', { detail: 'vehicle owner unknown', extensions: { consent_type: 'vehicle_data_sharing' } });
      await requireConsent(this.consents, scope, {
        consentType: 'vehicle_data_sharing',
        subject: { type: 'user', id: owner },
        scopeEntity: { type: 'vehicle', id: vehicleId },
        grantee: { type: 'organization', id: org.id },
      });
      await this.rules.check(scope, b, { fleet: false, vehicleId, written: b });
      const row = await scope.db
        .insertInto('vehicle.vehicle_service_records')
        .values({
          ...columns({ ...b, visibility: undefined }),
          vehicle_id: vehicleId,
          service_date: b.service_date,
          service_system_node_id: b.service_system_node_id,
          provider_organization_id: org.id,
          source_type: 'provider_logged',
          verification_status: 'provider_confirmed',
          created_by_type: 'organization',
          // The owner's history: private to the owner; the provider keeps reading it as the provider of record (RLS provider_read).
          visibility: 'private',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordCreated(scope, row);
      return this.views.one(scope, row);
    });
    return created(body, `/v1/orgs/${org.id}/provider/service-records/${body.id}`);
  }
}
