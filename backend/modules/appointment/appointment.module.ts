// appointment module (41 §2.1 M10; 40 §16, public.availability). Three Nest
// modules share this folder:
//   AppointmentModule        (global, every deployable) AppointmentFacts for
//                            the trust module and the registrations that open
//                            the fail-closed S4 paths: organization visits
//                            'appointment' (job logs and portfolio items linked
//                            to appointments, appointment_verified once
//                            completed), the customer check, insight figures;
//                            media attachment target 'appointment'; identity
//                            ConsentScopes 'appointment'.
//   AppointmentApiModule     §16 operations and public.availability on the api host.
//   AppointmentWorkerModule  W15 appointment reminders (hosted by the worker).
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { ConsentScopes, PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { AttachmentTargets } from '#modules/media/interface/media.js';
import { OrganizationExtensions, type VisitInfo } from '#modules/organization/interface/extensions.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { DbAppointmentFacts } from './infrastructure/appointment-facts.js';
import { AppointmentFacts } from './interface/appointments.js';

/** An appointment of the provider (provider context, RLS party_all) as a visit of its requester. */
async function appointmentVisit(scope: TxScope, providerOrgId: string, id: string): Promise<VisitInfo | null> {
  const a = await scope.db
    .selectFrom('appointment.appointments')
    .select(['requester_user_id', 'vehicle_id', 'status'])
    .where('id', '=', id)
    .where('provider_organization_id', '=', providerOrgId)
    .where('status', '<>', 'draft')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!a) return null;
  // 54 §1.1: a job log linked to a completed appointment is appointment_verified.
  return {
    customerUserId: a.requester_user_id,
    vehicleId: a.vehicle_id,
    jobLogVerification: a.status === 'completed' ? 'appointment_verified' : 'self_reported',
  };
}

const inPeriod = (period: { from: string; to: string }) => ({
  from: new Date(`${period.from}T00:00:00Z`),
  to: new Date(Date.parse(`${period.to}T00:00:00Z`) + 86_400_000),
});

@Injectable()
export class AppointmentRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly ext?: OrganizationExtensions,
    @Optional() private readonly targets?: AttachmentTargets,
    @Optional() private readonly scopes?: ConsentScopes,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
    // DSR (S8): the user's requests are exported; on deletion the provider keeps the appointment as a business
    // record without the customer's own words (description replaced, expectations cleared).
    this.personal?.register('appointment', {
      async export(scope, userId) {
        const rows = await scope.db
          .selectFrom('appointment.appointments')
          .select(['id', 'provider_organization_id', 'vehicle_id', 'status', 'description', 'confirmed_start_at', 'created_at'])
          .where('requester_type', '=', 'user')
          .where('requester_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        return [
          {
            section: 'appointments',
            records: rows.map((a) => ({
              id: a.id,
              fields: {
                provider_organization_id: a.provider_organization_id,
                vehicle_id: a.vehicle_id,
                status: a.status,
                description: a.description,
                confirmed_start_at: a.confirmed_start_at ? a.confirmed_start_at.toISOString() : null,
                created_at: a.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        const r = await scope.db
          .updateTable('appointment.appointments')
          .set({ description: 'Removed at the request of the customer.', customer_expectations: null })
          .where('requester_type', '=', 'user')
          .where('requester_user_id', '=', userId)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
    });
    // admin.taxonomy_merge (S8): appointment node references follow a merged node.
    this.taxonomyRefs?.register('appointment', (scope, from, into) =>
      repointColumns(
        scope,
        [
          ['appointment.appointments', 'service_system_node_id'],
          ['appointment.appointments', 'service_task_node_id'],
          ['appointment.appointments', 'symptom_node_id'],
        ],
        from,
        into,
      ),
    );
    this.ext?.registerVisits('appointment', appointmentVisit);
    // 52 ProviderCustomerNote: the user has requested an appointment from the provider.
    this.ext?.registerCustomerCheck(async (scope, providerOrgId, userId) => {
      const a = await scope.db
        .selectFrom('appointment.appointments')
        .select('id')
        .where('provider_organization_id', '=', providerOrgId)
        .where('requester_user_id', '=', userId)
        .where('status', '<>', 'draft')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!a;
    });
    this.ext?.registerInsight('provider.requests_received', async (scope, orgId, period) => {
      const p = inPeriod(period);
      const { rows } = await sql<{ n: string }>`
        SELECT count(DISTINCT h.appointment_id) AS n FROM appointment.appointment_status_history h
          JOIN appointment.appointments a ON a.id = h.appointment_id
         WHERE a.provider_organization_id = ${orgId}::uuid AND h.new_status = 'requested'
           AND h.changed_at >= ${p.from} AND h.changed_at < ${p.to}`.execute(scope.db);
      return Number(rows[0]?.n ?? 0);
    });
    this.ext?.registerInsight('provider.completion_rate', async (scope, orgId, period) => {
      const p = inPeriod(period);
      const rows = await scope.db
        .selectFrom('appointment.appointments')
        .select(['status', 'cancelled_by'])
        .where('provider_organization_id', '=', orgId)
        .where('confirmed_start_at', '>=', p.from)
        .where('confirmed_start_at', '<', p.to)
        .where('status', 'in', ['completed', 'cancelled', 'no_show'])
        .where('deleted_at', 'is', null)
        .execute();
      // Completed out of the confirmed appointments the provider closed; customer no-shows never count against it (54 §3.1).
      const closed = rows.filter((r) => r.status === 'completed' || (r.status === 'cancelled' && r.cancelled_by === 'provider'));
      if (closed.length === 0) return null;
      return String(Math.round((closed.filter((r) => r.status === 'completed').length / closed.length) * 10_000) / 10_000);
    });
    // Photos of a request belong to its requester (the user, or the fleet: FC attach).
    this.targets?.register('appointment', async (scope, id) => {
      const a = await scope.db
        .selectFrom('appointment.appointments')
        .select(['requester_user_id', 'requester_organization_id'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!a) return null;
      return a.requester_organization_id
        ? { owner: { type: 'organization', id: a.requester_organization_id }, groups: ['FC'] }
        : { owner: { type: 'user', id: a.requester_user_id }, groups: [] };
    });
    // A consent scoped to an appointment is granted only by its individual requester (SEC-AZ-4).
    this.scopes?.register('appointment', async (scope, userId, id) => {
      const a = await scope.db
        .selectFrom('appointment.appointments')
        .select('id')
        .where('id', '=', id)
        .where('requester_type', '=', 'user')
        .where('requester_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!a;
    });
  }
}

@Global()
@Module({
  providers: [{ provide: AppointmentFacts, useClass: DbAppointmentFacts }, AppointmentRegistrations],
  exports: [AppointmentFacts],
})
export class AppointmentModule {}
