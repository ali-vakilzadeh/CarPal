// Contract sweep resolvers: vehicles and service history (40 §12) on both
// scopes of the {V} alias — the user's own vehicles (/v1/me/vehicles) and a
// fleet's vehicles (/v1/orgs/{org_id}/fleet/vehicles) — plus the vehicle
// transfers of GD-33 ({VT}) and the provider's service records.
import type { Route } from '#libs/contract/index.js';
import { expect } from 'vitest';
import { vehicleBody } from '../../s5-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

const issueBody = (o: Json = {}) => ({
  title: 'Brake noise',
  description: 'Squeal when braking at low speed.',
  content_locale: 'en',
  urgency_level: 'medium',
  ...o,
});
const recordBody = (h: Harness, o: Json = {}) => ({
  service_date: '2026-09-01',
  service_system_node_id: h.n.system,
  source_type: 'user_manual',
  visibility: 'private',
  ...o,
});
const reminderBody = { reminder_type: 'oil', title: 'Oil change', priority: 'low', due_by_mileage_km: 90_000 };

const transfers = (scope: Route['scope'], as: Actor) =>
  scope === 'fleet' ? `/v1/orgs/${as.org!.id}/fleet/vehicle-transfers` : '/v1/me/vehicle-transfers';

/** A caller on the route's scope (a user, or a fleet owner with a plan). */
async function caller(h: Harness, scope: Route['scope']): Promise<Actor> {
  if (scope !== 'fleet') return h.user();
  const as = await h.member('fleet');
  await h.fx.subscription(as.org!, 'fleet_20');
  return as;
}

/** A vehicle with a VIN, created through vehicles.create on the owner's scope. */
async function withVin(h: Harness, owner: Actor, scope: Route['scope']): Promise<{ vin: string; vehicleId: string }> {
  const vin = h.vin();
  const base = scope === 'fleet' ? `/v1/orgs/${owner.org!.id}/fleet/vehicles` : '/v1/me/vehicles';
  const v = ok(await owner.c.post(base, vehicleBody(h.n, { vin })), 'vehicle with VIN');
  return { vin, vehicleId: v.id as string };
}

/** A pending transfer: the buyer (route scope) asks for a vehicle of an owner (ownerScope). */
async function transfer(h: Harness, buyerScope: Route['scope'], ownerScope: Route['scope']) {
  const owner = await caller(h, ownerScope);
  const { vin, vehicleId } = await withVin(h, owner, ownerScope);
  const buyer = await caller(h, buyerScope);
  const t = ok(await buyer.c.post(transfers(buyerScope, buyer), { vin, message: 'I bought it last week.' }), 'transfer request');
  return { owner, buyer, vehicleId, transferId: t.id as string };
}

export const resolvers: Resolvers = {
  'vehicles.list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return { as: o.as, query: { status: 'active' }, check: (res) => expect(res.body.items.map((v: Json) => v.id)).toContain(o.vehicleId) };
  },
  'vehicles.create': async (h, route) => {
    const as = await caller(h, route.scope);
    return {
      as,
      body: vehicleBody(h.n, { vin: h.vin(), nickname: 'Daily' }),
      // SEC-OUT-2: the response carries vin_last4 / vin_present, never the VIN (projection scan).
      check: (res) => expect(res.body).toMatchObject({ vin_present: true }),
    };
  },
  'vehicles.get': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return { as: o.as, params: { vehicle_id: o.vehicleId } };
  },
  'vehicles.update': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      version: 1,
      body: route.scope === 'fleet' ? { nickname: 'Van 7', data_sharing: 'private' } : { nickname: 'Daily' },
    };
  },
  'vehicles.status_change': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return { as: o.as, params: { vehicle_id: o.vehicleId }, body: { status: 'in_repair', reason: 'At the garage' } };
  },
  'vehicles.vin_reveal': async (h, route) => {
    const as = await caller(h, route.scope);
    const { vin, vehicleId } = await withVin(h, as, route.scope);
    return { as, params: { vehicle_id: vehicleId }, check: (res) => expect(res.body).toEqual({ vin }) };
  },
  'vehicles.transfer_request': async (h, route) => {
    const owner = await h.user();
    const { vin } = await withVin(h, owner, 'me');
    return {
      as: await caller(h, route.scope),
      body: { vin, message: 'I bought it last week.' },
      bola: 'a transfer request names a VIN owned by someone else by design (GD-33); the owner is never disclosed (projection check)',
      check: (res) => {
        expect(res.body).toMatchObject({ direction: 'outgoing', vehicle_id: null, requester_display: null, status: 'pending' });
        expect(res.text).not.toContain(owner.user.id);
      },
    };
  },
  'vehicles.transfers_list': async (h, route) => {
    const t = await transfer(h, route.scope, 'me');
    return {
      as: t.buyer,
      query: { direction: 'outgoing' },
      check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(t.transferId),
    };
  },
  'vehicles.transfer_decide': async (h, route) => {
    const t = await transfer(h, 'me', route.scope);
    // Only the owner decides: neither the buyer nor anyone else can (404).
    const attackers = route.scope === 'fleet' ? [await h.rival('fleet', 'fleet_owner')] : [await h.stranger(), t.buyer];
    return { as: t.owner, params: { transfer_id: t.transferId }, body: { decision: 'reject' }, bola: { attackers } };
  },
  'vehicles.transfer_cancel': async (h, route) => {
    const t = await transfer(h, route.scope, 'me');
    // Only the requester cancels: the owner (who decides instead) and strangers get 404.
    const attackers = route.scope === 'fleet' ? [await h.rival('fleet', 'fleet_owner')] : [await h.stranger(), t.owner];
    return { as: t.buyer, params: { transfer_id: t.transferId }, bola: { attackers } };
  },
  'vehicles.vin_decode': async (h, route) => {
    const as = await caller(h, route.scope);
    const { vehicleId } = await withVin(h, as, route.scope);
    return { as, params: { vehicle_id: vehicleId }, check: (res) => expect(res.body.suggested).not.toHaveProperty('vin') };
  },
  'vehicles.status_history': async (h, route) => {
    const o = await h.vehicleOwner(route);
    ok(await o.as.c.post(`${o.base}/status`, { status: 'inactive' }), 'status change');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      check: (res) => expect(res.body.items.map((x: Json) => x.new_status)).toContain('inactive'),
    };
  },
  'vehicles.mileage_list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    ok(
      await o.as.c.post(`${o.base}/mileage`, { mileage_km: 50_000, recorded_at: new Date(Date.now() - 3_600_000).toISOString() }),
      'mileage',
    );
    return { as: o.as, params: { vehicle_id: o.vehicleId } };
  },
  'vehicles.mileage_add': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      body: { mileage_km: 50_000, recorded_at: new Date(Date.now() - 3_600_000).toISOString() },
    };
  },
  'vehicles.documents_list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return { as: o.as, params: { vehicle_id: o.vehicleId } };
  },
  'vehicles.document_create': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const pdf = await h.upload(o.as, 'vehicle_document', { mime: 'application/pdf' });
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      body: {
        document_type: 'insurance',
        title: 'Insurance 2026',
        media_asset_id: pdf.id,
        visibility: 'private',
        issued_at: '2026-01-01',
        expires_at: '2026-12-31',
      },
      bodyRefs: true,
    };
  },
  'vehicles.document_update': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const pdf = await h.upload(o.as, 'vehicle_document', { mime: 'application/pdf' });
    const doc = ok(
      await o.as.c.post(`${o.base}/documents`, {
        document_type: 'insurance',
        title: 'Insurance 2026',
        media_asset_id: pdf.id,
        visibility: 'private',
      }),
      'document',
    );
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId, document_id: doc.id as string },
      version: doc.version as number,
      body: { title: 'Insurance 2027' },
    };
  },
  'vehicles.document_delete': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const pdf = await h.upload(o.as, 'vehicle_document', { mime: 'application/pdf' });
    const doc = ok(
      await o.as.c.post(`${o.base}/documents`, {
        document_type: 'insurance',
        title: 'Insurance 2026',
        media_asset_id: pdf.id,
        visibility: 'private',
      }),
      'document',
    );
    return { as: o.as, params: { vehicle_id: o.vehicleId, document_id: doc.id as string } };
  },
  'service_records.list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      query: { from: '2026-09-01', to: '2026-09-01' },
      check: (res) => expect(res.body.items).toHaveLength(1),
    };
  },
  'service_records.create': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const provider = await h.member('provider');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId },
      body: recordBody(h, {
        provider_organization_id: provider.org!.id,
        service_task_node_id: h.n.task,
        parts_used: [{ name: 'Control arm', quantity: 2 }],
        cost: { amount: '1250000', currency: 'IRR' },
        mileage_km: 81_000,
      }),
    };
  },
  'service_records.get': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    return { as: o.as, params: { vehicle_id: o.vehicleId, record_id: r.id as string } };
  },
  'service_records.update': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId, record_id: r.id as string },
      version: r.version as number,
      body: { description: 'Both control arms replaced' },
    };
  },
  'service_records.delete': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    return { as: o.as, params: { vehicle_id: o.vehicleId, record_id: r.id as string } };
  },
  'service_records.evidence_add': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    const invoice = await h.upload(o.as, 'service_evidence', { mime: 'application/pdf' });
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId, record_id: r.id as string },
      body: { evidence_type: 'invoice', media_asset_id: invoice.id },
      bodyRefs: true,
    };
  },
  'service_records.evidence_remove': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/service-records`, recordBody(h)), 'service record');
    const invoice = await h.upload(o.as, 'service_evidence', { mime: 'application/pdf' });
    const ev = ok(
      await o.as.c.post(`${o.base}/service-records/${r.id}/evidence`, { evidence_type: 'invoice', media_asset_id: invoice.id }),
      'evidence',
    );
    return { as: o.as, params: { vehicle_id: o.vehicleId, record_id: r.id as string, evidence_id: ev.id as string } };
  },
  'provider.service_record_create': async (h) => {
    const owner = await h.user();
    const vehicleId = await h.vehicle(owner);
    const provider = await h.member('provider', 'provider_staff');
    ok(
      await owner.c.post('/v1/me/consents', {
        consent_type: 'vehicle_data_sharing',
        policy_version: '2026-10',
        scope: { type: 'vehicle', id: vehicleId },
        granted_to: { type: 'organization', id: provider.org!.id },
      }),
      'consent',
    );
    return {
      as: provider,
      body: { vehicle_id: vehicleId, service_date: '2026-09-15', service_system_node_id: h.n.system, description: 'Brake pads' },
      // CNS: a provider without the owner's consent (unknown vehicles alike) gets 403 CONSENT_REQUIRED, never data.
      bodyRefs: true,
      bola: { attackers: [await h.rival('provider', 'provider_staff')], expect: [403] },
    };
  },
  'issues.list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    ok(await o.as.c.post(`${o.base}/issues`, issueBody()), 'issue');
    return { as: o.as, params: { vehicle_id: o.vehicleId }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'issues.create': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const photo = await h.upload(o.as, 'issue_photo');
    return { as: o.as, params: { vehicle_id: o.vehicleId }, body: issueBody({ media_ids: [photo.id] }), bodyRefs: true };
  },
  'issues.get': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const i = ok(await o.as.c.post(`${o.base}/issues`, issueBody()), 'issue');
    return { as: o.as, params: { vehicle_id: o.vehicleId, issue_id: i.id as string } };
  },
  'issues.update': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const i = ok(await o.as.c.post(`${o.base}/issues`, issueBody()), 'issue');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId, issue_id: i.id as string },
      version: i.version as number,
      body: { urgency_level: 'high' },
    };
  },
  'issues.status_change': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const i = ok(await o.as.c.post(`${o.base}/issues`, issueBody()), 'issue');
    return { as: o.as, params: { vehicle_id: o.vehicleId, issue_id: i.id as string }, body: { status: 'investigating' } };
  },
  'reminders.list': async (h, route) => {
    const o = await h.vehicleOwner(route);
    ok(await o.as.c.post(`${o.base}/reminders`, reminderBody), 'reminder');
    return { as: o.as, params: { vehicle_id: o.vehicleId }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'reminders.create': async (h, route) => {
    const o = await h.vehicleOwner(route);
    return { as: o.as, params: { vehicle_id: o.vehicleId }, body: reminderBody };
  },
  'reminders.update': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/reminders`, reminderBody), 'reminder');
    return {
      as: o.as,
      params: { vehicle_id: o.vehicleId, reminder_id: r.id as string },
      version: r.version as number,
      body: { snoozed_until: '2026-12-01' },
    };
  },
  'reminders.delete': async (h, route) => {
    const o = await h.vehicleOwner(route);
    const r = ok(await o.as.c.post(`${o.base}/reminders`, reminderBody), 'reminder');
    return { as: o.as, params: { vehicle_id: o.vehicleId, reminder_id: r.id as string } };
  },
};
