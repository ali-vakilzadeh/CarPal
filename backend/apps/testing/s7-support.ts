// Shared helpers of the S7 integration tests (appointments, reviews and
// trust): a customer with a vehicle, request bodies with future windows,
// times in the provider's time zone, and availability rules.
import { localParts, zonedToUtc } from '#libs/geo/index.js';
import type { TestUser } from '#libs/testing/index.js';
import type { Json, Nodes } from './s4-support.js';
import { client, type Client } from './s5-support.js';
import type { PublishedOrg } from './s6-support.js';
import type { TestApp } from './test-app.js';

export const TZ = 'Asia/Tehran';

export interface Customer {
  user: TestUser;
  token: string;
  c: Client;
  vehicleId: string;
}

/** A user with a verified email and an active vehicle. */
export async function customer(app: TestApp, n: Nodes): Promise<Customer> {
  const user = await app.fixtures.user();
  const token = await app.fixtures.token(user);
  return { user, token, c: client(app, token), vehicleId: await app.fixtures.vehicle(user, n) };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A preferred window `daysAhead` days from now (1 hour long). */
export const window = (daysAhead = 2, priority = 1) => ({
  start_at: iso(Date.now() + daysAhead * 86_400_000),
  end_at: iso(Date.now() + daysAhead * 86_400_000 + 3_600_000),
  priority,
});

export const requestBody = (p: PublishedOrg, cu: Customer, n: Nodes, o: Json = {}) => ({
  provider_organization_id: p.id,
  provider_location_id: p.locationId,
  vehicle_id: cu.vehicleId,
  source: 'direct_search',
  appointment_type: 'repair',
  service_mode: 'in_shop',
  service_system_node_id: n.system,
  description: 'Front brakes squeal when stopping at low speed.',
  content_locale: 'en',
  urgency_level: 'medium',
  time_windows: [window()],
  submit: true,
  ...o,
});

/** A request sent by the customer (201), returning the appointment. */
export async function requested(p: PublishedOrg, cu: Customer, n: Nodes, o: Json = {}): Promise<Json> {
  const res = await cu.c.post('/v1/me/appointments', requestBody(p, cu, n, o));
  if (res.status !== 201) throw new Error(`appointments.create ${res.status} ${res.text}`);
  return res.body;
}

/** A local date `daysAhead` days from now in the location time zone, its weekday (0 = Sunday) and an instant at HH:MM there. */
export function localDay(daysAhead: number) {
  const date = localParts(new Date(Date.now() + daysAhead * 86_400_000), TZ).date;
  return {
    date,
    dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(),
    at: (hhmm: string) => zonedToUtc(date, hhmm, TZ),
  };
}

/** An availability rule on one weekday (09:00–17:00, 60-minute slots). */
export async function rule(p: PublishedOrg, dayOfWeek: number, o: Json = {}): Promise<Json> {
  const res = await p.c.post(`/v1/orgs/${p.id}/provider/availability-rules`, {
    location_id: p.locationId,
    day_of_week: dayOfWeek,
    start_time: '09:00',
    end_time: '17:00',
    slot_duration_minutes: 60,
    max_concurrent_appointments: 1,
    ...o,
  });
  if (res.status !== 201) throw new Error(`availability.rule_create ${res.status} ${res.text}`);
  return res.body;
}

export const provider = (p: PublishedOrg, path = '') => `/v1/orgs/${p.id}/provider/appointments${path}`;
