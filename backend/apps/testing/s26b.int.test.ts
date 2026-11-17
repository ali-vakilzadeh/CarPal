// S26b.T1 (contract 1.5.0; owner decision DQ-24 of 2026-11-16): the monthly odometer prompt. Voluntary: the owner can
// skip; readings are kept in historical order (recorded_at); personal active vehicles only (DQ-27).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VehicleOdometerPromptRule } from '#modules/vehicle/application/odometer-prompt-rule.js';
import { Harness, sql, type Actor, type Json } from './contract/harness.js';

let h: Harness;
let adm: Actor;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const rule = () => h.worker.get(VehicleOdometerPromptRule, { strict: false });

async function setRules(days: number) {
  await h.q(sql`UPDATE notification.notification_rules SET odometer_prompt_days = ${days}, digest_hour = 0 WHERE rule_set = 'default'`);
}
const restoreRules = () =>
  h.q(sql`UPDATE notification.notification_rules SET odometer_prompt_days = 30, digest_hour = 9 WHERE rule_set = 'default'`);
/** The newest reading of the vehicle is `days` old (created_at is immutable, so the cycle starts at a reading). */
async function aged(id: string, days: number) {
  const at = ago(days).toISOString();
  const upd = await h.q<{ id: string }>(sql`UPDATE vehicle.vehicle_mileage_logs SET recorded_at = ${at}::timestamptz
    WHERE vehicle_id = ${id}::uuid RETURNING id`);
  if (upd.length === 0)
    await h.q(sql`INSERT INTO vehicle.vehicle_mileage_logs (vehicle_id, mileage_km, recorded_at, source)
      VALUES (${id}::uuid, 1000, ${at}::timestamptz, 'user')`);
}
const prompts = async (id: string) =>
  (
    await h.q<{ n: string }>(sql`SELECT count(*) AS n FROM core.domain_event_outbox
    WHERE event_type = 'vehicle.odometer_prompt.due' AND aggregate_id = ${id}::uuid`)
  )[0]!.n;
const view = async (o: Actor, id: string) => (await o.c.get(`/v1/me/vehicles/${id}`)).body.odometer_prompt as Json;
const reading = (o: Actor, id: string, km: number, daysAgo: number) =>
  o.c.post(`/v1/me/vehicles/${id}/mileage`, { mileage_km: km, recorded_at: ago(daysAgo).toISOString() });

beforeAll(async () => {
  h = await Harness.start();
  adm = await h.staff('platform_admin');
  await setRules(30);
});
afterAll(async () => {
  await restoreRules();
  await h?.close();
});

describe('S26b monthly odometer prompt', () => {
  it('asks once when the newest reading (or the vehicle) is 30 days old, and not again within the cycle', async () => {
    const o = await h.user();
    const id = await h.vehicle(o);
    await rule().run();
    expect(await prompts(id)).toBe('0');
    expect(await view(o, id)).toEqual({ due: false, due_since: null });
    await aged(id, 31);
    await rule().run();
    expect(await prompts(id)).toBe('1');
    expect((await view(o, id)).due).toBe(true);
    await rule().run();
    expect(await prompts(id)).toBe('1');
    // The notice reaches the owner (in app; push), referencing the vehicle, in the service reminders category.
    await h.settle();
    const [n] = await h.q<{ category: string; reference_entity_id: string }>(sql`
      SELECT category, reference_entity_id FROM notification.notifications
      WHERE recipient_user_id = ${o.user.id}::uuid AND event_type = 'odometer_prompt'`);
    expect(n).toMatchObject({ category: 'service_reminders', reference_entity_id: id });
  });

  it('a skip writes no reading, closes the notice and moves the next prompt one interval ahead', async () => {
    const o = await h.user();
    const id = await h.vehicle(o);
    await aged(id, 40);
    await rule().run();
    await h.settle();
    const before = (await o.c.get(`/v1/me/vehicles/${id}/mileage`)).body.items.length;
    const res = await o.c.post(`/v1/me/vehicles/${id}/odometer-prompt/skip`);
    expect(res.status, res.text).toBe(200);
    expect(await view(o, id)).toEqual({ due: false, due_since: null });
    expect((await o.c.get(`/v1/me/vehicles/${id}/mileage`)).body.items.length).toBe(before);
    const [n] = await h.q<{ read_at: string | null }>(sql`SELECT read_at FROM notification.notifications
      WHERE recipient_user_id = ${o.user.id}::uuid AND event_type = 'odometer_prompt'`);
    expect(n!.read_at).not.toBeNull();
    // Idempotent, and no new prompt in the same cycle.
    expect((await o.c.post(`/v1/me/vehicles/${id}/odometer-prompt/skip`)).status).toBe(200);
    await rule().run();
    expect(await prompts(id)).toBe('1');
    // One interval later the cycle is over.
    await h.q(
      sql`UPDATE vehicle.odometer_prompt_state SET skipped_at = ${ago(31).toISOString()}::timestamptz WHERE vehicle_id = ${id}::uuid`,
    );
    await rule().run();
    expect(await prompts(id)).toBe('2');
  });

  it('a newest reading answers an open prompt; a back-dated older one does not', async () => {
    const o = await h.user();
    const id = await h.vehicle(o);
    expect((await reading(o, id, 50_000, 60)).status).toBe(201);
    await rule().run();
    expect(await prompts(id)).toBe('1');
    // Older than the newest reading: stored in order, the prompt stays open.
    expect((await reading(o, id, 49_000, 90)).status).toBe(201);
    expect((await view(o, id)).due).toBe(true);
    expect((await reading(o, id, 52_000, 0)).status).toBe(201);
    expect(await view(o, id)).toEqual({ due: false, due_since: null });
    await rule().run();
    expect(await prompts(id)).toBe('1'); // the cycle restarted at the new reading
    await h.settle();
    const events = await h.q<{ event_type: string }>(sql`SELECT event_type FROM core.domain_event_outbox
      WHERE aggregate_id = ${id}::uuid AND event_type = 'odometer_prompt.answered'`);
    expect(events).toHaveLength(1);
  });

  it('keeps readings in recorded_at order and mirrors the newest by time', async () => {
    const o = await h.user();
    const id = await h.vehicle(o);
    await reading(o, id, 10_000, 10);
    const early = await reading(o, id, 5_000, 40); // back-dated, entered later
    expect(early.body.lower_than_previous).toBe(false);
    const lower = await reading(o, id, 9_000, 5); // lower than the reading before it in time
    expect(lower.body.lower_than_previous).toBe(true);
    const list = (await o.c.get(`/v1/me/vehicles/${id}/mileage`)).body.items as Json[];
    expect(list.map((m) => m.mileage_km)).toEqual([9_000, 10_000, 5_000]);
    expect((await o.c.get(`/v1/me/vehicles/${id}`)).body.mileage_km).toBe(9_000);
    await reading(o, id, 7_000, 20); // back-dated again: the mirror stays with the newest by time
    expect((await o.c.get(`/v1/me/vehicles/${id}`)).body.mileage_km).toBe(9_000);
    expect((await reading(o, id, 1, -1)).status).toBe(422); // a day ahead is refused (5 minutes of skew)
  });

  it('is off at 0, skips inactive vehicles, and accepts only 0 or 14-90 days in the rules', async () => {
    const o = await h.user();
    const active = await h.vehicle(o);
    const inactive = await h.vehicle(o, { status: 'inactive' });
    await aged(active, 40);
    await aged(inactive, 40);
    await setRules(0);
    await rule().run();
    expect(await prompts(active)).toBe('0');
    await setRules(30);
    await rule().run();
    expect(await prompts(active)).toBe('1');
    expect(await prompts(inactive)).toBe('0');
    const rules = (await adm.c.get('/v1/admin/notification-rules')).body;
    expect(rules.odometer_prompt_days).toBe(30);
    const { updated_by_display: _u, updated_at: _a, version, ...writable } = rules;
    void _u;
    void _a;
    const put = (days: number) =>
      adm.c.put(
        '/v1/admin/notification-rules',
        { ...writable, odometer_prompt_days: days, reason: 'Test of the odometer prompt rule.' },
        {
          'if-match': `"v${version as number}"`,
        },
      );
    expect((await put(5)).status).toBe(422);
    const ok0 = await put(0);
    expect(ok0.status, ok0.text).toBe(200);
  });
});
