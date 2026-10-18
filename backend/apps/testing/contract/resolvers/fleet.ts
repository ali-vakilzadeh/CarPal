// Contract sweep resolvers: fleets (40 §18) — profile, dashboard, driver
// assignments (SEC-AZ-7), preferred partners, approvals (never decided by the
// requester), reports, CSV exports (W8) and vehicle imports (W7).
import { expect } from 'vitest';
import { sharedProvider } from '../domain.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

const profile = (o: Json = {}) => ({
  fleet_size: 12,
  approval_workflow_enabled: false,
  cost_approval_threshold_amount: '500',
  preferred_provider_mode: 'preferred',
  reporting_currency: 'IRR',
  ...o,
});
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** A fleet on fleet_20 and a member with `role` (default the owner). */
async function fleet(h: Harness, role = 'fleet_owner'): Promise<Actor> {
  const owner = await h.member('fleet');
  await h.fx.subscription(owner.org!, 'fleet_20');
  return role === 'fleet_owner' ? owner : h.colleague(owner, role);
}

const flt = (a: Actor) => `/v1/orgs/${a.org!.id}/fleet`;

async function withProfile(h: Harness): Promise<Actor> {
  const owner = await fleet(h);
  ok(await owner.c.put(`${flt(owner)}/profile`, profile()), 'fleet profile');
  return owner;
}

async function partner(h: Harness): Promise<{ owner: Actor; p: Json }> {
  const owner = await fleet(h);
  const prov = await sharedProvider(h);
  const p = ok(
    await owner.c.post(`${flt(owner)}/partners`, {
      partner_organization_id: prov.id,
      relationship_type: 'preferred_provider',
      service_system_node_id: h.n.system,
      priority: 1,
    }),
    'partner',
  );
  return { owner, p };
}

async function approval(h: Harness): Promise<{ owner: Actor; manager: Actor; a: Json }> {
  const owner = await fleet(h);
  const manager = await h.colleague(owner, 'fleet_manager');
  const v = await h.vehicle(owner);
  const a = ok(
    await owner.c.post(`${flt(owner)}/approvals`, {
      approval_type: 'cost_estimate',
      vehicle_id: v,
      cost_estimate: { amount: '800', currency: 'IRR' },
    }),
    'approval',
  );
  return { owner, manager, a };
}

async function exported(h: Harness): Promise<{ owner: Actor; exportId: string }> {
  const owner = await fleet(h);
  ok(await owner.c.post(`${flt(owner)}/exports`, { export_type: 'vehicle_list', format: 'csv' }), 'export');
  await h.infra.jobs.idle();
  const list = ok(await owner.c.get(`${flt(owner)}/exports`), 'exports');
  return { owner, exportId: (list.items as Json[])[0]!.id as string };
}

async function importFile(h: Harness, owner: Actor): Promise<string> {
  const csv = Buffer.from(`brand,model,year,plate\r\n${h.n.brand},${h.n.model},2019,12A345\r\n${h.n.brand},${h.n.model},1800,X\r\n`);
  return (await h.upload(owner, 'fleet_import_csv', { mime: 'text/csv', bytes: csv })).id as string;
}

const mapping = [
  { column: 'brand', field: 'brand_node_id' },
  { column: 'model', field: 'model_node_id' },
  { column: 'year', field: 'year' },
  { column: 'plate', field: 'license_plate' },
];

async function imported(h: Harness): Promise<{ owner: Actor; batchId: string }> {
  const owner = await fleet(h);
  ok(
    await owner.c.post(`${flt(owner)}/vehicle-imports`, { source_media_asset_id: await importFile(h, owner), column_mapping: mapping }),
    'import',
  );
  await h.infra.jobs.idle();
  const batches = ok(await owner.c.get(`${flt(owner)}/vehicle-imports`), 'imports');
  return { owner, batchId: (batches.items as Json[])[0]!.id as string };
}

export const resolvers: Resolvers = {
  'fleet.profile_get': async (h) => {
    const owner = await withProfile(h);
    return { as: await h.colleague(owner, 'fleet_viewer') };
  },
  'fleet.profile_put': async (h) => ({ as: await fleet(h), body: profile({ approval_workflow_enabled: true }) }),
  'fleet.dashboard': async (h) => {
    const owner = await withProfile(h);
    await h.vehicle(owner);
    return { as: await h.colleague(owner, 'fleet_maintenance_coordinator') };
  },
  'fleet.assignments_list': async (h) => {
    const coordinator = await fleet(h, 'fleet_maintenance_coordinator');
    const driver = await h.colleague(coordinator, 'fleet_driver');
    const v = await h.vehicle(coordinator);
    ok(await coordinator.c.put(`${flt(coordinator)}/vehicles/${v}/assignment`, { driver_user_id: driver.user.id }), 'assignment');
    return {
      as: coordinator,
      query: { status: 'active' },
      check: (res) => expect(res.body.items.map((x: Json) => x.vehicle_id)).toEqual([v]),
    };
  },
  'fleet.assignment_set': async (h) => {
    const coordinator = await fleet(h, 'fleet_maintenance_coordinator');
    const driver = await h.colleague(coordinator, 'fleet_driver');
    return { as: coordinator, params: { vehicle_id: await h.vehicle(coordinator) }, body: { driver_user_id: driver.user.id } };
  },
  'fleet.assignment_end': async (h) => {
    const coordinator = await fleet(h, 'fleet_maintenance_coordinator');
    const driver = await h.colleague(coordinator, 'fleet_driver');
    const v = await h.vehicle(coordinator);
    ok(await coordinator.c.put(`${flt(coordinator)}/vehicles/${v}/assignment`, { driver_user_id: driver.user.id }), 'assignment');
    return { as: coordinator, params: { vehicle_id: v } };
  },
  'fleet.partners_list': async (h) => {
    const { owner } = await partner(h);
    return { as: await h.colleague(owner, 'fleet_driver') };
  },
  'fleet.partner_create': async (h) => ({
    as: await fleet(h),
    body: {
      partner_organization_id: (await sharedProvider(h)).id,
      relationship_type: 'preferred_provider',
      service_system_node_id: h.n.system,
      priority: 1,
    },
    bola: 'names a published provider by design; the partner record belongs to the fleet from the path',
  }),
  'fleet.partner_update': async (h) => {
    const { owner, p } = await partner(h);
    return { as: owner, params: { partner_id: p.id as string }, version: p.version as number, body: { priority: 3, status: 'inactive' } };
  },
  'fleet.approvals_list': async (h) => {
    const { manager, a } = await approval(h);
    return { as: manager, query: { status: 'pending' }, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(a.id) };
  },
  'fleet.approval_create': async (h) => {
    const coordinator = await fleet(h, 'fleet_maintenance_coordinator');
    const v = await h.vehicle(coordinator);
    return {
      as: coordinator,
      body: { approval_type: 'cost_estimate', vehicle_id: v, cost_estimate: { amount: '800', currency: 'IRR' } },
      bodyRefs: true,
    };
  },
  'fleet.approval_get': async (h) => {
    const { manager, a } = await approval(h);
    return { as: manager, params: { approval_id: a.id as string } };
  },
  'fleet.approval_decide': async (h) => {
    const { owner, manager, a } = await approval(h);
    // The requester never decides their own approval (403 SELF_APPROVAL_FORBIDDEN).
    const self = await owner.c.post(`${flt(owner)}/approvals/${a.id}/decision`, { decision: 'approved' });
    expect(self.status).toBe(403);
    return { as: manager, params: { approval_id: a.id as string }, body: { decision: 'approved', decision_reason: 'Go ahead' } };
  },
  'fleet.report': async (h) => {
    const owner = await withProfile(h);
    return { as: owner, params: { report_type: 'costs' }, query: { from: daysAgo(30), to: today() } };
  },
  'fleet.export_create': async (h) => {
    const owner = await fleet(h);
    return {
      as: await h.colleague(owner, 'fleet_manager'),
      body: { export_type: 'cost_report', format: 'csv', filters: { from: daysAgo(30), to: today() } },
    };
  },
  'fleet.exports_list': async (h) => {
    const { owner } = await exported(h);
    return { as: owner };
  },
  'fleet.export_download': async (h) => {
    const { owner, exportId } = await exported(h);
    return { as: owner, params: { export_id: exportId } };
  },
  'fleet.import_create': async (h) => {
    const owner = await fleet(h);
    // SEC-AZ-4: another fleet on the same plan cannot import this fleet's file.
    return {
      as: owner,
      body: { source_media_asset_id: await importFile(h, owner), column_mapping: mapping },
      bola: { attackers: [await fleet(h)] },
    };
  },
  'fleet.imports_list': async (h) => {
    const { owner } = await imported(h);
    return { as: owner };
  },
  'fleet.import_error_report': async (h) => {
    const { owner, batchId } = await imported(h);
    return { as: owner, params: { batch_id: batchId } };
  },
};
