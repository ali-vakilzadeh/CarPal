// vehicles.odometer_prompt_skip (backend S26b.T1, DQ-24): "Skip this month". Records the skip, writes no reading, marks
// the in-app notice done and so moves the next prompt one interval ahead. Idempotent: a skip while nothing is open and
// after the newest reading changes nothing. Fleet vehicles are not prompted (DQ-27): accepted, nothing changes.
import { Injectable } from '@nestjs/common';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { loadVehicle, vehicleAccess } from './common.js';
import { closeOdometerNotices } from './odometer-notices.js';

@Injectable()
@Operation('vehicles.odometer_prompt_skip')
export class VehiclesOdometerPromptSkipHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!, true);
      if (a.fleet) return;
      const state = await scope.db
        .selectFrom('vehicle.odometer_prompt_state')
        .select(['prompted_at', 'skipped_at'])
        .where('vehicle_id', '=', v.id)
        .forUpdate()
        .executeTakeFirst();
      const newest = await scope.db
        .selectFrom('vehicle.vehicle_mileage_logs')
        .select((eb) => eb.fn.max<Date | null>('recorded_at').as('at'))
        .where('vehicle_id', '=', v.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Already skipped in this cycle (after the newest reading, nothing open): nothing to do.
      const base = newest?.at ?? v.created_at;
      if (state && !state.prompted_at && state.skipped_at && state.skipped_at > base) return;
      const now = new Date();
      await scope.db
        .insertInto('vehicle.odometer_prompt_state')
        .values({ vehicle_id: v.id, skipped_at: now, prompted_at: null })
        .onConflict((oc) => oc.column('vehicle_id').doUpdateSet({ skipped_at: now, prompted_at: null, updated_at: now }))
        .execute();
      await closeOdometerNotices(scope, a.userId, v.id);
      await publishEvent(scope, {
        type: 'odometer_prompt.skipped',
        aggregateType: 'vehicle',
        aggregateId: v.id,
        payload: { was_open: state?.prompted_at != null },
      });
    });
    return { body: ACK };
  }
}
