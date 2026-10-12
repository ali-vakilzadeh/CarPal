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
import { issueOpen } from '../domain/rules.js';
import {
  VehicleCards,
  VehicleService,
  type AppointmentServiceRecord,
  type OpenReminder,
  type OwnedVehicle,
  type VehicleCard,
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
}

@Injectable()
export class DbVehicleService extends VehicleService {
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
