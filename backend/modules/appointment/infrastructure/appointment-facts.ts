// AppointmentFacts (interface/appointments.ts). Response times come from the
// append-only status history: a request is answered by the provider's first
// status change after it entered `requested` (confirm, propose, decline).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addDays, zonedToUtc } from '#libs/geo/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import { CAPACITY_STATUSES, openSlots, PATH1_DELAY_MS, todayIn } from '../domain/rules.js';
import { AppointmentFacts, type AppointmentVisit, type ProviderAppointmentStats } from '../interface/appointments.js';
import { activeRules, busyIntervals, toRuleInput } from './calendar.js';

type VisitRow = {
  id: string;
  provider_organization_id: string;
  provider_location_id: string | null;
  requester_type: string;
  requester_user_id: string;
  requester_organization_id: string | null;
  vehicle_id: string;
  service_system_node_id: string | null;
  service_task_node_id: string | null;
  status: string;
  confirmed_start_at: Date | string | null;
  confirmed_end_at: Date | string | null;
  completed_at: Date | string | null;
};

const date = (d: Date | string | null): Date | null => (d === null ? null : new Date(d));

export const toVisit = (r: VisitRow): AppointmentVisit => ({
  id: r.id,
  providerOrgId: r.provider_organization_id,
  providerLocationId: r.provider_location_id,
  requesterType: r.requester_type as AppointmentVisit['requesterType'],
  requesterUserId: r.requester_user_id,
  requesterOrgId: r.requester_organization_id,
  vehicleId: r.vehicle_id,
  serviceSystemNodeId: r.service_system_node_id,
  serviceTaskNodeId: r.service_task_node_id,
  status: r.status,
  confirmedStartAt: date(r.confirmed_start_at),
  confirmedEndAt: date(r.confirmed_end_at),
  completedAt: date(r.completed_at),
});

const VISIT_COLUMNS = [
  'id',
  'provider_organization_id',
  'provider_location_id',
  'requester_type',
  'requester_user_id',
  'requester_organization_id',
  'vehicle_id',
  'service_system_node_id',
  'service_task_node_id',
  'status',
  'confirmed_start_at',
  'confirmed_end_at',
  'completed_at',
] as const;

@Injectable()
export class DbAppointmentFacts extends AppointmentFacts {
  constructor(private readonly booking: ProviderBooking) {
    super();
  }

  async nextOpenSlot(scope: TxScope, providerOrgId: string, now: Date, days = 14): Promise<Date | null> {
    const ids = await this.booking.locationIds(scope, providerOrgId);
    const locations = await this.booking.locations(scope, ids, 'en', now);
    let best: Date | null = null;
    for (const id of ids) {
      const loc = locations.get(id);
      if (!loc) continue;
      const rules = (await activeRules(scope, providerOrgId, id)).map(toRuleInput);
      if (rules.length === 0) continue;
      const from = todayIn(loc.timezone, now);
      const start = zonedToUtc(from, '00:00', loc.timezone);
      const end = zonedToUtc(addDays(from, days), '00:00', loc.timezone);
      const busy = await busyIntervals(scope, providerOrgId, id, start, end);
      const timeOff = await scope.db
        .selectFrom('appointment.provider_time_off')
        .select(['start_at', 'end_at'])
        .where('provider_organization_id', '=', providerOrgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('location_id', 'is', null), eb('location_id', '=', id)]))
        .where('start_at', '<', end)
        .where('end_at', '>', start)
        .execute();
      const slot = openSlots({
        rules,
        timezone: loc.timezone,
        from,
        days,
        busy,
        timeOff: timeOff.map((t) => ({ start: new Date(t.start_at), end: new Date(t.end_at) })),
        now,
      })[0];
      if (slot && (!best || new Date(slot.start_at) < best)) best = new Date(slot.start_at);
    }
    return best;
  }

  async visits(scope: TxScope, ids: readonly string[]): Promise<Map<string, AppointmentVisit>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const { rows } = await sql<VisitRow>`SELECT * FROM appointment.visit_cards(${sql.val(unique)}::uuid[])`.execute(scope.db);
    return new Map(rows.map((r) => [r.id, toVisit(r)]));
  }

  async mine(scope: TxScope, userId: string, providerOrgId: string): Promise<AppointmentVisit[]> {
    const rows = await scope.db
      .selectFrom('appointment.appointments')
      .select(VISIT_COLUMNS)
      .where('requester_user_id', '=', userId)
      .where('provider_organization_id', '=', providerOrgId)
      .where('deleted_at', 'is', null)
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    return rows.map(toVisit);
  }

  async completed(scope: TxScope, providerOrgId: string): Promise<AppointmentVisit[]> {
    const rows = await scope.db
      .selectFrom('appointment.appointments')
      .select(VISIT_COLUMNS)
      .where('provider_organization_id', '=', providerOrgId)
      .where('status', '=', 'completed')
      .where('deleted_at', 'is', null)
      .orderBy('completed_at', 'desc')
      .limit(2000)
      .execute();
    return rows.map(toVisit);
  }

  async tookPlaceSince(scope: TxScope, since: Date, now: Date, limit: number): Promise<AppointmentVisit[]> {
    const passed = new Date(now.getTime() - PATH1_DELAY_MS);
    const rows = await scope.db
      .selectFrom('appointment.appointments')
      .select(VISIT_COLUMNS)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'completed'), eb('completed_at', '>=', since)]),
          eb.and([
            eb('status', 'in', [...CAPACITY_STATUSES]),
            eb('confirmed_start_at', '<=', passed),
            eb('confirmed_start_at', '>=', new Date(since.getTime() - PATH1_DELAY_MS)),
          ]),
        ]),
      )
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map(toVisit);
  }

  async activeProviders(scope: TxScope, since: Date, limit: number): Promise<string[]> {
    const rows = await scope.db
      .selectFrom('appointment.appointments')
      .select('provider_organization_id')
      .where('updated_at', '>=', since)
      .where('deleted_at', 'is', null)
      .groupBy('provider_organization_id')
      .orderBy('provider_organization_id')
      .limit(limit)
      .execute();
    return rows.map((r) => r.provider_organization_id);
  }

  async stats(scope: TxScope, providerOrgId: string, now: Date): Promise<ProviderAppointmentStats> {
    const d90 = new Date(now.getTime() - 90 * 86_400_000);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);
    const d365 = new Date(now.getTime() - 365 * 86_400_000);
    const { rows: responses } = await sql<{ requested_at: Date; responded_at: Date | null }>`
      SELECT q.requested_at,
             (SELECT min(h2.changed_at) FROM appointment.appointment_status_history h2
               WHERE h2.appointment_id = q.appointment_id AND h2.changed_by_side = 'provider'
                 AND h2.changed_at >= q.requested_at) AS responded_at
        FROM (SELECT h.appointment_id, min(h.changed_at) AS requested_at
                FROM appointment.appointment_status_history h
                JOIN appointment.appointments a ON a.id = h.appointment_id
               WHERE a.provider_organization_id = ${providerOrgId}::uuid AND a.deleted_at IS NULL
                 AND h.new_status = 'requested'
               GROUP BY h.appointment_id) q`.execute(scope.db);
    const minutes = (r: { requested_at: Date; responded_at: Date | null }) =>
      (new Date(r.responded_at!).getTime() - new Date(r.requested_at).getTime()) / 60_000;
    const in90 = responses.filter((r) => new Date(r.requested_at) >= d90);
    const answered30 = responses.filter((r) => new Date(r.requested_at) >= d30 && r.responded_at);
    const answeredAll = responses.filter((r) => r.responded_at);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    const { rows: confirmed } = await sql<{
      id: string;
      status: string;
      cancelled_by: string | null;
      confirmed_at: Date;
      requested_at: Date | null;
      confirmed_start_at: Date | null;
    }>`
      SELECT a.id, a.status::text AS status, a.cancelled_by, c.confirmed_at, r.requested_at, a.confirmed_start_at
        FROM appointment.appointments a
        JOIN LATERAL (SELECT min(h.changed_at) AS confirmed_at FROM appointment.appointment_status_history h
                       WHERE h.appointment_id = a.id AND h.new_status = 'confirmed') c ON c.confirmed_at IS NOT NULL
        LEFT JOIN LATERAL (SELECT min(h.changed_at) AS requested_at FROM appointment.appointment_status_history h
                            WHERE h.appointment_id = a.id AND h.new_status = 'requested') r ON true
       WHERE a.provider_organization_id = ${providerOrgId}::uuid AND a.deleted_at IS NULL
         AND c.confirmed_at >= ${d90}`.execute(scope.db);
    const turnaround = confirmed
      .filter((c) => c.requested_at && c.confirmed_start_at)
      .map((c) => (new Date(c.confirmed_start_at!).getTime() - new Date(c.requested_at!).getTime()) / 3_600_000)
      .sort((a, b) => a - b);
    const median = turnaround.length
      ? turnaround.length % 2
        ? turnaround[(turnaround.length - 1) / 2]!
        : (turnaround[turnaround.length / 2 - 1]! + turnaround[turnaround.length / 2]!) / 2
      : null;

    const outcomes = await scope.db
      .selectFrom('appointment.appointments')
      .select(['status', 'requester_type', 'requester_user_id', 'requester_organization_id', 'completed_at', 'updated_at'])
      .where('provider_organization_id', '=', providerOrgId)
      .where('status', 'in', ['completed', 'no_show'])
      .where('deleted_at', 'is', null)
      .execute();
    const completed = outcomes.filter((o) => o.status === 'completed');
    const completed12m = completed.filter((o) => new Date(o.completed_at!) >= d365);
    // A returning customer: the same requester (user, or fleet organization) completed an earlier appointment here.
    const who = (o: { requester_type: string; requester_user_id: string; requester_organization_id: string | null }) =>
      o.requester_type === 'fleet' ? `f:${o.requester_organization_id}` : `u:${o.requester_user_id}`;
    const repeat = completed12m.filter((o) =>
      completed.some((p) => who(p) === who(o) && new Date(p.completed_at!).getTime() < new Date(o.completed_at!).getTime()),
    ).length;
    const last = completed.reduce<Date | null>((m, o) => {
      const t = new Date(o.completed_at!);
      return !m || t > m ? t : m;
    }, null);
    return {
      requests90: in90.length,
      respondedWithin24h90: in90.filter((r) => r.responded_at && minutes(r) <= 24 * 60).length,
      responded30: answered30.length,
      avgResponseMinutes30: avg(answered30.map(minutes)),
      avgResponseMinutesAll: avg(answeredAll.map(minutes)),
      confirmed90: confirmed.length,
      providerCancelledAfterConfirm90: confirmed.filter((c) => c.status === 'cancelled' && c.cancelled_by === 'provider').length,
      completed90: completed.filter((o) => new Date(o.completed_at!) >= d90).length,
      noShow90: outcomes.filter((o) => o.status === 'no_show' && new Date(o.updated_at) >= d90).length,
      medianTurnaroundHours90: median,
      turnaroundSamples90: turnaround.length,
      completed12m: completed12m.length,
      repeatCompleted12m: repeat,
      fleetCompleted: completed.filter((o) => o.requester_type === 'fleet').length,
      lastCompletedAt: last,
    };
  }
}
