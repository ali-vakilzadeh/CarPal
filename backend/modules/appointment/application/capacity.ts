// Capacity at confirmation (52 §12: "confirming re-checks capacity in the same
// transaction, so concurrent bookings cannot exceed capacity"). Confirmations
// of one location are serialized by the transaction-scoped advisory lock that
// appointment.capacity_available takes; that function checks the matching
// availability rule, time off and overlapping appointments with buffers. A
// location without any active rule has no calendar yet: only time off blocks
// it (S7 decision, recorded in the plan), under the same lock.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import type { AppointmentRow } from '../api/projections.js';

@Injectable()
export class Capacity {
  constructor(private readonly booking: ProviderBooking) {}

  /**
   * Throws 409 CAPACITY_UNAVAILABLE unless the window fits; returns the
   * location the appointment is confirmed at (its own, else the provider's
   * primary active location).
   */
  async require(scope: TxScope, a: AppointmentRow, start: Date, end: Date): Promise<string | null> {
    const locationId = a.provider_location_id ?? (await this.booking.provider(scope, a.provider_organization_id))?.locationIds[0] ?? null;
    if (!locationId) return null;
    const location = (await this.booking.locations(scope, [locationId], 'en')).get(locationId);
    if (!location) throw new ApiError('CAPACITY_UNAVAILABLE', { detail: 'location not available' });
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`appointment.capacity:${locationId}`}, 0))`.execute(scope.db);
    const rules = await scope.db
      .selectFrom('appointment.provider_availability_rules')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('provider_organization_id', '=', a.provider_organization_id)
      .where('location_id', '=', locationId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    let ok: boolean;
    if (Number(rules.n) > 0) {
      const { rows } = await sql<{ ok: boolean }>`
        SELECT appointment.capacity_available(${a.provider_organization_id}::uuid, ${locationId}::uuid, ${location.timezone},
                                              ${start}, ${end}, ${a.appointment_type}, ${a.id}::uuid) AS ok`.execute(scope.db);
      ok = rows[0]?.ok === true;
    } else {
      const off = await scope.db
        .selectFrom('appointment.provider_time_off')
        .select('id')
        .where('provider_organization_id', '=', a.provider_organization_id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('location_id', 'is', null), eb('location_id', '=', locationId)]))
        .where('start_at', '<', end)
        .where('end_at', '>', start)
        .executeTakeFirst();
      ok = !off;
    }
    if (!ok) throw new ApiError('CAPACITY_UNAVAILABLE');
    return locationId;
  }
}
