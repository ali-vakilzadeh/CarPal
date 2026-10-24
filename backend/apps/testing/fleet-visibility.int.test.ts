// S9c fleet visibility (SEC-AZ-7): organization-wide fleet roles (owner,
// manager, maintenance coordinator, viewer) see the whole fleet; a fleet
// driver sees only the vehicles assigned to them — also where a record is
// reached without a vehicle in the path (media by id, AI records by id) and
// on the status history, which lacked DRV until S9c.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok, Harness, type Actor, type Json } from './contract/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await Harness.start();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface Fleet {
  owner: Actor;
  coordinator: Actor;
  viewer: Actor;
  driver: Actor;
  flt: string;
  /** Assigned to the driver. */
  mine: string;
  /** Not assigned to the driver. */
  other: string;
}

async function fleet(): Promise<Fleet> {
  const owner = await h.member('fleet');
  await h.fx.subscription(owner.org!, 'fleet_50');
  const [coordinator, viewer, driver] = await Promise.all([
    h.colleague(owner, 'fleet_maintenance_coordinator'),
    h.colleague(owner, 'fleet_viewer'),
    h.colleague(owner, 'fleet_driver'),
  ]);
  const [mine, other] = await Promise.all([h.vehicle(owner), h.vehicle(owner)]);
  const flt = `/v1/orgs/${owner.org!.id}/fleet`;
  ok(await coordinator.c.put(`${flt}/vehicles/${mine}/assignment`, { driver_user_id: driver.user.id }), 'assignment');
  return { owner, coordinator, viewer, driver, flt, mine, other };
}

/** A fleet-owned photo attached to a fleet vehicle by the coordinator. */
async function vehiclePhoto(f: Fleet, vehicleId: string): Promise<string> {
  const photo = await h.upload(f.coordinator, 'vehicle_photo');
  ok(
    await f.coordinator.c.post('/v1/media/attachments', {
      media_asset_id: photo.id,
      attached_to: { type: 'vehicle', id: vehicleId },
      role: 'gallery',
      display_order: 0,
    }),
    'attach',
  );
  return photo.id as string;
}

describe('fleet drivers see only assigned vehicles (SEC-AZ-7)', () => {
  it('status history: drivers on assigned vehicles only, organization-wide roles on every vehicle', async () => {
    const f = await fleet();
    expect((await f.driver.c.get(`${f.flt}/vehicles/${f.mine}/status-history`)).status).toBe(200);
    const denied = await f.driver.c.get(`${f.flt}/vehicles/${f.other}/status-history`);
    expect([denied.status, denied.body.code]).toEqual([404, 'NOT_FOUND']);
    for (const a of [f.owner, f.coordinator, f.viewer])
      expect((await a.c.get(`${f.flt}/vehicles/${f.other}/status-history`)).status).toBe(200);
  });

  it('fleet media: drivers read their own uploads and the media of assigned vehicles, change only their own uploads', async () => {
    const f = await fleet();
    const [onMine, onOther] = await Promise.all([vehiclePhoto(f, f.mine), vehiclePhoto(f, f.other)]);
    const own = (await h.upload(f.driver, 'issue_photo')).id as string;

    expect((await f.driver.c.get(`/v1/media/${onMine}`)).status).toBe(200);
    expect((await f.driver.c.post(`/v1/media/${onMine}/download-url`, { variant: 'original' })).status).toBe(200);
    expect((await f.driver.c.get(`/v1/media/${own}`)).status).toBe(200);
    for (const res of [
      await f.driver.c.get(`/v1/media/${onOther}`),
      await f.driver.c.post(`/v1/media/${onOther}/download-url`, { variant: 'display' }),
      await f.driver.c.del(`/v1/media/${onMine}`),
    ])
      expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
    // Organization-wide roles see every vehicle's media.
    expect((await f.viewer.c.get(`/v1/media/${onOther}`)).status).toBe(200);
    expect((await f.coordinator.c.post(`/v1/media/${onOther}/download-url`, { variant: 'original' })).status).toBe(200);
    // The driver's access follows the assignment: once ended, the vehicle's media are gone too.
    ok(await f.coordinator.c.del(`${f.flt}/vehicles/${f.mine}/assignment`), 'end assignment');
    expect((await f.driver.c.get(`/v1/media/${onMine}`)).status).toBe(404);
    expect((await f.driver.c.get(`/v1/media/${own}`)).status).toBe(200);
  });

  it('fleet AI insights and suggestions are never shown to drivers, even about an assigned vehicle', async () => {
    const f = await fleet();
    const job = ok(
      await f.coordinator.c.post(`${f.flt}/vehicles/${f.mine}/ai/suggestions`, { kinds: ['maintenance_suggestion', 'vehicle_summary'] }),
      'vehicle suggestions',
    );
    await h.settle();
    const done = ok(await f.coordinator.c.get(`/v1/jobs/${job.id}`), 'job');
    expect(done.status).toBe('succeeded');
    const insightId = done.result.id as string;
    const listed = ok(await f.coordinator.c.get(`/v1/orgs/${f.owner.org!.id}/ai/suggestions`), 'suggestions');
    const suggestions = (listed.items as Json[]).filter((s) => s.insight_id === insightId);
    expect(suggestions.length).toBeGreaterThan(0);

    // Organization-wide roles read them (ORG(ANY)).
    expect((await f.viewer.c.get(`/v1/insights/${insightId}`)).status).toBe(200);
    expect((await f.viewer.c.get(`/v1/orgs/${f.owner.org!.id}/ai/suggestions`)).status).toBe(200);
    // Drivers: 404 on the list, the insight, its feedback and the suggestion decision.
    for (const res of [
      await f.driver.c.get(`/v1/orgs/${f.owner.org!.id}/ai/suggestions`),
      await f.driver.c.get(`/v1/insights/${insightId}`),
      await f.driver.c.post(`/v1/insights/${insightId}/feedback`, { feedback_type: 'rating', rating: 4 }),
      await f.driver.c.post(`/v1/ai/suggestions/${suggestions[0]!.id}/decision`, { decision: 'reject' }),
    ])
      expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
  });
});
