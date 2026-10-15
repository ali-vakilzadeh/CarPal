// S8 fleets (40 §18; MVP Module K): the profile activates a draft fleet,
// drivers reach only the vehicles assigned to them (SEC-AZ-7), a driver's
// issue opens a repair request, approvals are never decided by their
// requester, fleet appointments carry an approved approval while the
// workflow is on, a provider's cost estimate above the threshold opens a cost
// approval, preferred partners, reports, the dashboard, CSV exports (W8) and
// vehicle imports (W7).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestOrg, TestUser } from '#libs/testing/index.js';
import { MediaHarness, taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, newId, type Client } from './s5-support.js';
import { flush, publishedProvider, type PublishedOrg } from './s6-support.js';
import { window } from './s7-support.js';
import { events, query } from './s8-support.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
let media: MediaHarness;
let n: Nodes;

interface Fleet {
  org: TestOrg;
  flt: string;
  owner: Client;
  ownerToken: string;
  manager: Client;
  coordinator: Client;
  coordinatorUser: TestUser;
  driver: Client;
  driverUser: TestUser;
}

/** A fleet on fleet_20 with an owner, a manager, a coordinator and a driver. */
async function fleet(o: { status?: 'draft' | 'active' } = {}): Promise<Fleet> {
  const org = await app.fixtures.org('fleet', { status: o.status ?? 'active' });
  await app.fixtures.subscription(org, 'fleet_20');
  const member = async (role: string) => {
    const user = await app.fixtures.user();
    await app.fixtures.member(user, org, role);
    const token = await app.fixtures.token(user);
    return { user, token, c: client(app, token) };
  };
  const [owner, manager, coordinator, driver] = await Promise.all([
    member('fleet_owner'),
    member('fleet_manager'),
    member('fleet_maintenance_coordinator'),
    member('fleet_driver'),
  ]);
  return {
    org,
    flt: `/v1/orgs/${org.id}/fleet`,
    owner: owner.c,
    ownerToken: owner.token,
    manager: manager.c,
    coordinator: coordinator.c,
    coordinatorUser: coordinator.user,
    driver: driver.c,
    driverUser: driver.user,
  };
}

const profile = (o: Json = {}) => ({
  fleet_size: 12,
  approval_workflow_enabled: true,
  cost_approval_threshold_amount: '500',
  preferred_provider_mode: 'preferred',
  reporting_currency: 'IRR',
  ...o,
});

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  media = await MediaHarness.start(app);
  n = await taxonomyNodes(app);
}, 60_000);

afterAll(async () => {
  await media?.close();
  await app?.close();
});

describe('fleet profile and dashboard', () => {
  it('the first profile save activates a draft fleet; later saves need If-Match', async () => {
    const f = await fleet({ status: 'draft' });
    expect((await f.owner.get(`${f.flt}/profile`)).status).toBe(404);
    const created = await f.owner.put(`${f.flt}/profile`, profile(), { 'idempotency-key': newId() });
    expect(created.status, created.text).toBe(200);
    expect(created.body).toMatchObject({
      organization_id: f.org.id,
      approval_workflow_enabled: true,
      cost_approval_threshold_amount: '500',
      status: 'active',
    });
    const org = await query<{ status: string }>(app, sql`SELECT status FROM organization.organizations WHERE id = ${f.org.id}::uuid`);
    expect(org[0]!.status).toBe('active');
    expect((await f.owner.put(`${f.flt}/profile`, profile({ fleet_size: 14 }))).status).toBe(428);
    const upd = await f.owner.put(`${f.flt}/profile`, profile({ fleet_size: 14 }), { 'if-match': `"v${created.body.version}"` });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body.fleet_size).toBe(14);
    // Coordinators read but do not write the profile (F+).
    expect((await f.coordinator.get(`${f.flt}/profile`)).status).toBe(200);
    expect((await f.coordinator.put(`${f.flt}/profile`, profile(), { 'if-match': `"v${upd.body.version}"` })).status).toBe(404);
  });

  it('enabling the approval workflow needs the entitlement', async () => {
    // A fleet without a subscription has no entitlements at all.
    const org = await app.fixtures.org('fleet');
    const user = await app.fixtures.user();
    await app.fixtures.member(user, org, 'fleet_owner');
    const c = client(app, await app.fixtures.token(user));
    const res = await c.put(`/v1/orgs/${org.id}/fleet/profile`, profile(), { 'idempotency-key': newId() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ENTITLEMENT_REQUIRED');
    expect(
      (await c.put(`/v1/orgs/${org.id}/fleet/profile`, profile({ approval_workflow_enabled: false }), { 'idempotency-key': newId() }))
        .status,
    ).toBe(200);
  });
});

describe('driver assignments (SEC-AZ-7)', () => {
  it('a driver reaches only assigned vehicles; one active assignment per vehicle', async () => {
    const f = await fleet();
    const [v1, v2] = await Promise.all([app.fixtures.vehicle(f.org, n), app.fixtures.vehicle(f.org, n)]);
    expect((await f.driver.get(`${f.flt}/vehicles`)).body.items).toEqual([]);
    expect((await f.driver.get(`${f.flt}/vehicles/${v1}`)).status).toBe(404);
    // Only fleet_driver members can be assigned.
    expect(
      (
        await f.coordinator.put(
          `${f.flt}/vehicles/${v1}/assignment`,
          { driver_user_id: f.coordinatorUser.id },
          { 'idempotency-key': newId() },
        )
      ).status,
    ).toBe(422);
    const set = await f.coordinator.put(
      `${f.flt}/vehicles/${v1}/assignment`,
      { driver_user_id: f.driverUser.id },
      { 'idempotency-key': newId() },
    );
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({ vehicle_id: v1, driver_user_id: f.driverUser.id, status: 'active', driver_display: 'Driver' });
    const list = await f.driver.get(`${f.flt}/vehicles`);
    expect(list.body.items.map((v: Json) => v.id)).toEqual([v1]);
    expect((await f.driver.get(`${f.flt}/vehicles/${v1}`)).status).toBe(200);
    expect((await f.driver.get(`${f.flt}/vehicles/${v2}`)).status).toBe(404);
    // Fleet staff see the assigned driver on the vehicle.
    expect((await f.coordinator.get(`${f.flt}/vehicles/${v1}`)).body.assigned_driver).toMatchObject({ user_id: f.driverUser.id });
    const listed = await f.coordinator.get(`${f.flt}/assignments?status=active`);
    expect(listed.body.items.map((x: Json) => x.vehicle_id)).toEqual([v1]);
    expect((await f.coordinator.del(`${f.flt}/vehicles/${v1}/assignment`)).status).toBe(200);
    expect((await f.coordinator.del(`${f.flt}/vehicles/${v1}/assignment`)).status).toBe(404);
    expect((await f.driver.get(`${f.flt}/vehicles/${v1}`)).status).toBe(404);
  });
});

describe('approvals (MVP Module K)', () => {
  it("a driver's issue opens a repair request; the requester never approves; the decision reaches the issue", async () => {
    const f = await fleet();
    await f.owner.put(`${f.flt}/profile`, profile(), { 'idempotency-key': newId() });
    const v = await app.fixtures.vehicle(f.org, n);
    await f.coordinator.put(`${f.flt}/vehicles/${v}/assignment`, { driver_user_id: f.driverUser.id }, { 'idempotency-key': newId() });
    const issue = await f.driver.post(`${f.flt}/vehicles/${v}/issues`, {
      title: 'Brakes squeal',
      description: 'Squealing brakes at low speed every morning.',
      content_locale: 'en',
      urgency_level: 'medium',
    });
    expect(issue.status, issue.text).toBe(201);
    expect(issue.body.fleet_approval_status).toBe('pending');
    const approvals = await f.manager.get(`${f.flt}/approvals?status=pending`);
    const a = approvals.body.items.find((x: Json) => x.related_issue_id === issue.body.id);
    expect(a).toMatchObject({ approval_type: 'repair_request', vehicle_id: v, status: 'pending', selected_provider: null });
    expect((await events(app, { aggregateId: a.id })).map((e) => e.type)).toEqual(['fleet.approval.requested']);
    // Drivers and coordinators do not decide (F+).
    expect((await f.coordinator.post(`${f.flt}/approvals/${a.id}/decision`, { decision: 'approved' })).status).toBe(404);
    const ok = await f.manager.post(`${f.flt}/approvals/${a.id}/decision`, { decision: 'approved', decision_reason: 'Go ahead' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approver_display: expect.any(String) });
    expect((await f.manager.post(`${f.flt}/approvals/${a.id}/decision`, { decision: 'rejected' })).status).toBe(409);
    const after = await f.coordinator.get(`${f.flt}/vehicles/${v}/issues/${issue.body.id}`);
    expect(after.body.fleet_approval_status).toBe('approved');
    expect((await events(app, { aggregateId: a.id })).map((e) => e.type)).toEqual(['fleet.approval.requested', 'fleet.approval.decided']);
    // An owner's own request cannot be approved by that owner (403 SELF_APPROVAL_FORBIDDEN).
    expect((await f.owner.post(`${f.flt}/approvals`, { approval_type: 'cost_estimate', vehicle_id: v })).status).toBe(422);
    const own = await f.owner.post(`${f.flt}/approvals`, {
      approval_type: 'cost_estimate',
      vehicle_id: v,
      cost_estimate: { amount: '800', currency: 'IRR' },
    });
    expect(own.status, own.text).toBe(201);
    const self = await f.owner.post(`${f.flt}/approvals/${own.body.id}/decision`, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      (
        await f.manager.post(`${f.flt}/approvals/${own.body.id}/decision`, {
          decision: 'needs_more_info',
          decision_reason: 'Which garage?',
        })
      ).body.status,
    ).toBe('needs_more_info');
  });

  it('fleet appointments carry an approved approval while the workflow is on; cost estimates above the threshold open a cost approval', async () => {
    const f = await fleet();
    await f.owner.put(`${f.flt}/profile`, profile(), { 'idempotency-key': newId() });
    const p: PublishedOrg = await publishedProvider(app, n, { name: `Fleet shop ${newId().slice(-6)}` });
    const v = await app.fixtures.vehicle(f.org, n);
    const body = (o: Json = {}) => ({
      provider_organization_id: p.id,
      provider_location_id: p.locationId,
      vehicle_id: v,
      source: 'fleet_workflow',
      appointment_type: 'repair',
      service_mode: 'in_shop',
      service_system_node_id: n.system,
      description: 'Brake pads worn on the front axle.',
      content_locale: 'en',
      urgency_level: 'medium',
      time_windows: [window()],
      submit: true,
      ...o,
    });
    const without = await f.coordinator.post(`${f.flt}/appointments`, body());
    expect(without.status).toBe(422);
    const ap = await f.coordinator.post(`${f.flt}/approvals`, {
      approval_type: 'provider_selection',
      vehicle_id: v,
      selected_provider_organization_id: p.id,
    });
    expect(ap.status, ap.text).toBe(201);
    expect((await f.coordinator.post(`${f.flt}/appointments`, body({ fleet_approval_id: ap.body.id }))).status).toBe(422);
    await f.manager.post(`${f.flt}/approvals/${ap.body.id}/decision`, { decision: 'approved' });
    const appt = await f.coordinator.post(`${f.flt}/appointments`, body({ fleet_approval_id: ap.body.id }));
    expect(appt.status, appt.text).toBe(201);
    expect((await f.manager.get(`${f.flt}/approvals/${ap.body.id}`)).body.related_appointment_id).toBe(appt.body.id);
    // The approval is used up; owners and managers book without one.
    expect((await f.coordinator.post(`${f.flt}/appointments`, body({ fleet_approval_id: ap.body.id }))).status).toBe(422);
    expect((await f.manager.post(`${f.flt}/appointments`, body())).status).toBe(201);
    // The provider estimates above the fleet threshold (500 IRR): a cost approval opens for the fleet.
    const prov = await p.c.get(`/v1/orgs/${p.id}/provider/appointments/${appt.body.id}`);
    const est = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/orgs/${p.id}/provider/appointments/${appt.body.id}`,
      token: p.token,
      headers: { 'if-match': `"v${prov.body.version}"` },
      body: { cost_estimate: { amount: '900', currency: 'IRR' } },
    });
    expect(est.status, est.text).toBe(200);
    await flush(app, media.worker);
    const costs = await f.manager.get(`${f.flt}/approvals?approval_type=cost_estimate`);
    expect(costs.body.items.find((x: Json) => x.related_appointment_id === appt.body.id)).toMatchObject({
      status: 'pending',
      cost_estimate: { amount: '900', currency: 'IRR' },
    });
  });
});

describe('partners, reports, exports and imports', () => {
  it('preferred partners: provider orgs only, one per scope; updates need If-Match', async () => {
    const f = await fleet();
    const p = await publishedProvider(app, n, { name: `Partner ${newId().slice(-6)}` });
    const created = await f.owner.post(`${f.flt}/partners`, {
      partner_organization_id: p.id,
      relationship_type: 'preferred_provider',
      service_system_node_id: n.system,
      priority: 1,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ partner: { id: p.id }, status: 'active' });
    expect(
      (
        await f.owner.post(`${f.flt}/partners`, {
          partner_organization_id: p.id,
          relationship_type: 'preferred_provider',
          service_system_node_id: n.system,
          priority: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (await f.owner.post(`${f.flt}/partners`, { partner_organization_id: p.id, relationship_type: 'approved_vendor', priority: 2 }))
        .status,
    ).toBe(422);
    expect(
      (
        await f.owner.post(`${f.flt}/partners`, {
          partner_organization_id: p.id,
          relationship_type: 'preferred_provider',
          part_category_node_id: n.partCategory,
          priority: 2,
        })
      ).status,
    ).toBe(422);
    const upd = await f.owner.patch(`${f.flt}/partners/${created.body.id}`, { priority: 3, status: 'inactive' }, created.body.version);
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body).toMatchObject({ priority: 3, status: 'inactive' });
    expect((await f.coordinator.get(`${f.flt}/partners`)).body.items).toHaveLength(1);
  });

  it('searching as a fleet: preferred_partners_only keeps its preferred providers, which also get the +5 bonus reason', async () => {
    const f = await fleet();
    const [p, q] = [
      await publishedProvider(app, n, { name: `Preferred ${newId().slice(-6)}` }),
      await publishedProvider(app, n, { name: `Other ${newId().slice(-6)}` }),
    ];
    await f.owner.post(`${f.flt}/partners`, { partner_organization_id: p.id, relationship_type: 'preferred_provider', priority: 1 });
    await flush(app, media.worker);
    const span = 0.05;
    const location = (pt: { lat: number; lng: number }) => ({
      mode: 'map_center',
      viewport: { center: pt, zoom: 13, bbox: { south: pt.lat - span, west: pt.lng - span, north: pt.lat + span, east: pt.lng + span } },
    });
    const search = (pt: { lat: number; lng: number }, filters: Json = {}) =>
      f.coordinator.post('/v1/search', {
        search_mode: 'all',
        entry_point: 'search_box',
        as_organization_id: f.org.id,
        location: location(pt),
        filters,
      });
    const only = await search(p.point, { preferred_partners_only: true });
    expect(only.status, only.text).toBe(200);
    expect((only.body.results as Json[]).map((r) => r.organization.id)).toEqual([p.id]);
    expect((await search(q.point, { preferred_partners_only: true })).body.results.map((r: Json) => r.organization.id)).not.toContain(q.id);
    const all = await search(p.point);
    const card = (all.body.results as Json[]).find((r) => r.organization.id === p.id)!;
    expect(card.reasons.map((x: Json) => x.reason_type)).toContain('user_preference');
  });

  it('reports, the dashboard and a CSV export (W8) from the fleet service history', async () => {
    const f = await fleet();
    await f.owner.put(`${f.flt}/profile`, profile(), { 'idempotency-key': newId() });
    const [v1, v2] = await Promise.all([app.fixtures.vehicle(f.org, n), app.fixtures.vehicle(f.org, n)]);
    const today = new Date().toISOString().slice(0, 10);
    for (const [v, amount] of [
      [v1, '120'],
      [v1, '80'],
      [v2, '50'],
    ] as const) {
      const r = await f.coordinator.post(`${f.flt}/vehicles/${v}/service-records`, {
        service_date: today,
        service_system_node_id: n.system,
        cost: { amount, currency: 'IRR' },
        source_type: 'user_manual',
        visibility: 'fleet',
      });
      expect(r.status, r.text).toBe(201);
    }
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const costs = await f.manager.get(`${f.flt}/reports/costs?from=${from}&to=${today}`);
    expect(costs.status, costs.text).toBe(200);
    expect(costs.body).toMatchObject({ report_type: 'costs', group_by: 'vehicle', currency: 'IRR' });
    expect(costs.body.rows.map((r: Json) => [r.key, r.value, r.count])).toEqual([
      [v1, '200', 2],
      [v2, '50', 1],
    ]);
    const bySystem = await f.manager.get(`${f.flt}/reports/repair_frequency?from=${from}&to=${today}&group_by=service_system`);
    expect(bySystem.body.rows).toEqual([expect.objectContaining({ key: n.system, count: 3 })]);
    expect((await f.manager.get(`${f.flt}/reports/costs?from=${from}&to=${today}&group_by=symptom`)).status).toBe(422);
    expect((await f.manager.get(`${f.flt}/reports/costs?from=2024-01-01&to=${today}`)).status).toBe(422);
    const dash = await f.manager.get(`${f.flt}/dashboard`);
    expect(dash.status, dash.text).toBe(200);
    expect(dash.body).toMatchObject({ total_vehicles: 2, month_spend: { amount: '250', currency: 'IRR' } });
    expect(dash.body.most_repaired_vehicles[0]).toMatchObject({ vehicle_id: v1, repairs: 2 });
    // Export: queued → W8 → completed → a 5-minute download URL.
    const job = await f.manager.post(`${f.flt}/exports`, { export_type: 'cost_report', format: 'csv', filters: { from, to: today } });
    expect(job.status, job.text).toBe(202);
    const list0 = await f.manager.get(`${f.flt}/exports`);
    const exp = list0.body.items[0];
    await app.infra.jobs.idle();
    const list = await f.manager.get(`${f.flt}/exports`);
    expect(list.body.items[0]).toMatchObject({ id: exp.id, export_type: 'cost_report', status: 'completed' });
    const dl = await f.manager.post(`${f.flt}/exports/${exp.id}/download`);
    expect(dl.status, dl.text).toBe(200);
    const csv = await (await fetch(media.local(dl.body.url))).text();
    expect(csv.split('\r\n')[0]).toBe('key,label,value,count,currency');
    expect(csv).toContain(`${v1},`);
    // Drivers do not export (F+, FR).
    expect((await f.driver.post(`${f.flt}/exports`, { export_type: 'vehicle_list', format: 'csv' })).status).toBe(404);
  });

  it('a CSV vehicle import (W7) creates valid rows and reports the others', async () => {
    const f = await fleet();
    const csv = Buffer.from(
      `brand,model,year,plate\r\n${n.brand},${n.model},2019,12A345\r\n${n.brand},${n.model},1800,X\r\n${n.brand},${n.otherModel},2020,Y\r\n`,
    );
    const asset = await media.upload(f.ownerToken, {
      owner: { type: 'organization', id: f.org.id },
      purpose: 'fleet_import_csv',
      mime: 'text/csv',
      bytes: csv,
    });
    const mapping = [
      { column: 'brand', field: 'brand_node_id' },
      { column: 'model', field: 'model_node_id' },
      { column: 'year', field: 'year' },
      { column: 'plate', field: 'license_plate' },
    ];
    expect(
      (
        await f.owner.post(`${f.flt}/vehicle-imports`, {
          source_media_asset_id: asset.id,
          column_mapping: [{ column: 'brand', field: 'colour' }],
        })
      ).status,
    ).toBe(422);
    const job = await f.owner.post(`${f.flt}/vehicle-imports`, { source_media_asset_id: asset.id, column_mapping: mapping });
    expect(job.status, job.text).toBe(202);
    await media.drain();
    const batches = await f.owner.get(`${f.flt}/vehicle-imports`);
    expect(batches.body.items[0]).toMatchObject({
      status: 'completed_with_errors',
      total_rows: 3,
      created_count: 1,
      error_count: 2,
      error_report_available: true,
    });
    const report = await f.owner.post(`${f.flt}/vehicle-imports/${batches.body.items[0].id}/error-report`);
    expect(report.status, report.text).toBe(200);
    const text = await (await fetch(media.local(report.body.url))).text();
    expect(text.split('\r\n')[0]).toBe('line,field,code,brand,model,year,plate');
    const vehicles = await f.owner.get(`${f.flt}/vehicles`);
    expect(vehicles.body.items.map((v: Json) => v.license_plate)).toEqual(['12A345']);
  });
});
