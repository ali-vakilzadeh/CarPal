// Calendar reads shared by the availability operations, the provider
// calendar and AppointmentFacts.nextOpenSlot (search availability, 54 §5.1).
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { arr, type RuleRow } from '../api/projections.js';
import type { AvailabilityRuleInput, Interval } from '../domain/rules.js';

export const toRuleInput = (r: RuleRow): AvailabilityRuleInput => ({
  location_id: r.location_id,
  day_of_week: Number(r.day_of_week),
  start_time: String(r.start_time),
  end_time: String(r.end_time),
  slot_duration_minutes: r.slot_duration_minutes,
  appointment_types: arr(r.appointment_types),
  max_concurrent_appointments: r.max_concurrent_appointments,
  buffer_minutes: r.buffer_minutes,
  effective_from: r.effective_from === null ? null : new Date(r.effective_from).toISOString().slice(0, 10),
  effective_to: r.effective_to === null ? null : new Date(r.effective_to).toISOString().slice(0, 10),
});

/** Active rules of a location (member context, or public_read for everyone else). */
export function activeRules(scope: TxScope, providerOrgId: string, locationId: string): Promise<RuleRow[]> {
  return scope.db
    .selectFrom('appointment.provider_availability_rules')
    .selectAll()
    .where('provider_organization_id', '=', providerOrgId)
    .where('location_id', '=', locationId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .orderBy('day_of_week')
    .orderBy('start_time')
    .execute();
}

/** Capacity-holding appointments of a location (definer: no party data), as intervals. */
export async function busyIntervals(scope: TxScope, providerOrgId: string, locationId: string, from: Date, to: Date): Promise<Interval[]> {
  const { rows } = await sql<{ start_at: Date; end_at: Date }>`
    SELECT start_at, end_at FROM appointment.busy_intervals(${providerOrgId}::uuid, ${locationId}::uuid, ${from}, ${to})`.execute(scope.db);
  return rows.map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }));
}
