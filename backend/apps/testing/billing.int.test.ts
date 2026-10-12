// S3 billing (40 §10): plans.list, subscription.me_get / org_get,
// subscription.change_request, the L17 entitlement check (race-safe under the
// subscriber lock) and the user.registered consumer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import type { EventEnvelope } from '#libs/infra/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { UserRegisteredBillingConsumer } from '#modules/billing/events/user-registered.consumer.js';
import { createTestApp, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
type Json = Record<string, any>;

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
});
afterAll(() => app.close());

describe('plans.list', () => {
  it('lists the nine active plans with entitlements, cacheable for 10 min; filters by audience', async () => {
    const anon = await app.fixtures.anonymousToken();
    const res = await app.request<Json>({ path: '/v1/plans', token: anon });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    expect(res.body.items.map((p: Json) => p.plan_key)).toEqual([
      'individual_free',
      'fleet_20',
      'fleet_50',
      'fleet_100',
      'fleet_custom',
      'provider_basic',
      'provider_pro',
      'vendor_basic',
      'vendor_pro',
    ]);
    const free = res.body.items[0];
    expect(free).toMatchObject({ audience: 'individual', max_vehicles: 5 });
    expect(free.entitlements).toContainEqual({ key: 'max_vehicles', value: 5 });
    expect(free.entitlements).toContainEqual({ key: 'ai_tools_enabled', value: true });
    const fleet = await app.request<Json>({ path: '/v1/plans?audience=fleet', token: anon });
    expect(fleet.body.items.map((p: Json) => p.audience)).toEqual(['fleet', 'fleet', 'fleet', 'fleet']);
  });
});

describe('subscription.me_get', () => {
  it('always returns at least Individual Free, with effective entitlements', async () => {
    const user = await app.fixtures.user();
    const res = await app.request<Json>({ path: '/v1/me/subscription', token: await app.fixtures.token(user) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: { plan_key: 'individual_free' }, status: 'active', billing_mode: 'manual', version: 1 });
    expect(res.body.effective_entitlements).toContainEqual({ key: 'max_vehicles', value: 5 });
    expect(res.headers.etag).toBe('"v1"');
    // Idempotent: the same subscription on the next read.
    const again = await app.request<Json>({ path: '/v1/me/subscription', token: await app.fixtures.token(user) });
    expect(again.body.id).toBe(res.body.id);
  });
});

describe('subscription.org_get / change_request', () => {
  it('returns the organization subscription to any member, applies overrides; 404 without one', async () => {
    const { org, token } = await app.fixtures.memberOf('fleet', 'fleet_viewer');
    expect((await app.request({ path: `/v1/orgs/${org.id}/subscription`, token })).status).toBe(404);
    await app.fixtures.subscription(org, 'fleet_custom', { vehicleLimit: 250 });
    const res = await app.request<Json>({ path: `/v1/orgs/${org.id}/subscription`, token });
    expect(res.status).toBe(200);
    expect(res.body.plan.plan_key).toBe('fleet_custom');
    expect(res.body.effective_entitlements).toContainEqual({ key: 'max_vehicles', value: 250 });
  });

  it('records one open change request per organization; the plan audience must match', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    await app.fixtures.subscription(org, 'provider_basic');
    const ask = (planKey: string) =>
      app.request<Json>({
        method: 'POST',
        path: `/v1/orgs/${org.id}/subscription/change-requests`,
        token,
        body: { plan_key: planKey, note: 'more capacity please' },
        headers: { 'idempotency-key': uuidv7() },
      });
    const wrong = await ask('fleet_50');
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toEqual([{ pointer: '/plan_key', code: 'enum' }]);
    const ok = await ask('provider_pro');
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ ok: true });
    const dup = await ask('provider_pro');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('only owners may ask (O+): a provider_staff member gets 404', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_staff');
    const res = await app.request({
      method: 'POST',
      path: `/v1/orgs/${org.id}/subscription/change-requests`,
      token,
      body: { plan_key: 'provider_pro' },
      headers: { 'idempotency-key': uuidv7() },
    });
    expect(res.status).toBe(404);
  });
});

describe('entitlement check (L17, SEC-AZ-9)', () => {
  it('is race-safe: two parallel creates at the limit, exactly one passes (dummy counter)', async () => {
    const owner = await app.fixtures.user();
    const { org } = await app.fixtures.memberOf('fleet', 'fleet_owner');
    await app.fixtures.subscription(org, 'fleet_custom', { vehicleLimit: 3 });
    for (let i = 0; i < 2; i++) await app.fixtures.job(owner, { orgId: org.id });
    const tx = app.app.get(TxRunner, { strict: false });
    const checker = app.app.get(EntitlementChecker, { strict: false });
    // Dummy counter: background jobs of the organization stand in for its vehicles.
    const attempt = () =>
      tx.run({ actorType: 'user', userId: owner.id, orgId: org.id }, async (scope) => {
        await requireEntitlement(checker, scope, { type: 'organization', id: org.id }, 'max_vehicles', 1, {
          usage: async (s) =>
            Number(
              (
                await s.db
                  .selectFrom('core.background_jobs')
                  .select((eb) => eb.fn.countAll().as('n'))
                  .where('organization_id', '=', org.id)
                  .executeTakeFirstOrThrow()
              ).n,
            ),
        });
        await new Promise((r) => setTimeout(r, 150)); // widen the race window
        await scope.db
          .insertInto('core.background_jobs')
          .values({ kind: 'fleet_export', owner_user_id: owner.id, organization_id: org.id, owning_module: 'fleet' })
          .execute();
      });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as { code: string }).code)).toEqual(['VEHICLE_LIMIT_REACHED', 'VEHICLE_LIMIT_REACHED']);
  });

  it('boolean entitlements: ENTITLEMENT_REQUIRED when off; an organization without a subscription gets nothing', async () => {
    const owner = await app.fixtures.user();
    const tx = app.app.get(TxRunner, { strict: false });
    const checker = app.app.get(EntitlementChecker, { strict: false });
    const err = await tx
      .run({ actorType: 'user', userId: owner.id }, (scope) =>
        requireEntitlement(checker, scope, { type: 'user', id: owner.id }, 'export_enabled'),
      )
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('ENTITLEMENT_REQUIRED');
    const ok = await tx.run({ actorType: 'user', userId: owner.id }, (scope) =>
      requireEntitlement(checker, scope, { type: 'user', id: owner.id }, 'ai_tools_enabled'),
    );
    expect(ok.allowed).toBe(true);
    const { org, user } = await app.fixtures.memberOf('vendor', 'vendor_owner');
    const none = await tx.run({ actorType: 'user', userId: user.id, orgId: org.id }, (scope) =>
      checker.check(scope, { type: 'organization', id: org.id }, 'max_inventory_items', 1, { usage: async () => 0 }),
    );
    expect(none.allowed).toBe(false);
  });
});

describe('user.registered consumer', () => {
  it('creates Individual Free once (idempotent)', async () => {
    const user = await app.fixtures.user();
    // The api role cannot use the system context: run the consumer as the worker deployable does.
    const worker = app.fixtures.worker;
    const c = new UserRegisteredBillingConsumer(worker);
    const event: EventEnvelope = {
      eventId: uuidv7(),
      type: 'user.registered',
      aggregateType: 'user_account',
      aggregateId: user.id,
      organizationId: null,
      payload: {},
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      requestId: null,
    };
    await c.handle(event);
    await c.handle(event);
    const subs = await worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('billing.subscriptions').select(['status']).where('subscriber_id', '=', user.id).execute(),
    );
    expect(subs).toEqual([{ status: 'active' }]);
  });
});
