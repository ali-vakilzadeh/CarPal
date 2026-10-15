// VehicleCards and VehicleService (interface/vehicles.ts), and the reads
// behind the registrations other modules call (vehicle.module.ts): the
// provider-side lookups use the vehicle.vehicle_owner definer, because a
// provider's context cannot read a customer's vehicle.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { JobLogVerification, VisitInfo } from '#modules/organization/interface/extensions.js';
import { VehicleCreator, type VehicleWrite } from '../application/vehicle-ops.js';
import { issueOpen } from '../domain/rules.js';
import {
  VehicleCards,
  VehicleService,
  type AppointmentServiceRecord,
  type HistoryEntry,
  type IssueCard,
  type OpenReminder,
  type OwnedVehicle,
  type ServiceVisit,
  type VehicleCard,
  type FleetIssueRow,
  type FleetServiceRow,
  type FleetVehicleFigures,
  type FleetVehicleRow,
} from '../interface/vehicles.js';

registerConstraintErrors({
  // One service record per appointment (42 §6).
  vehicle_service_records_appointment_uq: { code: 'DUPLICATE', pointer: '/appointment_id', fieldCode: 'not_unique' },
});

type CardRow = {
  id: string;
  brand_node_id: string;
  model_node_id: string;
  series_node_id: string | null;
  year: number;
  engine_type_node_id: string | null;
  fuel_type_node_id: string | null;
  nickname: string | null;
};

const toCard = (r: CardRow): VehicleCard => ({
  id: r.id,
  brandNodeId: r.brand_node_id,
  modelNodeId: r.model_node_id,
  seriesNodeId: r.series_node_id,
  year: r.year,
  engineTypeNodeId: r.engine_type_node_id,
  fuelTypeNodeId: r.fuel_type_node_id,
  nickname: r.nickname,
});

@Injectable()
export class DbVehicleCards extends VehicleCards {
  async cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, VehicleCard>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const { rows } = await sql<CardRow>`SELECT * FROM vehicle.vehicle_cards(${sql.val(unique)}::uuid[])`.execute(scope.db);
    return new Map(rows.map((r) => [r.id, toCard(r)]));
  }

  async visible(scope: TxScope, vehicleId: string): Promise<OwnedVehicle | null> {
    const v = await scope.db
      .selectFrom('vehicle.vehicles')
      .selectAll()
      .where('id', '=', vehicleId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // RLS owner_all: only the owner user's or the owner organization's context reads it.
    if (!v) return null;
    return { ...toCard(v), ownerType: v.owner_type as OwnedVehicle['ownerType'], ownerId: v.owner_id, status: v.status };
  }

  async openReminders(scope: TxScope, vehicleId: string, limit: number): Promise<OpenReminder[]> {
    if (!(await this.visible(scope, vehicleId))) return [];
    const rows = await scope.db
      .selectFrom('vehicle.maintenance_reminders')
      .select(['id', 'reminder_type', 'title', 'status', 'priority'])
      .where('vehicle_id', '=', vehicleId)
      .where('status', 'in', ['overdue', 'due', 'upcoming'])
      .where('deleted_at', 'is', null)
      .orderBy(sql`CASE status WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END`)
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows;
  }

  async serviceVisits(scope: TxScope, providerOrgId: string): Promise<ServiceVisit[]> {
    // RLS owner_all: only records of the caller's own vehicles (user or fleet context).
    const rows = await scope.db
      .selectFrom('vehicle.vehicle_service_records as r')
      .innerJoin('vehicle.vehicles as v', 'v.id', 'r.vehicle_id')
      .select([
        'r.id',
        'r.vehicle_id',
        'r.service_date',
        'r.verification_status',
        'r.appointment_id',
        'r.service_system_node_id',
        'r.service_task_node_id',
      ])
      .where('r.provider_organization_id', '=', providerOrgId)
      .where('r.verification_status', '<>', 'self_reported')
      .where('r.status', '<>', 'removed')
      .where('r.deleted_at', 'is', null)
      .where('v.deleted_at', 'is', null)
      .where((eb) =>
        scope.context.orgId
          ? eb.and([eb('v.owner_type', '=', 'organization'), eb('v.owner_id', '=', scope.context.orgId)])
          : eb.and([eb('v.owner_type', '=', 'user'), eb('v.owner_id', '=', scope.context.userId ?? null)]),
      )
      .orderBy('r.service_date', 'desc')
      .orderBy('r.id', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      serviceDate: new Date(r.service_date).toISOString().slice(0, 10),
      verificationStatus: r.verification_status,
      appointmentId: r.appointment_id,
      serviceSystemNodeId: r.service_system_node_id,
      serviceTaskNodeId: r.service_task_node_id,
    }));
  }

  async serviceHistory(scope: TxScope, vehicleId: string, limit: number): Promise<HistoryEntry[]> {
    if (!(await this.visible(scope, vehicleId))) return [];
    const rows = await scope.db
      .selectFrom('vehicle.vehicle_service_records')
      .select(['id', 'service_date', 'service_system_node_id', 'service_task_node_id', 'description', 'mileage_km'])
      .where('vehicle_id', '=', vehicleId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('service_date', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      serviceDate: new Date(r.service_date).toISOString().slice(0, 10),
      serviceSystemNodeId: r.service_system_node_id,
      serviceTaskNodeId: r.service_task_node_id,
      description: r.description,
      mileageKm: r.mileage_km === null ? null : Number(r.mileage_km),
    }));
  }

  async serviceRecordParties(scope: TxScope, recordId: string) {
    // RLS: the owner's records, or the provider of record's (provider_read); the vehicle owner through the definer.
    const r = await scope.db
      .selectFrom('vehicle.vehicle_service_records')
      .select(['vehicle_id', 'provider_organization_id'])
      .where('id', '=', recordId)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) return null;
    const { rows } = await sql<{ owner_id: string | null }>`SELECT vehicle.vehicle_owner(${r.vehicle_id}::uuid) AS owner_id`.execute(
      scope.db,
    );
    const owner = rows[0]?.owner_id;
    if (owner) return { ownerType: 'user' as const, ownerId: owner, providerOrgId: r.provider_organization_id };
    // vehicle_owner answers personal vehicles only: fleet vehicles are read by their owner directly.
    const v = await scope.db
      .selectFrom('vehicle.vehicles')
      .select(['owner_type', 'owner_id'])
      .where('id', '=', r.vehicle_id)
      .executeTakeFirst();
    return v
      ? { ownerType: v.owner_type as 'user' | 'organization', ownerId: v.owner_id, providerOrgId: r.provider_organization_id }
      : null;
  }

  async fleetVehicles(scope: TxScope, orgId: string, vehicleIds?: readonly string[]): Promise<FleetVehicleRow[]> {
    let q = scope.db
      .selectFrom('vehicle.vehicles')
      .select([
        'id',
        'brand_node_id',
        'model_node_id',
        'year',
        'nickname',
        'license_plate',
        'vin_last4',
        'status',
        'mileage_km',
        'created_at',
      ])
      .where('owner_type', '=', 'organization')
      .where('owner_id', '=', orgId)
      .where('deleted_at', 'is', null);
    if (vehicleIds) q = q.where('id', 'in', vehicleIds.length ? [...vehicleIds] : ['00000000-0000-7000-8000-000000000000']);
    const rows = await q.orderBy('id').limit(100_000).execute();
    return rows.map((r) => ({
      id: r.id,
      brandNodeId: r.brand_node_id,
      modelNodeId: r.model_node_id,
      year: r.year,
      nickname: r.nickname,
      licensePlate: r.license_plate,
      vinLast4: r.vin_last4,
      status: r.status,
      mileageKm: r.mileage_km,
      createdAt: r.created_at,
    }));
  }

  async fleetServiceRecords(
    scope: TxScope,
    orgId: string,
    from: string,
    to: string,
    vehicleIds?: readonly string[],
  ): Promise<FleetServiceRow[]> {
    let q = scope.db
      .selectFrom('vehicle.vehicle_service_records as r')
      .innerJoin('vehicle.vehicles as v', 'v.id', 'r.vehicle_id')
      .select([
        'r.id',
        'r.vehicle_id',
        'r.service_date',
        'r.provider_organization_id',
        'r.service_system_node_id',
        'r.service_task_node_id',
        'r.cost_amount',
        'r.currency',
        'r.appointment_id',
      ])
      .where('v.owner_type', '=', 'organization')
      .where('v.owner_id', '=', orgId)
      .where('r.status', '<>', 'removed')
      .where('r.deleted_at', 'is', null)
      .where('r.service_date', '>=', from)
      .where('r.service_date', '<=', to);
    if (vehicleIds?.length) q = q.where('r.vehicle_id', 'in', [...vehicleIds]);
    const rows = await q.orderBy('r.service_date').limit(100_000).execute();
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      serviceDate: String(r.service_date).slice(0, 10),
      providerOrgId: r.provider_organization_id,
      serviceSystemNodeId: r.service_system_node_id,
      serviceTaskNodeId: r.service_task_node_id,
      costAmount: r.cost_amount,
      currency: r.currency,
      appointmentId: r.appointment_id,
    }));
  }

  async fleetIssues(scope: TxScope, orgId: string, from: Date, to: Date): Promise<FleetIssueRow[]> {
    const rows = await scope.db
      .selectFrom('vehicle.vehicle_issues as i')
      .innerJoin('vehicle.vehicles as v', 'v.id', 'i.vehicle_id')
      .select(['i.id', 'i.vehicle_id', 'i.symptom_node_id', 'i.source', 'i.status', 'i.created_at'])
      .where('v.owner_type', '=', 'organization')
      .where('v.owner_id', '=', orgId)
      .where('i.deleted_at', 'is', null)
      .where('i.created_at', '>=', from)
      .where('i.created_at', '<', to)
      .limit(100_000)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      symptomNodeId: r.symptom_node_id,
      source: r.source,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  async fleetDashboard(scope: TxScope, orgId: string): Promise<FleetVehicleFigures> {
    const { rows } = await sql<{ total: string; due: string; in_repair: string; open_issues: string; driver_issues: string }>`
      SELECT (SELECT count(*) FROM vehicle.vehicles v WHERE v.owner_type = 'organization' AND v.owner_id = ${orgId}::uuid
                 AND v.status IN ('active','in_repair') AND v.deleted_at IS NULL) AS total,
             (SELECT count(DISTINCT r.vehicle_id) FROM vehicle.maintenance_reminders r JOIN vehicle.vehicles v ON v.id = r.vehicle_id
               WHERE v.owner_type = 'organization' AND v.owner_id = ${orgId}::uuid AND v.deleted_at IS NULL
                 AND r.status IN ('due','overdue') AND r.deleted_at IS NULL) AS due,
             (SELECT count(*) FROM vehicle.vehicles v WHERE v.owner_type = 'organization' AND v.owner_id = ${orgId}::uuid
                 AND v.status = 'in_repair' AND v.deleted_at IS NULL) AS in_repair,
             (SELECT count(*) FROM vehicle.vehicle_issues i JOIN vehicle.vehicles v ON v.id = i.vehicle_id
               WHERE v.owner_type = 'organization' AND v.owner_id = ${orgId}::uuid AND v.deleted_at IS NULL
                 AND i.status IN ('open','investigating','scheduled') AND i.deleted_at IS NULL) AS open_issues,
             (SELECT count(*) FROM vehicle.vehicle_issues i JOIN vehicle.vehicles v ON v.id = i.vehicle_id
               WHERE v.owner_type = 'organization' AND v.owner_id = ${orgId}::uuid AND v.deleted_at IS NULL
                 AND i.source = 'fleet_driver' AND i.status IN ('open','investigating','scheduled') AND i.deleted_at IS NULL) AS driver_issues`.execute(
      scope.db,
    );
    const r = rows[0]!;
    return {
      total: Number(r.total),
      dueForService: Number(r.due),
      inRepair: Number(r.in_repair),
      openIssues: Number(r.open_issues),
      driverReportedIssues: Number(r.driver_issues),
    };
  }

  async appointmentRecords(scope: TxScope, appointmentIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(appointmentIds)].slice(0, 500);
    if (ids.length === 0) return new Map();
    // RLS: the owner's records, or the provider of record's (provider_read).
    const rows = await scope.db
      .selectFrom('vehicle.vehicle_service_records')
      .select(['id', 'appointment_id'])
      .where('appointment_id', 'in', ids)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .execute();
    return new Map(rows.map((r) => [r.appointment_id!, r.id]));
  }

  async issue(scope: TxScope, issueId: string): Promise<IssueCard | null> {
    const i = await scope.db
      .selectFrom('vehicle.vehicle_issues as i')
      .innerJoin('vehicle.vehicles as v', 'v.id', 'i.vehicle_id')
      .select(['i.id', 'i.vehicle_id', 'i.title', 'i.description', 'i.symptom_node_id', 'i.urgency_level', 'i.status'])
      .where('i.id', '=', issueId)
      .where('i.deleted_at', 'is', null)
      .where('v.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!i || !(await this.visible(scope, i.vehicle_id))) return null;
    return {
      id: i.id,
      vehicleId: i.vehicle_id,
      title: i.title,
      description: i.description,
      symptomNodeId: i.symptom_node_id,
      urgencyLevel: i.urgency_level,
      status: i.status,
    };
  }
}

@Injectable()
export class DbVehicleService extends VehicleService {
  constructor(private readonly creator: VehicleCreator) {
    super();
  }

  async recordAppointmentService(scope: TxScope, r: AppointmentServiceRecord): Promise<string> {
    const row = await scope.db
      .insertInto('vehicle.vehicle_service_records')
      .values({
        vehicle_id: r.vehicleId,
        service_date: r.serviceDate,
        provider_organization_id: r.providerOrganizationId,
        service_system_node_id: r.serviceSystemNodeId,
        service_task_node_id: r.serviceTaskNodeId ?? null,
        description: r.description ?? null,
        mileage_km: r.mileageKm ?? null,
        parts_used: JSON.stringify(r.partsUsed ?? []),
        cost_amount: r.cost?.amount ?? null,
        currency: r.cost?.currency ?? null,
        cost_breakdown: r.costBreakdown ? JSON.stringify(r.costBreakdown) : null,
        warranty_note: r.warrantyNote ?? null,
        source_type: 'appointment_completed',
        verification_status: 'appointment_verified',
        appointment_id: r.appointmentId,
        // RLS provider_insert accepts organization-created rows only; the worker writes as the system.
        created_by_type: scope.context.actorType === 'system' ? 'system' : 'organization',
        visibility: 'private',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await scope.db
      .insertInto('vehicle.service_record_evidence')
      .values({
        service_record_id: row.id,
        evidence_type: 'appointment_record',
        reference_entity_type: 'appointment',
        reference_entity_id: r.appointmentId,
      })
      .execute();
    await publishEvent(scope, {
      type: 'service_record.created',
      aggregateType: 'service_record',
      aggregateId: row.id,
      payload: {
        vehicle_id: row.vehicle_id,
        provider_organization_id: row.provider_organization_id,
        source_type: row.source_type,
        verification_status: row.verification_status,
        service_system_node_id: row.service_system_node_id,
        appointment_id: r.appointmentId,
      },
    });
    return row.id;
  }

  async setIssueApproval(scope: TxScope, issueId: string, status: 'approved' | 'rejected'): Promise<void> {
    await scope.db
      .updateTable('vehicle.vehicle_issues')
      .set({ fleet_approval_status: status })
      .where('id', '=', issueId)
      .where('source', '=', 'fleet_driver')
      .where('deleted_at', 'is', null)
      .execute();
  }

  async createFleetVehicle(scope: TxScope, orgId: string, body: Record<string, unknown>, createdBy: string): Promise<string> {
    const row = await this.creator.create(scope, { type: 'organization', id: orgId }, body as unknown as VehicleWrite, {
      userId: createdBy,
      driver: false,
    });
    return row.id;
  }

  async markIssueScheduled(scope: TxScope, issueId: string, appointmentId: string): Promise<void> {
    const issue = await scope.db
      .selectFrom('vehicle.vehicle_issues')
      .select(['id', 'status'])
      .where('id', '=', issueId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!issue) throw new ApiError('REFERENCE_NOT_FOUND', { detail: 'issue' });
    if (!issueOpen(issue.status)) throw new ApiError('INVALID_TRANSITION', { detail: `issue is ${issue.status}` });
    await scope.db
      .updateTable('vehicle.vehicle_issues')
      .set({ status: 'scheduled', converted_appointment_id: appointmentId })
      .where('id', '=', issueId)
      .execute();
  }
}

/** Owner user of a personal vehicle (definer; null for fleet vehicles and unknown ids). */
export async function vehicleOwner(scope: TxScope, vehicleId: string): Promise<string | null> {
  const { rows } = await sql<{ owner: string | null }>`SELECT vehicle.vehicle_owner(${vehicleId}::uuid) AS owner`.execute(scope.db);
  return rows[0]?.owner ?? null;
}

/** What a service record proves about a job log linked to it (54 §1.1). */
function jobLogVerification(r: { verification_status: string; created_by_type: string; source_type: string }): JobLogVerification {
  if (r.verification_status === 'invoice_verified' || r.verification_status === 'admin_verified') return 'invoice_verified';
  if (r.verification_status === 'appointment_verified') return 'appointment_verified';
  // The customer entered the record and named this provider: the job is confirmed by the customer.
  if (r.created_by_type === 'user' && (r.source_type === 'user_manual' || r.source_type === 'invoice_upload')) return 'customer_confirmed';
  return 'self_reported';
}

/** A service record at the provider, in the provider's context (RLS provider_read), as a visit of its customer. */
export async function serviceRecordVisit(scope: TxScope, providerOrgId: string, recordId: string): Promise<VisitInfo | null> {
  const r = await scope.db
    .selectFrom('vehicle.vehicle_service_records')
    .select(['vehicle_id', 'verification_status', 'created_by_type', 'source_type'])
    .where('id', '=', recordId)
    .where('provider_organization_id', '=', providerOrgId)
    .where('status', '<>', 'removed')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!r) return null;
  const customer = await vehicleOwner(scope, r.vehicle_id);
  // Fleet vehicles have no personal customer to address (consent requests, notes).
  if (!customer) return null;
  return { customerUserId: customer, vehicleId: r.vehicle_id, jobLogVerification: jobLogVerification(r) };
}

/** 52 ProviderCustomerNote: the user owns a vehicle with a service record at the provider. */
export async function isServiceCustomer(scope: TxScope, providerOrgId: string, userId: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM vehicle.vehicle_service_records r
                    WHERE r.provider_organization_id = ${providerOrgId}::uuid AND r.status <> 'removed' AND r.deleted_at IS NULL
                      AND vehicle.vehicle_owner(r.vehicle_id) = ${userId}::uuid) AS ok`.execute(scope.db);
  return rows[0]?.ok === true;
}
