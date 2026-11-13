// S13 (contract 1.4.0, admin console unblockers; backend/BR-update-plan.json S13): the admin-plane job read
// (BR-20), the staff directory with disable and four-eyes enable (BR-10), the taxonomy tree and region settings on
// admin-api (BR-18), the badge list (BR-31) and the requester's own four-eyes changes with their outcome (BR-21).
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import type { TestUser } from '#libs/testing/index.js';
import type { Json } from './s4-support.js';
import { client } from './s5-support.js';
import { purpose, query, REASON, staff, staffApi, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let adminA: TestUser;
let a: StaffApi;
let b: StaffApi;
let support: StaffApi;
let moderator: StaffApi;
let reviewer: StaffApi;
const tempNodes: string[] = [];
/** Fixture staff are "Test User" without a display name: staff are shown by first name (authorDisplayName). */
const STAFF_NAME = 'Test';

/** Pages through admin.staff_list (the shared test database holds many fixture staff). */
async function findStaff(c: StaffApi, query: string, userId: string): Promise<Json | undefined> {
  let cursor: string | null = null;
  do {
    const res = await c.get(`/v1/admin/staff?${query}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status, res.text).toBe(200);
    const hit = (res.body.items as Json[]).find((s) => s.user_id === userId);
    if (hit) return hit;
    cursor = res.body.next_cursor;
  } while (cursor);
  return undefined;
}

const sys = <T>(fn: Parameters<TestApp['fixtures']['worker']['run']>[1]) =>
  api.fixtures.worker.run({ actorType: 'system' }, fn) as Promise<T>;

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  const sa = await staff(admin, 'platform_admin');
  adminA = sa.user;
  a = sa.c;
  b = (await staff(admin, 'platform_admin')).c;
  support = (await staff(admin, 'platform_support')).c;
  moderator = (await staff(admin, 'platform_moderator')).c;
  reviewer = (await staff(admin, 'platform_community_reviewer')).c;
}, 60_000);

afterAll(async () => {
  // Temporary taxonomy nodes would change the seeded catalog counts of other suites.
  if (tempNodes.length)
    await sys(async ({ db }) => {
      // A merged node must name its target (CHECK): make them inactive and unlinked first.
      await db
        .updateTable('taxonomy.taxonomy_nodes')
        .set({ merged_into_id: null, status: 'inactive' })
        .where((eb) => eb.or([eb('id', 'in', tempNodes), eb('merged_into_id', 'in', tempNodes)]))
        .execute();
      await db.deleteFrom('taxonomy.taxonomy_nodes').where('id', 'in', tempNodes).execute();
    });
  await worker?.close();
  await admin?.close();
  await api?.close();
});

async function tempNode(name: string): Promise<Json> {
  const res = await a.post('/v1/admin/taxonomy/nodes', {
    type: 'service_system',
    name_translations: { en: name, fa: 'سامانه آزمون' },
    slug: `s13-${uuidv7().slice(-12)}`,
    reason: REASON,
  });
  expect(res.status, res.text).toBe(201);
  tempNodes.push(res.body.id);
  return res.body;
}

describe('admin.job_get (BR-20)', () => {
  it('follows a DSR export started on the admin plane; api-host jobs and other roles get 404', async () => {
    const user = await api.fixtures.user();
    const uc = client(api, await api.fixtures.token(user, { acr: 'aal2' }));
    const id = (await uc.post('/v1/me/data-requests', { request_type: 'export' })).body.id as string;
    for (const status of ['verifying_identity', 'in_progress'])
      expect((await support.post(`/v1/admin/data-requests/${id}/status`, { status, reason: REASON }, purpose('dsr', id))).status).toBe(200);
    const started = await support.post(`/v1/admin/data-requests/${id}/export`, { reason: REASON }, purpose('dsr', id));
    expect(started.status, started.text).toBe(202);
    // The Location points at the admin-plane read, not at jobs.get on the api host (which refuses staff tokens).
    expect(started.headers.location).toBe(`/v1/admin/jobs/${started.body.id}`);

    const job = await support.get(`/v1/admin/jobs/${started.body.id}`);
    expect(job.status, job.text).toBe(200);
    expect(job.body).toMatchObject({ id: started.body.id, kind: 'data_export' });
    expect(job.body).not.toHaveProperty('input_summary');
    await api.infra.jobs.idle();
    expect((await a.get(`/v1/admin/jobs/${started.body.id}`)).body).toMatchObject({
      status: 'succeeded',
      result: { type: 'data_subject_request', id },
    });
    // STF(ADM, SUP): a moderator does not see the operation at all.
    expect((await moderator.get(`/v1/admin/jobs/${started.body.id}`)).status).toBe(404);

    // A job started on the api host (a fleet export of an organization) does not exist on the admin plane.
    const apiJob = uuidv7();
    await sys(({ db }) =>
      db
        .insertInto('core.background_jobs')
        .values({ id: apiJob, kind: 'fleet_export', owner_user_id: user.id, owning_module: 'fleet' })
        .execute(),
    );
    expect((await a.get(`/v1/admin/jobs/${apiJob}`)).status).toBe(404);
    // A data_export kind from another module is not an admin job either.
    const forged = uuidv7();
    await sys(({ db }) =>
      db
        .insertInto('core.background_jobs')
        .values({ id: forged, kind: 'data_export', owner_user_id: user.id, owning_module: 'fleet' })
        .execute(),
    );
    expect((await support.get(`/v1/admin/jobs/${forged}`)).status).toBe(404);
    expect((await support.get(`/v1/admin/jobs/${uuidv7()}`)).status).toBe(404);
  });
});

describe('four-eyes: own requests with the outcome, and the job of an approved ASYNC change (BR-21)', () => {
  it('mine=true lists the caller’s requests in every status with the decision; the default list never shows them', async () => {
    const target = await api.fixtures.user();
    const req = await a.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_support', reason: REASON });
    expect(req.status, req.text).toBe(202);
    const changeId = req.body.change_id as string;
    expect(req.body).toMatchObject({ status: 'pending', decided_by_display: null, decided_at: null, decision_reason: null, job_id: null });

    const pendingMine = await a.get('/v1/admin/four-eyes?mine=true&limit=100');
    expect(pendingMine.status, pendingMine.text).toBe(200);
    expect(pendingMine.body.items.find((c: Json) => c.change_id === changeId)).toMatchObject({ status: 'pending' });
    // Without mine the requester never sees their own change (they cannot decide it).
    expect((await a.get('/v1/admin/four-eyes?limit=100')).body.items.some((c: Json) => c.change_id === changeId)).toBe(false);

    const decided = await b.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'reject', reason: 'Not needed after all' });
    expect(decided.status, decided.text).toBe(200);
    expect(decided.body).toMatchObject({ status: 'rejected', decided_by_display: STAFF_NAME, decision_reason: 'Not needed after all' });

    const mine = await a.get('/v1/admin/four-eyes?mine=true&limit=100');
    const row = mine.body.items.find((c: Json) => c.change_id === changeId);
    expect(row).toMatchObject({ status: 'rejected', decided_by_display: STAFF_NAME, decision_reason: 'Not needed after all' });
    expect(Date.parse(row.decided_at)).toBeGreaterThan(0);
    // The status filter applies to one's own requests too; another admin's mine list does not carry them.
    expect(
      (await a.get('/v1/admin/four-eyes?mine=true&status=pending&limit=100')).body.items.some((c: Json) => c.change_id === changeId),
    ).toBe(false);
    expect((await b.get('/v1/admin/four-eyes?mine=true&limit=100')).body.items.some((c: Json) => c.change_id === changeId)).toBe(false);
  });

  it('an approved taxonomy merge records its job, which admins (not support) read through admin.job_get', async () => {
    const [from, into] = [await tempNode('S13 from'), await tempNode('S13 into')];
    const req = await a.post(`/v1/admin/taxonomy/nodes/${from.id}/merge`, { into_node_id: into.id, reason: REASON });
    expect(req.status, req.text).toBe(202);
    const approved = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason: REASON });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.job_id).toMatch(/^[0-9a-f-]{36}$/);
    const job = await a.get(`/v1/admin/jobs/${approved.body.job_id}`);
    expect(job.status, job.text).toBe(200);
    expect(job.body.kind).toBe('taxonomy_merge');
    // The requester sees the job id in their own list too.
    expect(
      (await a.get('/v1/admin/four-eyes?mine=true&limit=100')).body.items.find((c: Json) => c.change_id === req.body.change_id),
    ).toMatchObject({ status: 'approved', job_id: approved.body.job_id });
    // Support starts DSR exports only: a merge job does not exist for them.
    expect((await support.get(`/v1/admin/jobs/${approved.body.job_id}`)).status).toBe(404);
  });
});

describe('staff directory (BR-10)', () => {
  it('admins see the directory fields of every staff member; other staff see active colleagues by name and role only', async () => {
    const mod2 = await staff(admin, 'platform_moderator');
    const full = await a.get('/v1/admin/staff?role=platform_moderator&limit=100');
    expect(full.status, full.text).toBe(200);
    const row = await findStaff(a, 'role=platform_moderator', mod2.user.id);
    expect(row).toMatchObject({
      display_name: STAFF_NAME,
      platform_roles: ['platform_moderator'],
      status: 'active',
      account_status: 'active',
      passkey_count: 0,
    });
    expect(row!.email_masked).toMatch(/^t\*\*\*@test\.carpal\.app$/);
    expect(full.body.items.every((s: Json) => s.platform_roles.includes('platform_moderator'))).toBe(true);

    const seen = await findStaff(moderator, 'role=platform_moderator', mod2.user.id);
    expect(Object.keys(seen!).sort()).toEqual(['display_name', 'platform_roles', 'status', 'user_id']);
    // Other staff never list disabled members.
    expect((await reviewer.get('/v1/admin/staff?status=disabled')).body.items).toEqual([]);
    // A consumer is not staff: not in the directory.
    const consumer = await api.fixtures.user();
    expect(await findStaff(a, 'status=active', consumer.id)).toBeUndefined();
  });

  it('disable suspends every platform role and ends the sessions; enable needs a second admin', async () => {
    const target = await staff(admin, 'platform_support', 'platform_moderator');
    expect((await target.c.get('/v1/admin/me')).status).toBe(200);

    const off = await a.post(`/v1/admin/staff/${target.user.id}/disable`, { reason: REASON });
    expect(off.status, off.text).toBe(200);
    expect(off.body).toMatchObject({ status: 'disabled', platform_roles: ['platform_moderator', 'platform_support'] });
    // Every session ended at once; a new staff token gets no staff role either.
    expect((await target.c.get('/v1/admin/me')).status).not.toBe(200);
    const fresh = staffApi(admin, await admin.fixtures.token(target.user, { staff: true }));
    expect((await fresh.get('/v1/admin/staff')).status).toBe(404);
    // The account itself is untouched.
    const [acct] = await query<{ status: string }>(api, sql`SELECT status FROM identity.user_accounts WHERE id = ${target.user.id}::uuid`);
    expect(acct!.status).toBe('active');
    const [audit] = await query<{ action: string; reason: string }>(
      api,
      sql`SELECT action, reason FROM analytics.audit_logs WHERE entity_id = ${target.user.id}::uuid AND action = 'staff.disabled'`,
    );
    expect(audit).toMatchObject({ action: 'staff.disabled', reason: REASON });

    expect(await findStaff(a, 'status=disabled', target.user.id)).toMatchObject({ status: 'disabled' });
    expect((await a.post(`/v1/admin/staff/${target.user.id}/disable`, { reason: REASON })).body).toMatchObject({
      code: 'INVALID_TRANSITION',
    });

    const on = await a.post(`/v1/admin/staff/${target.user.id}/enable`, { reason: REASON });
    expect(on.status, on.text).toBe(202);
    expect(on.body).toMatchObject({ op_id: 'admin.staff_enable', status: 'pending' });
    // Nothing changes until a second admin approves; the requester cannot approve.
    expect((await a.post(`/v1/admin/four-eyes/${on.body.change_id}/decision`, { decision: 'approve', reason: REASON })).status).toBe(403);
    expect((await b.post(`/v1/admin/four-eyes/${on.body.change_id}/decision`, { decision: 'approve', reason: REASON })).status).toBe(200);
    const back = staffApi(admin, await admin.fixtures.token(target.user, { staff: true }));
    const me = await back.get('/v1/admin/me');
    expect(me.status, me.text).toBe(200);
    expect(me.body.platform_roles).toEqual(['platform_moderator', 'platform_support']);
    expect((await a.post(`/v1/admin/staff/${target.user.id}/enable`, { reason: REASON })).status).toBe(409);
  });

  it('refuses the caller, non-staff accounts and other roles', async () => {
    expect((await a.post(`/v1/admin/staff/${adminA.id}/disable`, { reason: REASON })).body).toMatchObject({
      status: 403,
      code: 'SELF_APPROVAL_FORBIDDEN',
    });
    const consumer = await api.fixtures.user();
    expect((await a.post(`/v1/admin/staff/${consumer.id}/disable`, { reason: REASON })).status).toBe(404);
    expect((await a.post(`/v1/admin/staff/${consumer.id}/enable`, { reason: REASON })).status).toBe(404);
    const target = await admin.fixtures.staff('platform_support');
    expect((await moderator.post(`/v1/admin/staff/${target.id}/disable`, { reason: REASON })).status).toBe(404);
  });

  it('two admins disabling each other at once: one wins and the platform keeps an administrator', async () => {
    const x = await staff(admin, 'platform_admin');
    const y = await staff(admin, 'platform_admin');
    // Make x and y the only active administrators for this test, then give the others their role back.
    const others = await sys<{ id: string }[]>(({ db }) =>
      db
        .updateTable('identity.role_memberships')
        .set({ status: 'suspended' })
        .where('role', '=', 'platform_admin')
        .where('organization_id', 'is', null)
        .where('status', '=', 'active')
        .where('user_id', 'not in', [x.user.id, y.user.id])
        .returning('id')
        .execute(),
    );
    try {
      const [rx, ry] = await Promise.all([
        x.c.post(`/v1/admin/staff/${y.user.id}/disable`, { reason: REASON }),
        y.c.post(`/v1/admin/staff/${x.user.id}/disable`, { reason: REASON }),
      ]);
      const statuses = [rx.status, ry.status].sort();
      expect(statuses[0], `${rx.text} | ${ry.text}`).toBe(200);
      // The loser was refused: last_admin (409) once it saw the winner's change, or no longer staff (401/404).
      expect([401, 404, 409]).toContain(statuses[1]);
      const [n] = await query<{ n: string }>(
        api,
        sql`SELECT count(*) AS n FROM identity.role_memberships WHERE role = 'platform_admin' AND organization_id IS NULL
             AND status = 'active' AND user_id IN (${x.user.id}::uuid, ${y.user.id}::uuid)`,
      );
      expect(Number(n!.n)).toBe(1);
    } finally {
      if (others.length)
        await sys(({ db }) =>
          db
            .updateTable('identity.role_memberships')
            .set({ status: 'active' })
            .where(
              'id',
              'in',
              others.map((o) => o.id),
            )
            .execute(),
        );
    }
  });
});

describe('taxonomy tree and region settings on admin-api (BR-18)', () => {
  it('admin.taxonomy_snapshot carries every status, all labels, missing locales and the version', async () => {
    const node = await tempNode('S13 snapshot');
    const dep = await a.patch(`/v1/admin/taxonomy/nodes/${node.id}`, { status: 'deprecated', reason: REASON }, node.version);
    expect(dep.status, dep.text).toBe(200);
    const res = await moderator.get('/v1/admin/taxonomy/nodes?type=service_system&status=deprecated&limit=500', {
      'accept-language': 'fa',
    });
    expect(res.status, res.text).toBe(200);
    const item = res.body.items.find((n: Json) => n.id === node.id);
    expect(item).toMatchObject({
      status: 'deprecated',
      name: { text: 'سامانه آزمون', locale: 'fa' },
      name_translations: { en: 'S13 snapshot', fa: 'سامانه آزمون' },
      missing_locales: [],
      version: dep.body.version,
    });
    expect(res.body.items.every((n: Json) => n.status === 'deprecated' && n.type === 'service_system')).toBe(true);
    // STF(ADM, MOD): support has no taxonomy tree.
    expect((await support.get('/v1/admin/taxonomy/nodes?type=service_system')).status).toBe(404);
  });

  it('admin.region_settings returns the region configuration and the pin threshold to every staff role', async () => {
    const res = await reviewer.get('/v1/admin/region');
    expect(res.status, res.text).toBe(200);
    expect(res.body.location_check_threshold_m).toBe(300);
    expect(res.body.region).toMatchObject({ region_key: expect.any(String), map: { default_zoom: expect.any(Number) } });
    expect(Array.isArray(res.body.region.exchange_rates)).toBe(true);
  });
});

describe('admin.badges_list (BR-31)', () => {
  it('finds a Verified Business badge waiting for approval with its organization', async () => {
    const org = await api.fixtures.org('provider');
    const badge = uuidv7();
    await sys(({ db }) =>
      db
        .insertInto('trust.provider_badges')
        .values({
          id: badge,
          provider_organization_id: org.id,
          badge_type: 'verified_business',
          rule_key: 'verified_business',
          rule_version: '54-2026-10',
          evaluation_snapshot: JSON.stringify({ verified: ['business_identity', 'location'] }),
          requires_admin_approval: true,
          status: 'pending_approval',
        })
        .execute(),
    );
    const res = await moderator.get(`/v1/admin/badges?status=pending_approval&organization_id=${org.id}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: badge,
      badge_type: 'verified_business',
      status: 'pending_approval',
      organization: { id: org.id, organization_type: 'provider' },
    });
    expect((await moderator.get(`/v1/admin/badges?status=active&organization_id=${org.id}`)).body.items).toEqual([]);
    expect((await reviewer.get('/v1/admin/badges')).status).toBe(404);
    // Approved by the id from the list, it moves to active.
    expect((await moderator.post(`/v1/admin/badges/${badge}/approve`, { reason: REASON })).status).toBe(200);
    expect((await moderator.get(`/v1/admin/badges?status=active&organization_id=${org.id}`)).body.items[0]).toMatchObject({ id: badge });
  });
});
