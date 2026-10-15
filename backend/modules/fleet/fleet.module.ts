// fleet module (41 §2.1 M9; 40 §18; W7 fleet imports, W8 fleet exports).
// Three Nest modules share this folder:
//   FleetModule        (global, every deployable) FleetDrivers, FleetWorkflow,
//                      FleetPartners for vehicles, appointments and search,
//                      the authorizer's DriverAssignments (SEC-AZ-7), the
//                      cost-approval consumer, its DSR and retention parts,
//                      and the §18 handlers (api host).
//   FleetWorkerModule  W7 FleetImporter and W8 FleetExporter (hosted by
//                      workers/import-jobs and workers/export-jobs).
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DriverAssignments } from '#libs/authz/index.js';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { retentionCutoff, RetentionHandlers } from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import {
  ApprovalViews,
  FleetApprovalCreateHandler,
  FleetApprovalDecideHandler,
  FleetApprovalGetHandler,
  FleetApprovalsListHandler,
  FleetAssignmentEndHandler,
  FleetAssignmentSetHandler,
  FleetAssignmentsListHandler,
  FleetDashboardHandler,
  FleetPartnerCreateHandler,
  FleetPartnersListHandler,
  FleetPartnerUpdateHandler,
  FleetProfileGetHandler,
  FleetProfilePutHandler,
} from './application/fleet-ops.js';
import { FleetReports } from './application/reports.js';
import {
  FleetExportCreateHandler,
  FleetExportDownloadHandler,
  FleetExporter,
  FleetExportsListHandler,
  FleetImportCreateHandler,
  FleetImporter,
  FleetImportErrorReportHandler,
  FleetImportsListHandler,
  FleetReportHandler,
} from './application/transfer-ops.js';
import {
  approvalRequested,
  DbDriverAssignments,
  DbFleetDrivers,
  DbFleetPartners,
  DbFleetWorkflow,
  DriverNames,
  workflowOn,
} from './infrastructure/fleet-services.js';
import { FleetDrivers, FleetPartners, FleetWorkflow } from './interface/fleet.js';

export { FLEET_EXPORT_QUEUE, FLEET_IMPORT_QUEUE, FleetExporter, FleetImporter } from './application/transfer-ops.js';

/**
 * A provider's cost estimate on a fleet appointment (provider.appointments_update
 * publishes fleet.approval.requested without an approval, 40 Appendix A):
 * above the fleet's cost_approval_threshold_amount, with the workflow on, a
 * cost_estimate approval is opened for the fleet (system context: the
 * provider cannot write fleet records).
 */
@Injectable()
export class FleetCostApprovalConsumer extends EventConsumer {
  readonly name = 'fleet.cost_approvals';
  readonly subjects = ['fleet.approval.requested'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const p = e.payload;
    if (p.approval_id || typeof p.appointment_id !== 'string' || typeof p.organization_id !== 'string') return;
    const cost = p.cost_estimate as { amount?: string; currency?: string } | undefined;
    if (!cost?.amount || !cost.currency) return;
    await this.tx.run({ actorType: 'system', requestId: e.requestId }, async (scope) => {
      const orgId = p.organization_id as string;
      if (!(await workflowOn(scope, orgId))) return;
      const profile = await scope.db
        .selectFrom('fleet.fleet_profiles')
        .select(['cost_approval_threshold_amount', 'reporting_currency'])
        .where('organization_id', '=', orgId)
        .executeTakeFirst();
      const threshold = profile?.cost_approval_threshold_amount;
      // No threshold: estimates need no approval; another currency than the reporting one always does.
      if (threshold === null || threshold === undefined) return;
      if (cost.currency === profile!.reporting_currency && Number(cost.amount) <= Number(threshold)) return;
      const open = await scope.db
        .selectFrom('fleet.fleet_approvals')
        .select('id')
        .where('related_appointment_id', '=', p.appointment_id as string)
        .where('approval_type', '=', 'cost_estimate')
        .where('status', 'in', ['pending', 'needs_more_info'])
        .executeTakeFirst();
      if (open)
        await scope.db
          .updateTable('fleet.fleet_approvals')
          .set({ cost_estimate_amount: cost.amount, cost_estimate_currency: cost.currency })
          .where('id', '=', open.id)
          .execute();
      else {
        const row = await scope.db
          .insertInto('fleet.fleet_approvals')
          .values({
            fleet_organization_id: orgId,
            vehicle_id: p.vehicle_id as string,
            approval_type: 'cost_estimate',
            related_appointment_id: p.appointment_id as string,
            cost_estimate_amount: cost.amount,
            cost_estimate_currency: cost.currency,
            requested_by_user_id: p.requested_by_user_id as string,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await approvalRequested(scope, row);
      }
    });
  }
}

/** The fleet's parts of DSRs (driver assignments), retention (FleetExport) and taxonomy merges (partner scopes). */
@Injectable()
export class FleetRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
  ) {}

  onModuleInit(): void {
    this.personal?.register('fleet', {
      async export(scope, userId) {
        const rows = await scope.db
          .selectFrom('fleet.fleet_vehicle_assignments')
          .select(['id', 'fleet_organization_id', 'vehicle_id', 'assigned_at', 'ended_at', 'status'])
          .where('driver_user_id', '=', userId)
          .execute();
        return [
          {
            section: 'fleet_driver_assignments',
            records: rows.map((r) => ({
              id: r.id,
              fields: {
                fleet_organization_id: r.fleet_organization_id,
                vehicle_id: r.vehicle_id,
                assigned_at: r.assigned_at.toISOString(),
                ended_at: r.ended_at ? r.ended_at.toISOString() : null,
                status: r.status,
              },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        const r = await sql`UPDATE fleet.fleet_vehicle_assignments SET status = 'ended', ended_at = greatest(now(), assigned_at)
                             WHERE driver_user_id = ${userId}::uuid AND status = 'active'`.execute(scope.db);
        return Number(r.numAffectedRows ?? 0);
      },
    });
    // 52 DataRetentionPolicy FleetExport (30 days): the export rows go; their files are private and unreachable afterwards.
    this.retention?.register('FleetExport', async (scope, p) => {
      const r = await sql`DELETE FROM fleet.fleet_exports WHERE created_at < ${retentionCutoff(p)}`.execute(scope.db);
      return Number(r.numAffectedRows ?? 0);
    });
    this.taxonomyRefs?.register('fleet', (scope, from, into) =>
      repointColumns(
        scope,
        [
          ['fleet.fleet_preferred_partners', 'service_system_node_id'],
          ['fleet.fleet_preferred_partners', 'part_category_node_id'],
        ],
        from,
        into,
      ),
    );
  }
}

@Global()
@Module({
  providers: [
    DriverNames,
    { provide: FleetDrivers, useClass: DbFleetDrivers },
    { provide: FleetWorkflow, useClass: DbFleetWorkflow },
    { provide: FleetPartners, useClass: DbFleetPartners },
    { provide: DriverAssignments, useClass: DbDriverAssignments },
    FleetReports,
    ApprovalViews,
    FleetCostApprovalConsumer,
    FleetRegistrations,
    // api host (§18.2); other hosts skip them.
    FleetProfileGetHandler,
    FleetProfilePutHandler,
    FleetDashboardHandler,
    FleetAssignmentsListHandler,
    FleetAssignmentSetHandler,
    FleetAssignmentEndHandler,
    FleetPartnersListHandler,
    FleetPartnerCreateHandler,
    FleetPartnerUpdateHandler,
    FleetApprovalsListHandler,
    FleetApprovalCreateHandler,
    FleetApprovalGetHandler,
    FleetApprovalDecideHandler,
    FleetReportHandler,
    FleetExportCreateHandler,
    FleetExportsListHandler,
    FleetExportDownloadHandler,
    FleetImportCreateHandler,
    FleetImportsListHandler,
    FleetImportErrorReportHandler,
  ],
  exports: [FleetDrivers, FleetWorkflow, FleetPartners, DriverAssignments, FleetReports],
})
export class FleetModule {}

@Module({ providers: [FleetImporter, FleetExporter], exports: [FleetImporter, FleetExporter] })
export class FleetWorkerModule {}
