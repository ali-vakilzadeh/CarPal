// vehicle module (41 §2.1 M5; 40 §12). Three Nest modules share this folder:
//   VehicleModule        (global, every deployable) VehicleCards and
//                        VehicleService for other modules, and the
//                        registrations that open the fail-closed S4 paths:
//                        billing UsageCounters max_vehicles; organization
//                        visits 'service_record', customer check and vehicle
//                        owners; media attachment targets 'vehicle' and
//                        'vehicle_issue'; identity ConsentScopes 'vehicle'.
//   VehicleApiModule     §12 operations on the api host (vehicle-api.module.ts)
//   VehicleWorkerModule  the hourly W15 reminder rule on the worker (vehicle-worker.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { UsageCounters } from '#modules/billing/interface/billing.js';
import { ConsentScopes } from '#modules/identity/interface/identity.js';
import { AttachmentTargets, type AttachmentTarget } from '#modules/media/interface/media.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
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
  ) {}

  onModuleInit(): void {
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
    { provide: VehicleService, useClass: DbVehicleService },
    VehicleRegistrations,
  ],
  exports: [VehicleCards, VehicleService],
})
export class VehicleModule {}
