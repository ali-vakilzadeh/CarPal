// S9a decision follow-ups (2026-10-15): one owner per VIN with the "Did you
// buy this car?" transfer (GD-33), and fleet vehicle data shared with the
// provider of a fleet appointment unless the vehicle is private, with the
// fleet's managers told (GD-34).
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, newId, vehicleBody, type Client } from './s5-support.js';
import { flush, publishedProvider, uniquePoint, type PublishedOrg } from './s6-support.js';
import { requestBody } from './s7-support.js';
import { events, query } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;
let provider: PublishedOrg;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
  provider = await publishedProvider(app, n, { name: `S9 Transfer Garage ${newId().slice(-6)}`, point: uniquePoint() });
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await app?.close();
});

const regionalVin = () => `NAAN01CA9EK${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

async function person(): Promise<{ id: string; c: Client }> {
  const user = await app.fixtures.user();
  return { id: user.id, c: client(app, await app.fixtures.token(user)) };
}

describe('vehicle transfers (GD-33)', () => {
  it('a buyer asks, the owner (never disclosed) accepts, and the vehicle moves with its records', async () => {
    const owner = await person();
    const buyer = await person();
    const vin = regionalVin();
    const car = await owner.c.post('/v1/me/vehicles', vehicleBody(n, { vin, nickname: 'Old name', license_plate: '12A345-67' }));
    expect(car.status, car.text).toBe(201);
    const issue = await owner.c.post(`/v1/me/vehicles/${car.body.id}/issues`, {
      title: 'Brake noise',
      description: 'Squeal when braking at low speed.',
      content_locale: 'en',
      urgency_level: 'medium',
    });
    expect(issue.status, issue.text).toBe(201);

    // "Did you buy this car?": the VIN is taken, a transfer can be requested.
    const taken = await buyer.c.post('/v1/me/vehicles', vehicleBody(n, { vin }));
    expect(taken.status).toBe(409);
    expect(taken.body.vin_transfer_available).toBe(true);
    expect((await buyer.c.post('/v1/me/vehicle-transfers', { vin: regionalVin() })).status).toBe(422);
    const asked = await buyer.c.post('/v1/me/vehicle-transfers', { vin, message: 'I bought it last week.' });
    expect(asked.status, asked.text).toBe(201);
    expect(asked.body).toMatchObject({
      direction: 'outgoing',
      vehicle_id: null,
      requester_display: null,
      status: 'pending',
      message: 'I bought it last week.',
    });
    expect(asked.body.vehicle_summary).toMatchObject({ vin_last4: vin.slice(-4), year: 2019 });
    expect(JSON.stringify(asked.body)).not.toContain(owner.id);
    expect((await buyer.c.post('/v1/me/vehicle-transfers', { vin })).status).toBe(409);
    expect((await owner.c.post('/v1/me/vehicle-transfers', { vin })).status).toBe(409);

    const incoming = await owner.c.get('/v1/me/vehicle-transfers?direction=incoming');
    const mine = (incoming.body.items as Json[]).find((t) => t.id === asked.body.id)!;
    expect(mine).toMatchObject({ direction: 'incoming', vehicle_id: car.body.id, requester_display: expect.any(String) });
    // Only the owner decides; the buyer cannot.
    expect((await buyer.c.post(`/v1/me/vehicle-transfers/${asked.body.id}/decision`, { decision: 'accept' })).status).toBe(404);
    const stranger = await person();
    expect((await stranger.c.get('/v1/me/vehicle-transfers')).body.items.some((t: Json) => t.id === asked.body.id)).toBe(false);

    const accepted = await owner.c.post(`/v1/me/vehicle-transfers/${asked.body.id}/decision`, { decision: 'accept' });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    expect((await owner.c.get(`/v1/me/vehicles/${car.body.id}`)).status).toBe(404);
    const moved = await buyer.c.get(`/v1/me/vehicles/${car.body.id}`);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ owner_id: buyer.id, vin_last4: vin.slice(-4) });
    // The previous owner's own fields are cleared (absent from the view).
    expect(moved.body.nickname).toBeUndefined();
    expect(moved.body.license_plate).toBeUndefined();
    const issues = await buyer.c.get(`/v1/me/vehicles/${car.body.id}/issues`);
    expect((issues.body.items as Json[]).map((i) => i.id)).toContain(issue.body.id);
    const done = await buyer.c.get('/v1/me/vehicle-transfers?direction=outgoing&status=accepted');
    expect((done.body.items as Json[]).find((t) => t.id === asked.body.id)!.vehicle_id).toBe(car.body.id);
    expect((await events(app, { aggregateId: car.body.id })).map((e) => e.type)).toContain('vehicle.transferred');
    expect((await events(app, { aggregateId: asked.body.id })).map((e) => e.type)).toEqual([
      'vehicle.transfer.requested',
      'vehicle.transfer.decided',
    ]);
    // A decided request cannot be decided again.
    expect((await owner.c.post(`/v1/me/vehicle-transfers/${asked.body.id}/decision`, { decision: 'reject' })).status).toBe(409);
    await flush(app, worker);
  });

  it('the owner can reject, the buyer can cancel, and requests expire', async () => {
    const owner = await person();
    const buyer = await person();
    const vin = regionalVin();
    await owner.c.post('/v1/me/vehicles', vehicleBody(n, { vin }));
    const a = await buyer.c.post('/v1/me/vehicle-transfers', { vin });
    expect((await owner.c.post(`/v1/me/vehicle-transfers/${a.body.id}/decision`, { decision: 'reject' })).body.status).toBe('rejected');
    const b = await buyer.c.post('/v1/me/vehicle-transfers', { vin });
    expect(b.status, b.text).toBe(201);
    expect((await owner.c.post(`/v1/me/vehicle-transfers/${b.body.id}/cancel`)).status).toBe(404);
    expect((await buyer.c.post(`/v1/me/vehicle-transfers/${b.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await buyer.c.post(`/v1/me/vehicle-transfers/${b.body.id}/cancel`)).status).toBe(409);
    const c = await buyer.c.post('/v1/me/vehicle-transfers', { vin });
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('vehicle.vehicle_transfers')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', c.body.id)
        .execute(),
    );
    expect((await owner.c.post(`/v1/me/vehicle-transfers/${c.body.id}/decision`, { decision: 'accept' })).status).toBe(409);
  });
});

describe('fleet vehicle data sharing (GD-34)', () => {
  it('a fleet appointment shares history and documents unless the vehicle is private; managers are told', async () => {
    const org = await app.fixtures.org('fleet');
    await app.fixtures.subscription(org, 'fleet_20');
    const managerUser = await app.fixtures.user();
    await app.fixtures.member(managerUser, org, 'fleet_manager');
    const manager = client(app, await app.fixtures.token(managerUser));
    const coordUser = await app.fixtures.user();
    await app.fixtures.member(coordUser, org, 'fleet_maintenance_coordinator');
    const coordinator = client(app, await app.fixtures.token(coordUser));
    const flt = `/v1/orgs/${org.id}/fleet`;
    const v = await manager.post(`${flt}/vehicles`, vehicleBody(n));
    expect(v.status, v.text).toBe(201);
    expect(v.body.data_sharing).toBe('appointments');
    // A service record and a document (a PDF may be shared here: the fleet exception of GD-32).
    const docId = uuidv7();
    await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      await db
        .insertInto('vehicle.vehicle_service_records')
        .values({
          vehicle_id: v.body.id,
          service_date: '2026-05-01',
          service_system_node_id: n.system,
          description: 'Brake pads replaced',
          source_type: 'user_manual',
          verification_status: 'self_reported',
          created_by_type: 'organization',
          visibility: 'private',
        })
        .execute();
      await db
        .insertInto('vehicle.vehicle_documents')
        .values({
          id: docId,
          vehicle_id: v.body.id,
          document_type: 'registration',
          title: 'Registration card',
          media_asset_id: uuidv7(),
          uploaded_by: managerUser.id,
        })
        .execute();
    });
    const appt = await manager.post(`${flt}/appointments`, requestBody(provider, { vehicleId: v.body.id } as never, n));
    expect(appt.status, appt.text).toBe(201);
    const report = () => provider.c.get(`/v1/orgs/${provider.id}/provider/appointments/${appt.body.id}/pre-visit-report`);
    const shared = await report();
    expect(shared.status, shared.text).toBe(200);
    expect(shared.body.relevant_history_summary).toEqual(expect.any(String));
    expect(shared.body.shared_documents).toEqual([
      { document_id: docId, document_type: 'registration', title: 'Registration card', expires_at: null, download_url: null },
    ]);
    const told = await events(app, { aggregateId: appt.body.id, type: 'fleet.vehicle_data.shared' });
    expect(told[0]!.payload).toMatchObject({ fleet_organization_id: org.id, document_count: 1 });

    // Only owners and managers decide; personal vehicles have no such field.
    expect((await coordinator.patch(`${flt}/vehicles/${v.body.id}`, { data_sharing: 'private' }, v.body.version)).status).toBe(422);
    const me = await person();
    const own = await me.c.post('/v1/me/vehicles', vehicleBody(n));
    expect((await me.c.patch(`/v1/me/vehicles/${own.body.id}`, { data_sharing: 'private' }, own.body.version)).status).toBe(422);
    const priv = await manager.patch(`${flt}/vehicles/${v.body.id}`, { data_sharing: 'private' }, v.body.version);
    expect(priv.status, priv.text).toBe(200);
    expect(priv.body.data_sharing).toBe('private');
    // Marking the vehicle private stops sharing at once.
    const hidden = await report();
    expect(hidden.body.relevant_history_summary).toBeNull();
    expect(hidden.body.previous_related_repairs).toBeNull();
    expect(hidden.body.shared_documents).toBeNull();
    const rows = await query<{ fleet_data_shared: boolean }>(
      app,
      sql`SELECT fleet_data_shared FROM appointment.pre_visit_reports WHERE appointment_id = ${appt.body.id}::uuid`,
    );
    expect(rows[0]!.fleet_data_shared).toBe(true);
  });
});
