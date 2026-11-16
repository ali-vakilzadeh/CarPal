// S25a (contract 1.4.0; backend/BR-update-plan.json S25a, owner decisions of 2026-11-16): the admin-plane AAL3 window
// of 5 minutes (S16a-D4), the rest of the A-NOTIF-01 rules and Delivery health (S17-D4), the rejected-verification
// notice (S19), the author of a content action as a party who can appeal (S20), removal outcomes of upheld disputes
// waiting for a different administrator's fairness approval (DQ-22), and the automatic no_response close of support
// tickets (DQ-23, S24-D8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupportAutoCloseRule } from '#modules/admin/application/support-ops.js';
import { ApprovalReminderRule } from '#modules/trust/application/review-workflow.js';
import { VehicleReminderRule } from '#modules/vehicle/vehicle.module.js';
import { sharedProvider } from './contract/domain.js';
import { api, Harness, ok, sql, type Actor, type Json, type Published } from './contract/harness.js';
import { ADMIN_CLIENT, purpose, REASON } from './s8-support.js';

let h: Harness;
let mod: Actor;
let crv: Actor;
let adm: Actor;
let p: Published;

const now = () => Math.floor(Date.now() / 1000);

/** The same staff member with a session that stepped up `ageS` seconds ago. */
async function aged(staff: Actor, ageS: number) {
  const token = await h.fx.token(staff.user, { staff: true, authTime: now() - ageS });
  return api(h.admin, token, ADMIN_CLIENT);
}

/** A published Path 1 review of the provider by a new author (as W4 publishes a verified visit). */
async function publishedReview(subject: Published = p) {
  const author = await h.user();
  const r = ok(
    await author.c.post('/v1/reviews', {
      subject_organization_id: subject.id,
      subject_type: 'provider',
      overall_rating: 2,
      title: 'Noise came back',
      body: 'They fixed the noise but it came back after a week and nobody called back.',
      content_locale: 'en',
    }),
    'review',
  );
  await h.q(sql`UPDATE trust.reviews SET confirmation_path = 'visit_based', verified_status = 'admin_verified',
      business_confirmation_status = NULL, business_confirmation_due_at = NULL, reviewer_decision = NULL,
      status = 'published', published_at = now(), trust_weight = '1.000', counts_toward_core_score = true
    WHERE id = ${r.id as string}::uuid`);
  return { author, id: r.id as string };
}

const reviewStatus = async (id: string) =>
  (await h.q<{ status: string }>(sql`SELECT status FROM trust.reviews WHERE id = ${id}::uuid`))[0]!.status;

const caseFor = async (type: string, targetId: string) => {
  const [row] = await h.q<{ id: string }>(sql`
    INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity)
    VALUES (${type}, ${type}, ${targetId}::uuid, 'admin', 'other', 'low') RETURNING id`);
  return row!.id;
};

const act = (caseId: string, body: Json, as: Actor = mod) =>
  as.c.post(`/v1/admin/moderation/cases/${caseId}/actions`, { reason: REASON, ...body }, purpose('case', caseId));

const resolve = (disputeId: string, body: Json, as: Actor = crv) =>
  as.c.post(`/v1/admin/disputes/${disputeId}/resolution`, { reason: REASON, ...body }, purpose('dispute', disputeId));

const decide = (changeId: string, decision: 'approve' | 'reject', as: Actor) =>
  as.c.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision, reason: REASON });

async function restoreRules(): Promise<void> {
  await h.q(sql`UPDATE notification.notification_rules
    SET review_approval_reminder_days = '{3,6}', maintenance_due_window_days = 14, mileage_due_window_km = 500
    WHERE rule_set = 'default'`);
}

beforeAll(async () => {
  h = await Harness.start();
  mod = await h.staff('platform_moderator');
  crv = await h.staff('platform_community_reviewer');
  adm = await h.staff('platform_admin');
  p = await sharedProvider(h);
  await restoreRules();
}, 120_000);

afterAll(async () => {
  await restoreRules();
  await h?.close();
});

describe('T1: admin-plane AAL3 within 5 minutes (SEC-ADM-2, S16a-D4)', () => {
  it('admin.four_eyes_decide refuses an aal3 older than 5 minutes with max_age=300; a fresh one passes the step-up', async () => {
    const stale = await aged(adm, 301);
    const refused = await stale.post(`/v1/admin/four-eyes/${h.newId()}/decision`, { decision: 'reject', reason: REASON });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('STEP_UP_REQUIRED');
    expect(refused.headers['www-authenticate']).toContain('acr_values="aal3", max_age=300');
    // Within 5 minutes the step-up passes (the unknown change is then 404).
    const fresh = await aged(adm, 240);
    expect((await fresh.post(`/v1/admin/four-eyes/${h.newId()}/decision`, { decision: 'reject', reason: REASON })).status).toBe(404);
  });

  it('admin.case_action conditional AAL3 (suspend_account) uses the 5-minute window too', async () => {
    const target = await h.user();
    const caseId = await caseFor('user', target.user.id);
    const stale = await aged(mod, 400);
    const refused = await stale.post(
      `/v1/admin/moderation/cases/${caseId}/actions`,
      { action_type: 'suspend_account', target: { type: 'user', id: target.user.id }, reason: REASON },
      purpose('case', caseId),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers['www-authenticate']).toContain('max_age=300');
    // An action without step-up still works on the same stale session.
    const warned = await stale.post(
      `/v1/admin/moderation/cases/${caseId}/actions`,
      { action_type: 'warn_user', target: { type: 'user', id: target.user.id }, reason: REASON },
      purpose('case', caseId),
    );
    expect(warned.status, warned.text).toBe(201);
  });

  it('consumer step-up keeps the 10-minute window', async () => {
    const u = await h.user();
    const token = await h.fx.token(u.user, { acr: 'aal2', authTime: now() - 400 });
    const res = await api(h.api, token, u.client).post('/v1/me/sessions/revoke-all');
    expect(res.status, res.text).not.toBe(401);
  });
});

describe('T2: the rest of the A-NOTIF-01 rules and Delivery health (S17-D4)', () => {
  it('the rules carry the approval reminder days and the maintenance and mileage due windows; days must ascend', async () => {
    const rules = ok(await adm.c.get('/v1/admin/notification-rules'), 'rules');
    expect(rules).toMatchObject({ review_approval_reminder_days: [3, 6], maintenance_due_window_days: 14, mileage_due_window_km: 500 });
    const { updated_by_display: _by, updated_at: _at, version, ...values } = rules;
    const ifMatch = { 'if-match': `"v${version as number}"` };
    const bad = await adm.c.put(
      '/v1/admin/notification-rules',
      { ...values, review_approval_reminder_days: [5, 2], reason: REASON },
      ifMatch,
    );
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ pointer: '/review_approval_reminder_days/1', code: 'order' })]);
    const range = await adm.c.put('/v1/admin/notification-rules', { ...values, mileage_due_window_km: 10, reason: REASON }, ifMatch);
    expect(range.status).toBe(422);
    const okRes = await adm.c.put(
      '/v1/admin/notification-rules',
      { ...values, review_approval_reminder_days: [2, 4, 6], maintenance_due_window_days: 30, mileage_due_window_km: 1000, reason: REASON },
      ifMatch,
    );
    expect(okRes.status, okRes.text).toBe(200);
    expect(okRes.body).toMatchObject({
      review_approval_reminder_days: [2, 4, 6],
      maintenance_due_window_days: 30,
      mileage_due_window_km: 1000,
    });
    await restoreRules();
  });

  it('a Path 2 review waiting for the business is reminded on days 3 and 6 after the request, once each', async () => {
    const author = await h.user();
    const r = ok(
      await author.c.post('/v1/reviews', {
        subject_organization_id: p.id,
        subject_type: 'provider',
        overall_rating: 4,
        title: 'Quick oil change',
        body: 'They changed the oil quickly and explained what they did. Fair price.',
        content_locale: 'en',
      }),
      'review',
    );
    expect(await reviewStatus(r.id as string)).toBe('pending_approval');
    const rule = h.worker.get(ApprovalReminderRule, { strict: false });
    const requestedDaysAgo = async (days: number) =>
      h.q(sql`UPDATE trust.reviews SET business_confirmation_due_at = now() + make_interval(secs => ${(7 - days) * 86_400})
        WHERE id = ${r.id as string}::uuid`);
    const count = async () =>
      (await h.q<{ n: number }>(sql`SELECT business_reminder_count AS n FROM trust.reviews WHERE id = ${r.id as string}::uuid`))[0]!.n;
    const reminders = async () =>
      h.q<{ template_params: Json }>(sql`SELECT template_params FROM notification.notifications
        WHERE recipient_user_id = ${p.as.user.id}::uuid AND template_key = 'review.approval_reminder'
          AND reference_entity_id = ${r.id as string}::uuid ORDER BY created_at`);

    await requestedDaysAgo(2);
    await rule.run();
    expect(await count()).toBe(0);
    await requestedDaysAgo(3.1);
    await rule.run();
    expect(await count()).toBe(1);
    await rule.run();
    expect(await count()).toBe(1);
    await requestedDaysAgo(6.2);
    await rule.run();
    expect(await count()).toBe(2);
    await rule.run();
    await h.settle();
    const sent = await reminders();
    expect(sent).toHaveLength(2);
    expect(sent.map((n) => n.template_params.days_left)).toEqual([4, 1]);
    // An answered review is never reminded.
    await h.q(sql`UPDATE trust.reviews SET business_reminder_count = 0, business_confirmation_status = 'confirmed'
      WHERE id = ${r.id as string}::uuid`);
    await rule.run();
    expect(await count()).toBe(0);
  });

  it('the vehicle sweep follows the maintenance due window; a narrower window does not take a due reminder back', async () => {
    const owner = await h.user();
    const vehicleId = await h.vehicle(owner);
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const rem = `/v1/me/vehicles/${vehicleId}/reminders`;
    const created = ok(
      await owner.c.post(rem, { reminder_type: 'oil', title: 'Oil change', priority: 'medium', due_by_date: day(20) }),
      'reminder',
    );
    expect(created.status).toBe('upcoming');
    const sweep = h.worker.get(VehicleReminderRule, { strict: false });
    await sweep.run();
    const status = async () => ((await owner.c.get(rem)).body.items as Json[]).find((x) => x.id === created.id)!.status;
    expect(await status()).toBe('upcoming');
    await h.q(sql`UPDATE notification.notification_rules SET maintenance_due_window_days = 30 WHERE rule_set = 'default'`);
    await sweep.run();
    expect(await status()).toBe('due');
    await h.q(sql`UPDATE notification.notification_rules SET maintenance_due_window_days = 7 WHERE rule_set = 'default'`);
    await sweep.run();
    expect(await status()).toBe('due');
    await restoreRules();
  });

  it('Delivery health lists every channel by provider with 24 h, 7 and 30 day windows (administrators only)', async () => {
    await h.settle();
    const res = await adm.c.get('/v1/admin/notification-delivery-health');
    expect(res.status, res.text).toBe(200);
    const rows = res.body.rows as Json[];
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['email', 'push', 'sms']));
    // Lite mode sends through the file sinks: the reminders above went out by email.
    const email = rows.find((r) => r.channel === 'email' && r.provider === 'file')!;
    expect(email.last_24h.attempted).toBeGreaterThanOrEqual(1);
    expect(email.last_30d.attempted).toBeGreaterThanOrEqual(email.last_24h.attempted);
    // A failure counts in every window and sets the rate and the last failure.
    const [d] = await h.q<{ id: string }>(sql`SELECT id FROM notification.notification_deliveries
      WHERE channel = 'email' AND provider = 'file' AND status = 'sent' ORDER BY updated_at DESC LIMIT 1`);
    await h.q(sql`UPDATE notification.notification_deliveries SET status = 'failed', last_error = 'S25a test' WHERE id = ${d!.id}::uuid`);
    const after = ((await adm.c.get('/v1/admin/notification-delivery-health')).body.rows as Json[]).find(
      (r) => r.channel === 'email' && r.provider === 'file',
    )!;
    expect(after.last_24h.failed).toBeGreaterThanOrEqual(1);
    expect(Number(after.last_24h.failure_rate)).toBeGreaterThan(0);
    expect(after.last_failure_at).toBeTruthy();
    expect(JSON.stringify(after)).not.toContain('S25a test');
    expect((await mod.c.get('/v1/admin/notification-delivery-health')).status).toBe(404);
  });
});

describe('T3: a rejected verification tells the business what to fix (Docs/23 A-VER-02)', () => {
  it('notifies the owners and managers with the rejection reason, never the reviewer', async () => {
    const owner = await h.member('provider');
    const manager = await h.colleague(owner, 'provider_manager');
    const staffMember = await h.colleague(owner, 'provider_staff');
    const v = ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications`, { verification_type: 'business_identity' }), 'verification');
    const reason = 'The registration certificate is cut off; send a full, readable copy.';
    const res = await mod.c.post(
      `/v1/admin/verifications/${v.id as string}/decision`,
      { decision: 'rejected', rejection_reason: reason, reason: REASON },
      purpose('verification', v.id as string),
    );
    expect(res.status, res.text).toBe(200);
    await h.settle();
    const notes = await h.q<{ recipient_user_id: string; template_params: Json; reference_entity_type: string }>(sql`
      SELECT recipient_user_id, template_params, reference_entity_type FROM notification.notifications
       WHERE template_key = 'organization.verification_rejected' AND reference_entity_id = ${v.id as string}::uuid`);
    expect(new Set(notes.map((n) => n.recipient_user_id))).toEqual(new Set([owner.user.id, manager.user.id]));
    expect(notes.map((n) => n.recipient_user_id)).not.toContain(staffMember.user.id);
    expect(notes[0]!.template_params).toEqual({ verification_type: 'business_identity', rejection_reason: reason });
    expect(notes[0]!.reference_entity_type).toBe('organization_verification');
    expect(JSON.stringify(notes)).not.toContain(mod.user.id);
    const mails = await h.q<{ n: number }>(sql`SELECT count(*)::int AS n FROM notification.notification_deliveries d
      JOIN notification.notifications n ON n.id = d.notification_id
     WHERE n.template_key = 'organization.verification_rejected' AND n.reference_entity_id = ${v.id as string}::uuid AND d.channel = 'email'`);
    expect(mails[0]!.n).toBe(2);
  });
});

describe('T4: the author of a content action is a party and can appeal (S20 found while testing)', () => {
  it('hide and remove record the author; the author appeal is accepted; the subject organization keeps its own route', async () => {
    const r = await publishedReview();
    const caseId = await caseFor('review', r.id);
    const removed = ok(await act(caseId, { action_type: 'remove', target: { type: 'review', id: r.id } }), 'remove');
    const [affects] = await h.q<{ user_id: string | null; organization_id: string | null }>(
      sql`SELECT user_id, organization_id FROM admin.moderation_action_affects(${removed.id as string}::uuid)`,
    );
    expect(affects).toEqual({ user_id: r.author.user.id, organization_id: p.id });
    const appeal = await r.author.c.post('/v1/disputes', {
      target: { type: 'moderation_action', id: removed.id },
      dispute_type: 'moderation_appeal',
      reason: 'My review describes my visit and has no personal data.',
    });
    expect(appeal.status, appeal.text).toBe(201);
    // Someone else still cannot appeal it.
    const other = await h.user();
    const refused = await other.c.post('/v1/disputes', {
      target: { type: 'moderation_action', id: removed.id },
      dispute_type: 'moderation_appeal',
      reason: 'I liked that review and want it back.',
    });
    expect(refused.status).toBe(422);
    // The subject organization can appeal a hide of a review about it (its own route, unchanged).
    const r2 = await publishedReview();
    const hidden = ok(await act(await caseFor('review', r2.id), { action_type: 'hide', target: { type: 'review', id: r2.id } }), 'hide');
    const orgAppeal = await p.as.c.post('/v1/disputes', {
      target: { type: 'moderation_action', id: hidden.id },
      dispute_type: 'moderation_appeal',
      reason: 'The review was hidden by mistake; we want it visible.',
      raised_by_organization_id: p.id,
    });
    expect(orgAppeal.status, orgAppeal.text).toBe(201);

    // A restoring outcome (upheld appeal) applies at once (DQ-22 covers removals only).
    const upheld = await resolve(appeal.body.id as string, { status: 'resolved_upheld', resolution: 'The review is accurate.' });
    expect(upheld.status, upheld.text).toBe(200);
    expect(upheld.body.status).toBe('resolved_upheld');
    expect(await reviewStatus(r.id)).toBe('published');
  });
});

describe('T5: removal outcomes wait for a different administrator (DQ-22)', () => {
  async function fakeReviewDispute() {
    const r = await publishedReview();
    const d = ok(
      await p.as.c.post('/v1/disputes', {
        target: { type: 'review', id: r.id },
        dispute_type: 'fake_review',
        reason: 'This customer never visited us; the plate is not in our records.',
        raised_by_organization_id: p.id,
      }),
      'dispute',
    );
    return { review: r, id: d.id as string };
  }

  it('an upheld fake_review answers 202, changes nothing, and is applied only by another administrator', async () => {
    const d = await fakeReviewDispute();
    const res = await resolve(d.id, { status: 'resolved_upheld', resolution: 'The visit could not be confirmed.' });
    expect(res.status, res.text).toBe(202);
    expect(res.body).toMatchObject({ op_id: 'admin.dispute_resolve', status: 'pending' });
    const changeId = res.body.change_id as string;
    expect(await reviewStatus(d.review.id)).toBe('published');
    const detail = ok(await crv.c.get(`/v1/admin/disputes/${d.id}`, purpose('dispute', d.id)), 'detail');
    expect(detail).toMatchObject({ status: 'open', pending_change_id: changeId, resolved_at: null });
    expect(detail.assigned_to_display).toBeTruthy();
    // One pending resolution at a time.
    expect((await resolve(d.id, { status: 'resolved_upheld', resolution: 'Again.' })).status).toBe(409);
    // A moderator cannot see or approve it (admin changes only).
    const otherMod = await h.staff('platform_moderator');
    expect((await decide(changeId, 'approve', otherMod)).status).toBe(404);
    // The approving administrator needs a fresh aal3 (5 minutes).
    expect(
      (await (await aged(adm, 400)).post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'approve', reason: REASON })).status,
    ).toBe(401);
    const approved = await decide(changeId, 'approve', adm);
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(await reviewStatus(d.review.id)).toBe('removed');
    const [row] = await h.q<{ status: string; resolved_by: string }>(
      sql`SELECT status, resolved_by FROM trust.disputes WHERE id = ${d.id}::uuid`,
    );
    expect(row).toEqual({ status: 'resolved_upheld', resolved_by: crv.user.id });
    const [action] = await h.q<{ actor_user_id: string; params: Json }>(sql`SELECT actor_user_id, params FROM admin.moderation_actions
      WHERE target_entity_id = ${d.review.id}::uuid AND action_type = 'remove' AND params ->> 'dispute_id' = ${d.id}`);
    expect(action).toMatchObject({ actor_user_id: crv.user.id, params: { approved_by: adm.user.id, fake: true } });
    const audit = await h.q<{ action: string }>(
      sql`SELECT action FROM analytics.audit_logs WHERE entity_id = ${d.id}::uuid ORDER BY created_at`,
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'dispute.resolution_requested',
        'admin.four_eyes_requested',
        'admin.four_eyes_approved',
        'dispute.status_changed',
      ]),
    );
  });

  it('a rejected or expired approval leaves the dispute open with its assignee and the content in place', async () => {
    const d = await fakeReviewDispute();
    const pending = await resolve(d.id, { status: 'resolved_upheld', resolution: 'The visit could not be confirmed.' });
    expect(pending.status).toBe(202);
    ok(await decide(pending.body.change_id as string, 'reject', adm), 'reject');
    expect(await reviewStatus(d.review.id)).toBe('published');
    const [row] = await h.q<{ status: string; assigned_to: string }>(
      sql`SELECT status, assigned_to FROM trust.disputes WHERE id = ${d.id}::uuid`,
    );
    expect(row).toEqual({ status: 'open', assigned_to: crv.user.id });
    expect(ok(await crv.c.get(`/v1/admin/disputes/${d.id}`, purpose('dispute', d.id)), 'detail').pending_change_id).toBeNull();
    // The resolver may ask again; rejecting the claim applies at once.
    const again = await resolve(d.id, { status: 'resolved_upheld', resolution: 'Second look.' });
    expect(again.status).toBe(202);
    await h.expirePending(d.id);
    const rejected = await resolve(d.id, { status: 'resolved_rejected', resolution: 'The author showed the invoice.' });
    expect(rejected.status, rejected.text).toBe(200);
    expect(await reviewStatus(d.review.id)).toBe('published');
  });

  it('an upheld badge challenge waits too; the badge stays active until approval', async () => {
    // A provider of its own: the shared one carries the fake-review penalty above, which revokes all its badges (54 §3.3).
    const own = await h.provider();
    const badge = h.newId();
    await h.sys((db) =>
      db
        .insertInto('trust.provider_badges')
        .values({
          id: badge,
          provider_organization_id: own.id,
          badge_type: 'highly_rated',
          rule_key: 'highly_rated',
          rule_version: '54-2026-10',
          evaluation_snapshot: JSON.stringify({ rating: 4.8 }),
          requires_admin_approval: false,
          status: 'active',
        })
        .execute(),
    );
    const challenger = await h.user();
    const d = ok(
      await challenger.c.post('/v1/disputes', {
        target: { type: 'badge', id: badge },
        dispute_type: 'badge_challenge',
        reason: 'This garage has many removed reviews lately.',
      }),
      'challenge',
    );
    const res = await resolve(d.id as string, { status: 'resolved_upheld', resolution: 'The rating relied on removed reviews.' }, mod);
    expect(res.status, res.text).toBe(202);
    const badgeStatus = async () =>
      (await h.q<{ status: string }>(sql`SELECT status FROM trust.provider_badges WHERE id = ${badge}::uuid`))[0]!.status;
    expect(await badgeStatus()).toBe('active');
    ok(await decide(res.body.change_id as string, 'approve', adm), 'approve');
    expect(await badgeStatus()).toBe('revoked');
  });
});

describe('T6: tickets waiting on the user are solved as no_response after 7 days (DQ-23)', () => {
  it('solves by the system, notifies, audits; a fresh one and one waiting on the team stay; a late reply reopens', async () => {
    const sup = await h.staff('platform_support');
    const fileTicket = async (as: Actor) =>
      ok(
        await as.c.post('/v1/support/tickets', {
          topic: 'bug',
          subject: 'The map stays grey',
          body: 'The map stays grey after I open it on my phone.',
        }),
        'ticket',
      ).id as string;
    const user = await h.user();
    const old = await fileTicket(user);
    const fresh = await fileTicket(await h.user());
    const team = await fileTicket(await h.user());
    for (const id of [old, fresh])
      ok(
        await sup.c.post(
          `/v1/admin/support/tickets/${id}/messages`,
          { template_key: 'request_information', body: 'Which phone do you use?', reason: REASON },
          purpose('ticket', id),
        ),
        'reply',
      );
    await h.q(sql`UPDATE admin.support_tickets SET last_message_at = now() - interval '8 days' WHERE id IN (${old}::uuid, ${team}::uuid)`);
    const closed = await h.worker.get(SupportAutoCloseRule, { strict: false }).run();
    expect(closed).toBeGreaterThanOrEqual(1);
    const rows = await h.q<{ id: string; status: string; outcome: string | null; solved_by: string | null }>(
      sql`SELECT id, status, outcome, solved_by FROM admin.support_tickets WHERE id IN (${old}::uuid, ${fresh}::uuid, ${team}::uuid)`,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old)).toMatchObject({ status: 'solved', outcome: 'no_response', solved_by: null });
    expect(byId.get(fresh)!.status).toBe('waiting_on_user');
    expect(byId.get(team)!.status).toBe('new');
    const [audit] = await h.q<{ actor_type: string; new_state_summary: string }>(
      sql`SELECT actor_type, new_state_summary FROM analytics.audit_logs WHERE entity_id = ${old}::uuid AND action = 'support.ticket_solved'`,
    );
    expect(audit).toEqual({ actor_type: 'system', new_state_summary: 'solved: no_response (automatic)' });
    await h.settle();
    const notes = await h.q<{ n: number }>(sql`SELECT count(*)::int AS n FROM notification.notifications
      WHERE recipient_user_id = ${user.user.id}::uuid AND template_key = 'support.ticket_solved'`);
    expect(notes[0]!.n).toBe(1);
    // The 14-day reopen still works.
    const back = await user.c.post(`/v1/support/tickets/${old}/messages`, { body: 'Sorry, I was away. It is an old Android phone.' });
    expect(back.status, back.text).toBe(201);
    expect(ok(await user.c.get(`/v1/support/tickets/${old}`), 'ticket').status).toBe('waiting_on_team');
  });
});
