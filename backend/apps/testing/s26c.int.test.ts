// S26c.T0 (BR-36, BR-37): the verification queue. A page is read with one query per kind of data instead of several
// per row (a page of 50 took 8-10 s), and admin.verifications_queue reads one check or one organization's checks
// (q verification_id, organization_id) so a link opens a check without walking the pages (console D-66).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TxRunner } from '#libs/tenancy/index.js';
import { Harness, ok, sql, type Actor, type Json } from './contract/harness.js';
import { REASON } from './s8-support.js';

let h: Harness;
let mod: Actor;

beforeAll(async () => {
  h = await Harness.start();
  mod = await h.staff('platform_moderator');
  instrumentPool();
}, 120_000);

/** The checks this file created: retired at the end, so the shared test database's pending queue does not grow with every run. */
const created: string[] = [];

afterAll(async () => {
  if (created.length)
    await h.q(sql`UPDATE organization.organization_verifications
      SET status = 'rejected', rejection_reason = 'S26c test cleanup', reviewed_by = ${mod.user.id}::uuid, reviewed_at = now(),
          sla_paused_at = NULL
      WHERE id = ANY(${created}::uuid[]) AND status = 'pending'`);
  restorePool?.();
  await h?.close();
});

/** A pending check of a new provider with `extraLocations` more locations; its owner submitted it. */
async function pendingCheck(type = 'business_identity', extraLocations = 0) {
  const owner = await h.member('provider');
  const orgId = owner.org!.id;
  const v = ok(await owner.c.post(`/v1/orgs/${orgId}/verifications`, { verification_type: type }), 'verification');
  for (let i = 0; i <= extraLocations; i++)
    await h.q(sql`INSERT INTO organization.organization_locations
        (organization_id, address_line_1, city, country, latitude, longitude, geo_source, timezone, is_primary, location_check_status)
      VALUES (${orgId}::uuid, ${`${i} Test Street`}, 'Tehran', 'IR', 35.7, 51.4, 'user_pin', 'Asia/Tehran', ${i === 0}, 'consistent')`);
  created.push(v.id as string);
  return { owner, orgId, id: v.id as string };
}

const report = async (targetType: string, targetId: string, reason: string) => {
  const reporter = await h.user();
  ok(await reporter.c.post('/v1/reports', { target_type: targetType, target_id: targetId, reason }), 'report');
};

const queue = async (query: string) => ok(await mod.c.get(`/v1/admin/verifications?${query}`), 'queue');
const items = (page: Json) => page.items as Json[];

const TABLES = /organization_locations|content_reports|role_memberships|organization_verifications|user_accounts/;
let counting = false;
let queries = 0;
let restorePool: (() => void) | undefined;

/**
 * Counts the reads of the tables the page's per-organization data comes from, made through the admin host's own
 * connection pool while `counting` is on (the worker has another pool: its trust recomputes after the fixtures'
 * events are not counted).
 */
function instrumentPool() {
  const pool = h.admin.app.get(TxRunner, { strict: false }).database.pool;
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const seen = new WeakSet<object>();
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    if (!seen.has(client)) {
      seen.add(client);
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string } | undefined)?.text ?? '');
        if (counting && TABLES.test(text)) queries += 1;
        return query(...args);
      };
    }
    return client;
  };
  restorePool = () => {
    (pool as unknown as { connect: unknown }).connect = connect;
  };
}

async function countQueries(run: () => Promise<unknown>): Promise<{ queries: number; ms: number }> {
  queries = 0;
  counting = true;
  const started = performance.now();
  try {
    await run();
  } finally {
    counting = false;
  }
  return { queries, ms: Math.round(performance.now() - started) };
}

describe('verification queue page (BR-36)', () => {
  it('reads the same number of times for a page of 2 and a page of 12, with several locations per organization', async () => {
    // A moderator of its own holds exactly these 12 checks, so the pages below are the fixtures and not whatever the
    // shared test database has left in its pending queue.
    const reviewer = await h.staff('platform_moderator');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await pendingCheck('business_identity', i % 3);
      ok(await reviewer.c.post(`/v1/admin/verifications/${c.id}/assign`, { reason: REASON }), 'assign');
      ids.push(c.id);
    }
    await h.settle(); // the consumers of the new organizations' events read the same tables: let them finish first
    const mine = async (limit: number) =>
      ok(await reviewer.c.get(`/v1/admin/verifications?status=pending&assignee=me&limit=${limit}`), 'queue');
    await mine(1); // warm up the plans and the staff context

    let small: Json = {};
    let large: Json = {};
    const smallRun = await countQueries(async () => (small = await mine(2)));
    const largeRun = await countQueries(async () => (large = await mine(12)));
    console.info(
      `BR-36 queue page latency: limit 2 = ${smallRun.ms} ms (${smallRun.queries} reads), limit 12 = ${largeRun.ms} ms (${largeRun.queries} reads)`,
    );
    expect(items(small).map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(items(large).map((i) => i.id)).toEqual(ids);
    expect(smallRun.queries).toBeGreaterThan(0); // the counter sees the queue's reads
    expect(largeRun.queries).toBe(smallRun.queries);
  }, 180_000);

  it('counts wrong-location reports against the organization and all its locations, and names the owner and location check', async () => {
    const a = await pendingCheck('location', 1);
    const b = await pendingCheck('location', 0);
    const locs = await h.q<{ id: string }>(
      sql`SELECT id FROM organization.organization_locations WHERE organization_id = ${a.orgId}::uuid ORDER BY id`,
    );
    expect(locs).toHaveLength(2);
    await report('organization', a.orgId, 'wrong_location_or_closed');
    await report('organization_location', locs[0]!.id, 'wrong_location_or_closed');
    await report('organization_location', locs[1]!.id, 'wrong_location_or_closed');
    await report('organization_location', locs[1]!.id, 'spam'); // another reason: not counted
    await h.q(sql`UPDATE organization.organization_locations SET location_check_status = 'far_apart', geo_address_distance_m = 4200
      WHERE id = ${locs[1]!.id}::uuid`);

    const rows = items(await queue(`verification_id=${a.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: a.id,
      wrong_location_reports: 3,
      owner: { user_id: a.owner.user.id },
      organization: { id: a.orgId },
    });
    // The primary location is the one the check reads (is_primary first).
    expect(rows[0]!.location_check).toMatchObject({ location_check_status: 'consistent' });

    const other = items(await queue(`verification_id=${b.id}`));
    expect(other[0]).toMatchObject({ id: b.id, wrong_location_reports: 0, owner: { user_id: b.owner.user.id } });
  }, 120_000);
});

describe('admin.verifications_queue by id or organization (BR-37)', () => {
  it('reads one check by verification_id in any status, and one organization by organization_id', async () => {
    const a = await pendingCheck();
    const b = await pendingCheck();
    const one = await queue(`verification_id=${a.id}&limit=50`);
    expect(items(one).map((i) => i.id)).toEqual([a.id]);
    expect(one.next_cursor ?? null).toBeNull();

    // With status: the status still applies.
    expect(items(await queue(`verification_id=${a.id}&status=verified`))).toEqual([]);
    expect(items(await queue(`verification_id=${a.id}&status=pending`)).map((i) => i.id)).toEqual([a.id]);
    // organization_id and verification_id together must name the same organization.
    expect(items(await queue(`verification_id=${a.id}&organization_id=${b.orgId}`))).toEqual([]);
    expect(items(await queue(`verification_id=${a.id}&organization_id=${a.orgId}`)).map((i) => i.id)).toEqual([a.id]);

    // A decided check: found by id without a status, not in the default (pending) listing of its organization.
    await h.q(sql`UPDATE organization.organization_verifications
      SET status = 'rejected', rejection_reason = 'Not readable', reviewed_by = ${mod.user.id}::uuid, reviewed_at = now()
      WHERE id = ${a.id}::uuid`);
    expect(items(await queue(`verification_id=${a.id}`)).map((i) => [i.id, i.status])).toEqual([[a.id, 'rejected']]);
    expect(items(await queue(`organization_id=${a.orgId}`))).toEqual([]);
    expect(items(await queue(`organization_id=${a.orgId}&status=rejected`)).map((i) => i.id)).toEqual([a.id]);
    expect(items(await queue(`organization_id=${b.orgId}`)).map((i) => i.id)).toEqual([b.id]);
  }, 120_000);

  it('answers an unknown id with an empty page and a malformed id with 422', async () => {
    const unknown = await queue('verification_id=019a0000-0000-7000-8000-000000000000');
    expect(items(unknown)).toEqual([]);
    expect(items(await queue('organization_id=019a0000-0000-7000-8000-000000000000'))).toEqual([]);
    const bad = await mod.c.get('/v1/admin/verifications?verification_id=not-an-id');
    expect(bad.status).toBe(422);
    expect((await mod.c.get('/v1/admin/verifications?organization_id=not-an-id')).status).toBe(422);
  });

  it('stays closed to staff without the moderation role', async () => {
    const support = await h.staff('platform_support');
    const res = await support.c.get('/v1/admin/verifications?verification_id=019a0000-0000-7000-8000-000000000000');
    expect(res.status).toBe(404); // the admin plane does not reveal an operation to a role that cannot use it
  });
});
