// Contract sweep resolvers: appointments on both requester scopes (a user's
// own, a fleet's), the provider side, the pre-visit report, calendar and
// availability (40 §16), public availability (§14.3). Internal notes never
// reach the requester; the exact address is released only after confirmation.
import type { Route } from '#libs/contract/index.js';
import { expect } from 'vitest';
import { localDay } from '../../s7-support.js';
import { sharedProvider } from '../domain.js';
import { ok, type Actor, type Harness, type Json, type Published, type Resolvers } from '../harness.js';

const iso = (ms: number | Date) => new Date(ms).toISOString();
const window = (daysAhead = 2) => ({
  start_at: iso(Date.now() + daysAhead * 86_400_000),
  end_at: iso(Date.now() + daysAhead * 86_400_000 + 3_600_000),
  priority: 1,
});

interface Requested {
  p: Published;
  as: Actor;
  base: string;
  a: Json;
  vehicleId: string;
}

/** A requester on the route's scope (a user, or a fleet coordinator of a fleet with a plan) with a vehicle. */
async function requesterOf(h: Harness, route: Route | 'me'): Promise<{ as: Actor; vehicleId: string; base: string }> {
  const fleet = route !== 'me' && route.scope === 'fleet';
  const as = fleet ? await h.member('fleet') : await h.user();
  return { as, vehicleId: await h.vehicle(as), base: fleet ? `/v1/orgs/${as.org!.id}/fleet/appointments` : '/v1/me/appointments' };
}

const body = (h: Harness, p: Published, vehicleId: string, o: Json = {}) => ({
  provider_organization_id: p.id,
  provider_location_id: p.locationId,
  vehicle_id: vehicleId,
  source: 'direct_search',
  appointment_type: 'repair',
  service_mode: 'in_shop',
  service_system_node_id: h.n.system,
  description: 'Front brakes squeal when stopping at low speed.',
  content_locale: 'en',
  urgency_level: 'medium',
  time_windows: [window()],
  submit: true,
  ...o,
});

async function requested(h: Harness, route: Route | 'me', o: Json = {}): Promise<Requested> {
  const p = await sharedProvider(h);
  const r = await requesterOf(h, route);
  const a = ok(await r.as.c.post(r.base, body(h, p, r.vehicleId, o)), 'appointments.create');
  return { p, ...r, a };
}

const prov = (p: Published, id = '') => `/v1/orgs/${p.id}/provider/appointments${id ? `/${id}` : ''}`;

/** A request the provider confirmed to start in an hour (check-in window open; ci link mailed to a user requester). */
async function confirmed(h: Harness, route: Route | 'me'): Promise<Requested> {
  const r = await requested(h, route);
  r.a = ok(
    await r.p.as.c.post(`${prov(r.p, r.a.id)}/transitions`, {
      to: 'confirmed',
      confirmed_start_at: iso(Date.now() + 3_600_000),
      estimated_duration_minutes: 60,
    }),
    'confirm',
  );
  return r;
}

/** A fresh published provider with a weekday availability rule (rules change public slots: kept off the shared provider). */
async function withRule(h: Harness): Promise<{ p: Published; rule: Json; day: ReturnType<typeof localDay> }> {
  const p = await h.provider();
  const day = localDay(5);
  const rule = ok(
    await p.as.c.post(`/v1/orgs/${p.id}/provider/availability-rules`, {
      location_id: p.locationId,
      day_of_week: day.dayOfWeek,
      start_time: '09:00',
      end_time: '12:00',
      slot_duration_minutes: 60,
      max_concurrent_appointments: 1,
    }),
    'availability rule',
  );
  return { p, rule, day };
}

export const resolvers: Resolvers = {
  'public.availability': async (h) => {
    const { p, day } = await withRule(h);
    return {
      as: await h.anonymous(),
      params: { org_id: p.id },
      query: { location_id: p.locationId, from: day.date, days: 1 },
      check: (res) => expect(res.body.slots).toHaveLength(3),
    };
  },
  'appointments.create': async (h, route) => {
    const p = await sharedProvider(h);
    const r = await requesterOf(h, route);
    return {
      as: r.as,
      body: body(h, p, r.vehicleId),
      bodyRefs: true,
      // SEC-OUT-4: no exact address before confirmation.
      check: (res) => expect(res.body.provider_location_exact).toBeNull(),
    };
  },
  'appointments.list': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(r.a.id) };
  },
  'appointments.get': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string } };
  },
  'appointments.update': async (h, route) => {
    const r = await requested(h, route, { submit: false, time_windows: [] });
    return {
      as: r.as,
      params: { appointment_id: r.a.id as string },
      version: r.a.version as number,
      body: { time_windows: [window(3)], description: 'Brakes squeal and the car pulls left.' },
    };
  },
  'appointments.transition': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string }, body: { to: 'cancelled', cancellation_reason: 'Found another time' } };
  },
  'appointments.delay': async (h, route) => {
    const r = await confirmed(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string }, body: { customer_delay_minutes: 15 } };
  },
  'appointments.check_in': async (h, route) => {
    const r = await confirmed(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string } };
  },
  'appointments.check_in_link': async (h) => {
    const r = await confirmed(h, 'me');
    const mail = h.api.mail(r.as.user.email, 'appointment.check_in_link').at(-1);
    if (!mail) throw new Error('no check-in link mailed');
    return {
      as: await h.anonymous(),
      body: { token: mail.variables.link!.split('#')[1]! },
      check: (res) => expect(res.body).toEqual({ appointment_id: r.a.id, status: 'checked_in' }),
    };
  },
  'appointments.history': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string } };
  },
  'appointments.notes_list': async (h, route) => {
    const r = await requested(h, route);
    ok(
      await r.p.as.c.post(`${prov(r.p, r.a.id)}/notes`, {
        note_type: 'internal',
        body: 'Customer seems price sensitive',
        content_locale: 'en',
      }),
      'internal note',
    );
    ok(
      await r.p.as.c.post(`${prov(r.p, r.a.id)}/notes`, {
        note_type: 'customer_visible',
        body: 'Please bring the spare key',
        content_locale: 'en',
      }),
      'note',
    );
    return {
      as: r.as,
      params: { appointment_id: r.a.id as string },
      check: (res) => {
        expect(res.text).not.toContain('price sensitive');
        expect(res.body.items.map((x: Json) => x.body)).toEqual(['Please bring the spare key']);
      },
    };
  },
  'appointments.note_create': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string }, body: { body: 'Will be there at 10', content_locale: 'en' } };
  },
  'pre_visit.requester_get': async (h, route) => {
    const r = await requested(h, route);
    return { as: r.as, params: { appointment_id: r.a.id as string } };
  },
  'provider.appointments_list': async (h) => {
    const r = await requested(h, 'me');
    return { as: r.p.as, query: { status: 'requested', limit: 50 } };
  },
  'provider.appointments_get': async (h) => {
    const r = await requested(h, 'me');
    return { as: r.p.as, params: { appointment_id: r.a.id as string }, check: (res) => expect(res.body.requester_contact).toBeNull() };
  },
  'provider.appointments_update': async (h) => {
    const r = await requested(h, 'me');
    return {
      as: r.p.as,
      params: { appointment_id: r.a.id as string },
      version: r.a.version as number,
      body: { estimated_duration_minutes: 90, parts_availability_note: 'Pads in stock' },
    };
  },
  'provider.appointments_transition': async (h) => {
    const r = await requested(h, 'me');
    return {
      as: r.p.as,
      params: { appointment_id: r.a.id as string },
      body: { to: 'confirmed', confirmed_start_at: iso(Date.now() + 3 * 86_400_000), estimated_duration_minutes: 60 },
    };
  },
  'provider.participants_list': async (h) => {
    const r = await requested(h, 'me');
    return { as: r.p.as, params: { appointment_id: r.a.id as string } };
  },
  'provider.participant_add': async (h) => {
    const r = await requested(h, 'me');
    // SEC-AZ-4: participants are members of the provider; the caller of another organization cannot name this appointment.
    return { as: r.p.as, params: { appointment_id: r.a.id as string }, body: { user_id: r.p.as.user.id, participant_role: 'technician' } };
  },
  'provider.participant_remove': async (h) => {
    const r = await requested(h, 'me');
    const t = ok(
      await r.p.as.c.post(`${prov(r.p, r.a.id)}/participants`, { user_id: r.p.as.user.id, participant_role: 'technician' }),
      'participant',
    );
    return { as: r.p.as, params: { appointment_id: r.a.id as string, participant_id: t.id as string } };
  },
  'provider.notes_list': async (h) => {
    const r = await requested(h, 'me');
    return { as: r.p.as, params: { appointment_id: r.a.id as string } };
  },
  'provider.note_create': async (h) => {
    const r = await requested(h, 'me');
    return {
      as: r.p.as,
      params: { appointment_id: r.a.id as string },
      body: { note_type: 'internal', body: 'Customer seems price sensitive', content_locale: 'en' },
    };
  },
  'pre_visit.provider_get': async (h) => {
    const r = await requested(h, 'me', { share_history: { policy_version: '2026-10' } });
    return { as: r.p.as, params: { appointment_id: r.a.id as string } };
  },
  'provider.calendar': async (h) => {
    const { p, day } = await withRule(h);
    return { as: p.as, query: { from: day.date, to: day.date } };
  },
  'availability.rules_list': async (h) => {
    const { p } = await withRule(h);
    return { as: p.as, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'availability.rule_create': async (h) => {
    const p = await h.provider();
    return {
      as: p.as,
      body: {
        location_id: p.locationId,
        day_of_week: 2,
        start_time: '09:00',
        end_time: '17:00',
        slot_duration_minutes: 60,
        max_concurrent_appointments: 1,
      },
      bodyRefs: true,
    };
  },
  'availability.rule_update': async (h) => {
    const { p, rule } = await withRule(h);
    return { as: p.as, params: { rule_id: rule.id as string }, version: rule.version as number, body: { end_time: '11:00' } };
  },
  'availability.rule_delete': async (h) => {
    const { p, rule } = await withRule(h);
    return { as: p.as, params: { rule_id: rule.id as string } };
  },
  'availability.time_off_list': async (h) => {
    const p = await h.provider();
    const day = localDay(6);
    ok(
      await p.as.c.post(`/v1/orgs/${p.id}/provider/time-off`, {
        start_at: iso(day.at('08:30')),
        end_at: iso(day.at('10:30')),
        reason: 'Training',
      }),
      'time off',
    );
    return { as: p.as, query: { from: day.date, to: day.date } };
  },
  'availability.time_off_create': async (h) => {
    const p = await h.provider();
    const day = localDay(6);
    return {
      as: p.as,
      body: { location_id: p.locationId, start_at: iso(day.at('08:30')), end_at: iso(day.at('10:30')), reason: 'Training' },
      bodyRefs: true,
    };
  },
  'availability.time_off_cancel': async (h) => {
    const p = await h.provider();
    const day = localDay(6);
    const off = ok(
      await p.as.c.post(`/v1/orgs/${p.id}/provider/time-off`, {
        start_at: iso(day.at('08:30')),
        end_at: iso(day.at('10:30')),
        reason: 'Training',
      }),
      'time off',
    );
    return { as: p.as, params: { time_off_id: off.time_off.id as string } };
  },
};
