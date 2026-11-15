// S21 (contract 1.4.0; backend/BR-update-plan.json S21): platform settings, billing reads and dashboard aggregates.
// admin.plans_list StaffPlan (BR-23); admin.subscriptions_list and admin.subscription_change_requests_list (BR-24);
// admin.retention_create (4EYES) and admin.retention_dry_run (BR-25); FeatureFlag and ExchangeRate ids (BR-26);
// admin.system_health (BR-17) and admin.work_summary (BR-22). The database is shared with the other suites (files run
// one at a time), so counts are checked as differences.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { Harness, ok, sql, type Actor, type Json } from './contract/harness.js';
import { projectionViolations } from './contract/projection.js';
import { purpose, REASON } from './s8-support.js';

let h: Harness;
let adm: Actor;

beforeAll(async () => {
  h = await Harness.start();
  adm = await h.staff('platform_admin');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const approve = async (changeId: string) => {
  const second = await h.staff('platform_admin');
  return second.c.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'approve', reason: REASON });
};

describe('plans and subscriptions (BR-23, BR-24)', () => {
  it('lists plans with their status and the default of each audience; the public list is unchanged', async () => {
    const res = await adm.c.get('/v1/admin/plans');
    expect(res.status, res.text).toBe(200);
    const plans = res.body.items as Json[];
    expect(plans.every((p) => ['active', 'inactive'].includes(p.status as string) && typeof p.is_default_for_audience === 'boolean')).toBe(
      true,
    );
    for (const audience of ['individual', 'fleet', 'provider', 'vendor'])
      expect(
        plans.filter((p) => p.audience === audience && p.is_default_for_audience && p.status === 'active'),
        audience,
      ).toHaveLength(1);
    expect(plans.find((p) => p.plan_key === 'individual_free')).toMatchObject({ is_default_for_audience: true, status: 'active' });
    const pub = await (await h.user()).c.get('/v1/plans');
    expect((pub.body.items as Json[])[0]).not.toHaveProperty('status');
    expect((await (await h.staff('platform_moderator')).c.get('/v1/admin/plans')).status).toBe(404);
  });

  it('lists subscriptions with the subscriber, overrides and who assigned them, and finds trials ending soon', async () => {
    const owner = await h.member('fleet');
    const org = owner.org!;
    await h.fx.subscription(org, 'fleet_20');
    const trialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    ok(
      await adm.c.post('/v1/admin/subscriptions', {
        subscriber: { type: 'organization', id: org.id },
        plan_key: 'fleet_50',
        status: 'trial',
        trial_ends_at: trialEnd,
        vehicle_limit_override: 60,
        entitlement_overrides: [{ key: 'export_enabled', value: true }],
        reason: REASON,
      }),
      'assign',
    );
    const res = await adm.c.get(`/v1/admin/subscriptions?subscriber_id=${org.id}&limit=1`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const row = (res.body.items as Json[])[0]!;
    expect(row).toMatchObject({
      subscriber: { type: 'organization', id: org.id, display: expect.any(String) },
      plan_key: 'fleet_50',
      status: 'trial',
      trial_ends_at: trialEnd,
      expires_at: null,
      overrides: { vehicle_limit: 60, user_limit: null, entitlements: [{ key: 'export_enabled', value: true }] },
    });
    expect(row.assigned_by_display).toEqual(expect.any(String));
    // The page goes on to the default subscription the assignment cancelled (newest first).
    const next = await adm.c.get(`/v1/admin/subscriptions?subscriber_id=${org.id}&limit=1&cursor=${res.body.next_cursor as string}`);
    expect((next.body.items as Json[])[0]).toMatchObject({ status: 'cancelled', assigned_by_display: null });

    const soon = await adm.c.get(
      `/v1/admin/subscriptions?trial_ends_before=${encodeURIComponent(new Date(Date.now() + 6 * 86_400_000).toISOString())}&plan_key=fleet_50&limit=100`,
    );
    expect((soon.body.items as Json[]).map((r) => r.id)).toContain(row.id);
    const later = await adm.c.get(
      `/v1/admin/subscriptions?trial_ends_before=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}&subscriber_id=${org.id}`,
    );
    expect(later.body.items).toEqual([]);
    // An individual is shown by the public display name, never contact data.
    const user = await h.user();
    ok(await user.c.get('/v1/me/subscription'), 'individual free');
    const ind = await adm.c.get(`/v1/admin/subscriptions?subscriber_type=user&subscriber_id=${user.user.id}`);
    expect((ind.body.items as Json[])[0]).toMatchObject({
      subscriber: { type: 'user' },
      plan_key: 'individual_free',
      assigned_by_display: null,
    });
    expect(ind.text).not.toContain(user.user.email);
    expect(projectionViolations(ind.body, { opId: 'admin.subscriptions_list', vins: h.vins, tradeAllowed: false })).toEqual([]);
  });

  it('lists open plan requests as a queue and shows who closed them by assigning a plan', async () => {
    const owner = await h.member('vendor');
    const org = owner.org!;
    await h.fx.subscription(org, 'vendor_basic');
    ok(
      await owner.c.post(`/v1/orgs/${org.id}/subscription/change-requests`, { plan_key: 'vendor_pro', note: 'Bigger catalogue' }),
      'request',
    );
    const open = await adm.c.get(`/v1/admin/subscription-change-requests?organization_id=${org.id}`);
    expect(open.status, open.text).toBe(200);
    expect(open.body.items).toHaveLength(1);
    expect((open.body.items as Json[])[0]).toMatchObject({
      organization: { id: org.id },
      requested_plan_key: 'vendor_pro',
      current_plan_key: 'vendor_basic',
      note: 'Bigger catalogue',
      status: 'open',
      handled_by_display: null,
      handled_at: null,
    });
    ok(
      await adm.c.post('/v1/admin/subscriptions', {
        subscriber: { type: 'organization', id: org.id },
        plan_key: 'vendor_pro',
        status: 'active',
        reason: REASON,
      }),
      'assign',
    );
    expect((await adm.c.get(`/v1/admin/subscription-change-requests?organization_id=${org.id}`)).body.items).toEqual([]);
    const done = await adm.c.get(`/v1/admin/subscription-change-requests?organization_id=${org.id}&status=assigned`);
    expect((done.body.items as Json[])[0]).toMatchObject({ status: 'assigned', handled_by_display: expect.any(String) });
    expect((await (await h.staff('platform_support')).c.get('/v1/admin/subscription-change-requests')).status).toBe(404);
  });
});

describe('retention policies (BR-25)', () => {
  it('adds a policy only with a second administrator, refuses duplicates and entity types nobody applies', async () => {
    const entity = `S21Record${Date.now()}`;
    const body = {
      entity_type: entity,
      applies_to_status: null,
      retention_days: 400,
      action: 'archive',
      legal_basis: 'S21 test',
      status: 'inactive',
      reason: REASON,
    };
    const asked = await adm.c.post('/v1/admin/retention-policies', body);
    expect(asked.status, asked.text).toBe(202);
    expect(asked.body).toMatchObject({ op_id: 'admin.retention_create', status: 'pending' });
    // Pending: nothing exists yet, and a second request for the same entity and status is refused.
    const listed = async () =>
      (ok(await adm.c.get('/v1/admin/retention-policies?limit=100'), 'list').items as Json[]).filter((p) => p.entity_type === entity);
    expect(await listed()).toEqual([]);
    const again = await (await h.staff('platform_admin')).c.post('/v1/admin/retention-policies', body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE');
    // The requester cannot approve; another administrator can.
    expect((await adm.c.post(`/v1/admin/four-eyes/${asked.body.change_id}/decision`, { decision: 'approve', reason: REASON })).status).toBe(
      403,
    );
    const approved = await approve(asked.body.change_id as string);
    expect(approved.status, approved.text).toBe(200);
    const [policy] = await listed();
    expect(policy).toMatchObject({ entity_type: entity, retention_days: 400, action: 'archive', status: 'inactive' });
    const audit = await h.q<{ action: string; reason: string }>(
      sql`SELECT action, reason FROM analytics.audit_logs WHERE entity_type = 'data_retention_policy' AND entity_id = ${policy!.id}::uuid`,
    );
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['admin.retention_created']));
    expect((await adm.c.post('/v1/admin/retention-policies', body)).status).toBe(409);
    // Existing seeded policy; delete for an entity no module applies; malformed names.
    const seeded = await adm.c.post('/v1/admin/retention-policies', { ...body, entity_type: 'Notification', action: 'delete' });
    expect(seeded.status).toBe(409);
    for (const entity_type of ['NoSuchEntity', 'notification', 'Bad Name']) {
      const bad = await adm.c.post('/v1/admin/retention-policies', { ...body, entity_type, action: 'delete' });
      expect(bad.status, entity_type).toBe(422);
      expect(bad.body.errors).toEqual([{ pointer: '/entity_type', code: 'enum' }]);
    }
    expect((await (await h.staff('platform_support')).c.post('/v1/admin/retention-policies', body)).status).toBe(404);
    // The seeded policies are pinned by the baseline test (shared database): remove the test's own policy.
    await h.q(sql`DELETE FROM admin.data_retention_policies WHERE id = ${policy!.id as string}::uuid`);
  });

  it('dry run counts what the next run would delete, per status, and changes nothing', async () => {
    const policies = ok(await adm.c.get('/v1/admin/retention-policies?limit=100'), 'policies').items as Json[];
    const byEntity = (e: string, status: string | null = null) =>
      policies.find((p) => p.entity_type === e && p.applies_to_status === status)!;
    const jobs = byEntity('BackgroundJob');
    const dry = (id: unknown, body: Json = {}) => adm.c.post(`/v1/admin/retention-policies/${id as string}/dry-run`, body);
    const before = await dry(jobs.id);
    expect(before.status, before.text).toBe(200);
    expect(before.body).toMatchObject({ entity_type: 'BackgroundJob', action: 'delete', retention_days: 30, outcome: 'counted' });

    // Three finished jobs from 40 days ago and a running one: the finished ones are due.
    const owner = await h.user();
    const old = new Date(Date.now() - 40 * 86_400_000);
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await h.sys((db) =>
      db
        .insertInto('core.background_jobs')
        .values(
          (['succeeded', 'succeeded', 'failed', 'running'] as const).map((status, i) => ({
            id: ids[i]!,
            kind: 'data_export',
            owner_user_id: owner.user.id,
            owning_module: 'identity',
            status,
            created_at: old,
            ...(status === 'failed' ? { error_code: 'INTERNAL' } : {}),
            ...(status === 'succeeded' ? { result_type: 'data_subject_request', result_id: uuidv7(), progress: 100 } : {}),
          })),
        )
        .execute(),
    );
    const after = await dry(jobs.id);
    expect(after.body.affected).toBe((before.body.affected as number) + 3);
    const statuses = Object.fromEntries((after.body.by_status as { status: string; count: number }[]).map((s) => [s.status, s.count]));
    const was = Object.fromEntries((before.body.by_status as { status: string; count: number }[]).map((s) => [s.status, s.count]));
    expect(statuses.succeeded).toBe((was.succeeded ?? 0) + 2);
    expect(statuses.failed).toBe((was.failed ?? 0) + 1);
    expect(Object.values(statuses).reduce((a, b) => a + b, 0)).toBe(after.body.affected);
    // A longer period previews a change: the 40-day-old jobs are no longer due.
    const longer = await dry(jobs.id, { retention_days: 60 });
    expect(longer.body).toMatchObject({ retention_days: 60 });
    expect(longer.body.affected as number).toBeLessThanOrEqual((after.body.affected as number) - 3);
    expect(Date.parse(longer.body.cutoff as string)).toBeLessThan(Date.parse(after.body.cutoff as string));
    // Nothing changed.
    const left = await h.q<{ n: string }>(
      sql`SELECT count(*) AS n FROM core.background_jobs WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`))})`,
    );
    expect(Number(left[0]!.n)).toBe(4);

    // Archive policies keep records, the outbox is not readable on the admin plane, and an entity without a module.
    expect((await dry(byEntity('AuditLog').id)).body).toMatchObject({ outcome: 'archive', affected: null, by_status: null });
    expect((await dry(byEntity('DomainEventOutbox', 'published').id)).body).toMatchObject({ outcome: 'not_countable', affected: null });
    expect((await dry(byEntity('AnalyticsEvent').id)).body).toMatchObject({ outcome: 'no_handler', affected: null });
    // MediaAsset with a status and the preview of another status.
    const media = await dry(byEntity('MediaAsset', 'removed').id, { applies_to_status: 'pending_upload' });
    expect(media.body).toMatchObject({ outcome: 'counted', applies_to_status: 'pending_upload' });
    expect(media.body.by_status).toEqual([{ status: 'pending_upload', count: media.body.affected }]);
    expect(
      (await (await h.staff('platform_moderator')).c.post(`/v1/admin/retention-policies/${jobs.id as string}/dry-run`, {})).status,
    ).toBe(404);
    await h.q(sql`DELETE FROM core.background_jobs WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`))})`);
  });
});

describe('flag and rate ids (BR-26)', () => {
  it('carries the audit entity id, so the history of a flag or a rate can be opened', async () => {
    const flags = ok(await adm.c.get('/v1/admin/flags?flag_type=release&limit=100'), 'flags').items as Json[];
    const flag = flags.find((f) => f.key === 'featured.enabled')!;
    expect(flag.id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    const rates = ok(await adm.c.get('/v1/admin/exchange-rates'), 'rates').items as Json[];
    const rate = rates[0]!;
    const changed = await adm.c.put(
      `/v1/admin/exchange-rates/${rate.currency as string}`,
      { per_usd: rate.per_usd, reason: REASON },
      {
        'if-match': `"v${rate.version as number}"`,
      },
    );
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.id).toBe(rate.id);
    const now = new Date();
    const history = await adm.c.post('/v1/admin/audit-logs/search', {
      entity_type: 'exchange_rate',
      entity_id: rate.id,
      from: new Date(now.getTime() - 60_000).toISOString(),
      to: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(history.status, history.text).toBe(200);
    expect((history.body.items as Json[]).map((e) => e.action)).toContain('admin.exchange_rate_updated');
  });
});

describe('system health (BR-17)', () => {
  it('counts failed imports, deliveries and scans per window with the last failure', async () => {
    const sup = await h.staff('platform_support');
    const read = async () => {
      const res = await sup.c.get('/v1/admin/system-health');
      expect(res.status, res.text).toBe(200);
      return Object.fromEntries((res.body.signals as Json[]).map((s) => [s.key, s])) as Record<string, Json>;
    };
    const before = await read();
    const owner = await h.user();
    const twoHours = new Date(Date.now() - 2 * 3_600_000);
    const tenDays = new Date(Date.now() - 10 * 86_400_000);
    const job = uuidv7();
    await h.sys((db) =>
      db
        .insertInto('core.background_jobs')
        .values({
          id: job,
          kind: 'inventory_import',
          owner_user_id: owner.user.id,
          owning_module: 'inventory',
          status: 'failed',
          error_code: 'INTERNAL',
          finished_at: twoHours,
        })
        .execute(),
    );
    const [n] = await h.q<{
      id: string;
    }>(sql`INSERT INTO notification.notifications (recipient_user_id, event_type, category, template_key, locale)
      VALUES (${owner.user.id}::uuid, 'system_announcement', 'system', 'system.announcement', 'en') RETURNING id`);
    // Failed ten days ago (the touch trigger sets updated_at on UPDATE, so the row is written with it).
    await h.q(sql`INSERT INTO notification.notification_deliveries (notification_id, channel, status, last_error, updated_at)
      VALUES (${n!.id}::uuid, 'email', 'failed', 'smtp 550', ${tenDays})`);
    const [m] = await h.q<{ id: string }>(sql`INSERT INTO media.media_assets
        (owner_type, owner_id, purpose, media_type, mime_type, file_size_bytes, privacy_level, uploaded_by, status, scan_status)
      VALUES ('user', ${owner.user.id}::uuid, 'issue_photo', 'image', 'image/jpeg', 1000, 'private', ${owner.user.id}::uuid, 'quarantined', 'failed')
      RETURNING id`);
    const after = await read();
    expect(after.import_failures).toMatchObject({
      last_24h: (before.import_failures!.last_24h as number) + 1,
      last_7d: (before.import_failures!.last_7d as number) + 1,
      last_30d: (before.import_failures!.last_30d as number) + 1,
    });
    expect(Date.parse(after.import_failures!.last_failure_at as string)).toBeGreaterThanOrEqual(twoHours.getTime() - 1000);
    // Ten days ago: only the 30-day window.
    expect(after.notification_delivery_failures).toMatchObject({
      last_24h: before.notification_delivery_failures!.last_24h,
      last_7d: before.notification_delivery_failures!.last_7d,
      last_30d: (before.notification_delivery_failures!.last_30d as number) + 1,
    });
    expect(after.media_scan_failures!.last_24h).toBe((before.media_scan_failures!.last_24h as number) + 1);
    expect((await (await h.staff('platform_community_reviewer')).c.get('/v1/admin/system-health')).status).toBe(404);
    await h.q(sql`DELETE FROM core.background_jobs WHERE id = ${job}::uuid`);
    await h.q(sql`UPDATE media.media_assets SET deleted_at = now(), deletion_reason = 'S21 test' WHERE id = ${m!.id}::uuid`);
    await h.q(sql`DELETE FROM notification.notification_deliveries WHERE notification_id = ${n!.id}::uuid`);
    await h.q(sql`DELETE FROM notification.notifications WHERE id = ${n!.id}::uuid`);
  });
});

describe('work summary (BR-22)', () => {
  const summary = async (as: Actor, headers: Record<string, string> = {}) => {
    const res = await as.c.get('/v1/admin/work-summary', headers);
    expect(res.status, res.text).toBe(200);
    return res;
  };
  const queue = (res: { body: Json }, key: string) => (res.body.items as Json[]).find((q) => q.queue === key)!;

  it("returns only the queues the caller's roles may read", async () => {
    const expected: Record<string, string[]> = {
      platform_admin: ['four_eyes', 'verifications', 'cases', 'privacy_requests', 'badge_approvals', 'subscription_change_requests'],
      platform_moderator: ['four_eyes', 'verifications', 'review_approvals', 'reports', 'cases', 'disputes', 'badge_approvals'],
      platform_support: ['reports', 'privacy_requests'],
      platform_community_reviewer: ['review_approvals', 'disputes'],
    };
    for (const [role, queues] of Object.entries(expected)) {
      const res = await summary(await h.staff(role));
      expect(
        (res.body.items as Json[]).map((q) => q.queue),
        role,
      ).toEqual(queues);
      expect(projectionViolations(res.body, { opId: 'admin.work_summary', vins: h.vins, tradeAllowed: false })).toEqual([]);
    }
    // Several roles: the union, in the fixed order.
    const both = await summary(await h.staff('platform_support', 'platform_community_reviewer'));
    expect((both.body.items as Json[]).map((q) => q.queue)).toEqual(['review_approvals', 'reports', 'disputes', 'privacy_requests']);
    // The clock: the caller's CarPal-Timezone, else the pilot region's.
    expect((await summary(adm)).body.time_zone).toBe('Asia/Tehran');
    expect((await summary(adm, { 'carpal-timezone': 'Europe/Berlin' })).body.time_zone).toBe('Europe/Berlin');
  });

  it('counts verifications with the caller share, paused clocks and breaches', async () => {
    const mod = await h.staff('platform_moderator');
    const before = queue(await summary(mod), 'verifications');
    const submit = async () => {
      const owner = await h.member('provider');
      return ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications`, { verification_type: 'business_identity' }), 'verify')
        .id as string;
    };
    const [a, b, c] = [await submit(), await submit(), await submit()];
    ok(await mod.c.post(`/v1/admin/verifications/${a}/assign`, { reason: REASON }), 'assign');
    ok(
      await mod.c.post(
        `/v1/admin/verifications/${b}/decision`,
        {
          decision: 'info_requested',
          info_request: { missing_items: ['readable_copy'], template_key: 'unreadable_documents', message: 'Please send a clear copy.' },
          reason: REASON,
        },
        purpose('verification', b),
      ),
      'info request',
    );
    await h.q(sql`UPDATE organization.organization_verifications SET sla_started_at = now() - interval '10 days' WHERE id = ${c}::uuid`);
    const after = queue(await summary(mod), 'verifications');
    const sla = (q: Json) => q.sla as Record<string, number>;
    expect(after.open).toBe((before.open as number) + 3);
    // a assigned to the caller; b assigned on the info request (S19) and paused; c breached.
    expect(after.assigned_to_me).toBe((before.assigned_to_me as number) + 2);
    expect(sla(after).paused).toBe(sla(before).paused! + 1);
    expect(sla(after).breach).toBe(sla(before).breach! + 1);
    expect(Object.values(sla(after)).reduce((x, y) => x + y, 0)).toBe(Math.min(after.open as number, 5000));
    expect(Date.parse(after.oldest_at as string)).toBeLessThanOrEqual(Date.now() - 10 * 86_400_000 + 1000);
    expect(after.next_due_at).toEqual(expect.any(String));
    const another = queue(await summary(await h.staff('platform_moderator')), 'verifications');
    expect(another.assigned_to_me).toBe(0);
  });

  it('counts reports, cases and four-eyes changes the caller may decide, with breakdowns', async () => {
    const mod = await h.staff('platform_moderator');
    const before = await summary(mod);
    const target = await h.user();
    const reporter = await h.user();
    ok(await reporter.c.post('/v1/reports', { target_type: 'user', target_id: target.user.id, reason: 'privacy' }), 'report');
    const rep2 = ok(
      await reporter.c.post('/v1/reports', { target_type: 'user', target_id: (await h.user()).user.id, reason: 'spam' }),
      'report',
    );
    const triaged = ok(
      await mod.c.post(`/v1/admin/reports/${rep2.report_id as string}/triage`, { open_case: { severity: 'critical' }, reason: REASON }),
      'triage',
    );
    ok(await mod.c.post(`/v1/admin/moderation/cases/${triaged.moderation_case_id as string}/assign`, { reason: REASON }), 'assign');
    const after = await summary(mod);
    const key = (q: Json, k: string) => (q.breakdown as { key: string; open: number }[]).find((b) => b.key === k)?.open ?? 0;
    const [rb, ra] = [queue(before, 'reports'), queue(after, 'reports')];
    expect(ra.open).toBe((rb.open as number) + 1); // the spam report left the queue when it was triaged
    expect(key(ra, 'reason:privacy')).toBe(key(rb, 'reason:privacy') + 1);
    const [cb, ca] = [queue(before, 'cases'), queue(after, 'cases')];
    expect(ca.open).toBe((cb.open as number) + 1);
    expect(ca.assigned_to_me).toBe((cb.assigned_to_me as number) + 1);
    expect(key(ca, 'severity:critical')).toBe(key(cb, 'severity:critical') + 1);
    expect(key(ca, 'source:user_report')).toBe(key(cb, 'source:user_report') + 1);

    // A four-eyes change: never in the requester's own queue, in another admin's, not in a moderator's (admin change).
    const other = await h.staff('platform_admin');
    const [mine0, other0, mod0] = [
      queue(await summary(adm), 'four_eyes'),
      queue(await summary(other), 'four_eyes'),
      queue(after, 'four_eyes'),
    ];
    const asked = ok(
      await adm.c.post('/v1/admin/retention-policies', {
        entity_type: `S21Queue${Date.now()}`,
        applies_to_status: null,
        retention_days: 30,
        action: 'archive',
        legal_basis: null,
        status: 'inactive',
        reason: REASON,
      }),
      'retention create',
    );
    expect(queue(await summary(adm), 'four_eyes').open).toBe(mine0.open);
    expect(queue(await summary(other), 'four_eyes').open).toBe((other0.open as number) + 1);
    expect(queue(await summary(mod), 'four_eyes').open).toBe(mod0.open);
    await h.rejectChange(asked.change_id as string);
  });
});
