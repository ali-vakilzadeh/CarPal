// vehicle module (41 §2.1 M5; 40 §12). Three Nest modules share this folder:
//   VehicleModule        (global, every deployable) VehicleCards and
//                        VehicleService for other modules, and the
//                        registrations that open the fail-closed S4 paths:
//                        billing UsageCounters max_vehicles; organization
//                        visits 'service_record', customer check and vehicle
//                        owners; media attachment targets 'vehicle' and
//                        'vehicle_issue'; identity ConsentScopes 'vehicle';
//                        the AI context sources and suggestion appliers (S9).
//   VehicleApiModule     §12 operations on the api host (vehicle-api.module.ts)
//   VehicleWorkerModule  the hourly W15 reminder rule on the worker (vehicle-worker.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { UsageCounters } from '#modules/billing/interface/billing.js';
import { ConsentScopes, PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { AttachmentTargets, type AttachmentTarget } from '#modules/media/interface/media.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleAiRegistrations } from './application/ai-registrations.js';
import { VehicleCreator } from './application/vehicle-ops.js';
import { COUNTING_STATUSES } from './domain/rules.js';
import { DbVehicleCards, DbVehicleService, isServiceCustomer, serviceRecordVisit, vehicleOwner } from './infrastructure/vehicles.js';
import { VehicleCards, VehicleService } from './interface/vehicles.js';

export { VehicleReminderRule } from './application/reminder-rule.js';

/** Media on a vehicle or an issue belongs to the vehicle's owner; fleet coordinators (FC) attach for a fleet. */
const ownerTarget = (v: { owner_type: string; owner_id: string } | undefined): AttachmentTarget | null =>
  v ? { owner: { type: v.owner_type as 'user' | 'organization', id: v.owner_id }, groups: ['FC'] } : null;

@Injectable()
export class VehicleRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly counters?: UsageCounters,
    @Optional() private readonly ext?: OrganizationExtensions,
    @Optional() private readonly targets?: AttachmentTargets,
    @Optional() private readonly scopes?: ConsentScopes,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
    // DSR (S8): personal vehicles with their records and issues are exported; deletion removes the vehicles (VIN and plate cleared).
    this.personal?.register('vehicle', {
      async export(scope, userId) {
        const vehicles = await scope.db
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
          .where('owner_type', '=', 'user')
          .where('owner_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        const ids = vehicles.map((v) => v.id);
        const records = ids.length
          ? await scope.db
              .selectFrom('vehicle.vehicle_service_records')
              .select([
                'id',
                'vehicle_id',
                'service_date',
                'service_system_node_id',
                'description',
                'cost_amount',
                'currency',
                'provider_organization_id',
              ])
              .where('vehicle_id', 'in', ids)
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        const issues = ids.length
          ? await scope.db
              .selectFrom('vehicle.vehicle_issues')
              .select(['id', 'vehicle_id', 'title', 'description', 'status', 'created_at'])
              .where('vehicle_id', 'in', ids)
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return [
          {
            section: 'vehicles',
            records: vehicles.map((v) => ({
              id: v.id,
              fields: {
                brand_node_id: v.brand_node_id,
                model_node_id: v.model_node_id,
                year: v.year,
                nickname: v.nickname,
                license_plate: v.license_plate,
                vin_last4: v.vin_last4,
                status: v.status,
                mileage_km: v.mileage_km,
                created_at: v.created_at.toISOString(),
              },
            })),
          },
          {
            section: 'service_records',
            records: records.map((r) => ({
              id: r.id,
              fields: {
                vehicle_id: r.vehicle_id,
                service_date: String(r.service_date).slice(0, 10),
                service_system_node_id: r.service_system_node_id,
                description: r.description,
                cost_amount: r.cost_amount,
                currency: r.currency,
                provider_organization_id: r.provider_organization_id,
              },
            })),
          },
          {
            section: 'vehicle_issues',
            records: issues.map((i) => ({
              id: i.id,
              fields: {
                vehicle_id: i.vehicle_id,
                title: i.title,
                description: i.description,
                status: i.status,
                created_at: i.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        const r = await scope.db
          .updateTable('vehicle.vehicles')
          .set({
            deleted_at: new Date(),
            deletion_reason: 'data subject request',
            vin_encrypted: null,
            vin_hash: null,
            vin_last4: null,
            license_plate: null,
            notes: null,
            nickname: null,
          })
          .where('owner_type', '=', 'user')
          .where('owner_id', '=', userId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
    });
    // admin.taxonomy_merge (S8): vehicle, issue and service record node references follow a merged node.
    this.taxonomyRefs?.register('vehicle', (scope, from, into) =>
      repointColumns(
        scope,
        [
          ['vehicle.vehicles', 'brand_node_id'],
          ['vehicle.vehicles', 'model_node_id'],
          ['vehicle.vehicles', 'series_node_id'],
          ['vehicle.vehicles', 'engine_type_node_id'],
          ['vehicle.vehicles', 'fuel_type_node_id'],
          ['vehicle.vehicle_issues', 'symptom_node_id'],
          ['vehicle.vehicle_service_records', 'service_system_node_id'],
          ['vehicle.vehicle_service_records', 'service_task_node_id'],
        ],
        from,
        into,
      ),
    );
    // 52 §21: active and in_repair vehicles of the subscriber (read after the subscriber lock, SEC-AZ-9).
    this.counters?.register('max_vehicles', async (scope, s) => {
      const row = await scope.db
        .selectFrom('vehicle.vehicles')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('owner_type', '=', s.type)
        .where('owner_id', '=', s.id)
        .where('status', 'in', [...COUNTING_STATUSES])
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    });
    this.ext?.registerVisits('service_record', serviceRecordVisit);
    this.ext?.registerCustomerCheck(isServiceCustomer);
    this.ext?.registerVehicleOwners(vehicleOwner);
    this.targets?.register('vehicle', async (scope, id) =>
      ownerTarget(
        await scope.db
          .selectFrom('vehicle.vehicles')
          .select(['owner_type', 'owner_id'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      ),
    );
    this.targets?.register('vehicle_issue', async (scope, id) =>
      ownerTarget(
        await scope.db
          .selectFrom('vehicle.vehicle_issues as i')
          .innerJoin('vehicle.vehicles as v', 'v.id', 'i.vehicle_id')
          .select(['v.owner_type', 'v.owner_id'])
          .where('i.id', '=', id)
          .where('i.deleted_at', 'is', null)
          .where('v.deleted_at', 'is', null)
          .executeTakeFirst(),
      ),
    );
    // A vehicle-scoped consent (vehicle_data_sharing) is granted only by the owner of a personal vehicle (SEC-AZ-4).
    this.scopes?.register('vehicle', async (scope, userId, id) => {
      const v = await scope.db
        .selectFrom('vehicle.vehicles')
        .select('id')
        .where('id', '=', id)
        .where('owner_type', '=', 'user')
        .where('owner_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!v;
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: VehicleCards, useClass: DbVehicleCards },
    VehicleCreator,
    { provide: VehicleService, useClass: DbVehicleService },
    VehicleRegistrations,
    VehicleAiRegistrations,
  ],
  exports: [VehicleCards, VehicleService, VehicleCreator],
})
export class VehicleModule {}
