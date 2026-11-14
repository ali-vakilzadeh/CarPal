// S20 (contract 1.4.0; backend/BR-update-plan.json S20): disputes and review/inventory moderation actions. Dispute
// message threads, one per party, read only by that party and by staff under the dispute purpose (BR-28); dispute
// target snapshots and the other party; withdrawal on request with the request as the resolution (BR-28); the
// objection outcomes keep their values (BR-30, DQ-06, docs only); reduce_weight, edit_request and downgrade_fitment
// (BR-15). Records come from the contract sweep's fixtures (Harness).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModerationTargets } from '#modules/admin/interface/admin.js';
import { ReviewWorkflow } from '#modules/trust/application/review-workflow.js';
import { TrustScorer } from '#modules/trust/application/trust-scorer.js';
import { sharedProvider } from './contract/domain.js';
import { Harness, ok, sql, type Actor, type Json, type Published } from './contract/harness.js';
import { projectionViolations } from './contract/projection.js';
import { purpose, REASON } from './s8-support.js';

let h: Harness;
let mod: Actor;
let p: Published;

/** A published Path 1 review of the provider (as W4 publishes a verified visit). */
async function publishedReview(subject: Published, rating = 2, o: { title?: string; body?: string } = {}) {
  const author = await h.user();
  const r = ok(
    await author.c.post('/v1/reviews', {
      subject_organization_id: subject.id,
      subject_type: 'provider',
      overall_rating: rating,
      title: o.title ?? 'Noise came back',
      body: o.body ?? 'They fixed the noise but it came back after a week. Plate 12-ABC-345 is in the photo.',
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

/** A dispute the provider raises about a review (inaccurate_review): the review's author is the other party. */
async function orgDispute() {
  const r = await publishedReview(p);
  const d = ok(
    await p.as.c.post('/v1/disputes', {
      target: { type: 'review', id: r.id },
      dispute_type: 'inaccurate_review',
      reason: 'The work was redone for free the next day.',
      raised_by_organization_id: p.id,
    }),
    'dispute',
  );
  return { review: r, id: d.id as string };
}

const staffPost = (disputeId: string, side: 'raiser' | 'respondent', o: Json = {}, as: Actor = mod) =>
  as.c.post(
    `/v1/admin/disputes/${disputeId}/messages`,
    { side, template_key: 'request_information', body: 'Please tell us more.', reason: REASON, ...o },
    purpose('dispute', disputeId),
  );

const caseFor = async (type: string, targetId: string) => {
  const [row] = await h.q<{ id: string }>(sql`
    INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity)
    VALUES (${type}, ${type}, ${targetId}::uuid, 'admin', 'other', 'low') RETURNING id`);
  return row!.id;
};

const act = (caseId: string, body: Json, as: Actor = mod) =>
  as.c.post(`/v1/admin/moderation/cases/${caseId}/actions`, { reason: REASON, ...body }, purpose('case', caseId));

beforeAll(async () => {
  h = await Harness.start();
  mod = await h.staff('platform_moderator');
  p = await sharedProvider(h);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('dispute message threads (BR-28)', () => {
  it('only the parties and staff with the dispute purpose read a thread; each party sees its own side only', async () => {
    const d = await orgDispute();
    const author = d.review.author;
    // Before CarPal writes to the other party, the author has no thread (and never the raiser's statement).
    expect((await author.c.get(`/v1/disputes/${d.id}/messages`)).status).toBe(404);
    expect((await author.c.get(`/v1/disputes/${d.id}`)).status).toBe(404);

    ok(
      await staffPost(d.id, 'raiser', {
        body: 'When was the work redone?',
        reply_due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      }),
      'to raiser',
    );
    const toAuthor = await staffPost(d.id, 'respondent', { template_key: 'request_evidence', body: 'Please add your invoice.' });
    expect(toAuthor.status, toAuthor.text).toBe(201);
    expect(toAuthor.body).toMatchObject({
      side: 'respondent',
      author: 'staff',
      author_display: 'CarPal',
      template_key: 'request_evidence',
    });
    expect(toAuthor.body.staff_author_display).toBeTruthy();

    // The raising organization: its thread with the due date; "CarPal", never the moderator's name.
    const raiser = await p.as.c.get(`/v1/disputes/${d.id}/messages?organization_id=${p.id}`);
    expect(raiser.status, raiser.text).toBe(200);
    expect(raiser.body).toMatchObject({ side: 'raiser', can_reply: true, dispute_type: 'inaccurate_review' });
    expect(raiser.body.reply_due_at).toBeTruthy();
    expect((raiser.body.items as Json[]).map((m) => m.body)).toEqual(['When was the work redone?']);
    expect(raiser.text).not.toContain(toAuthor.body.staff_author_display as string);

    // The author (respondent): only its own thread, and still not the dispute itself.
    const mine = await author.c.get(`/v1/disputes/${d.id}/messages`);
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.side).toBe('respondent');
    expect((mine.body.items as Json[]).map((m) => m.body)).toEqual(['Please add your invoice.']);
    expect(mine.text).not.toContain('redone for free');
    expect((await author.c.get(`/v1/disputes/${d.id}`)).status).toBe(404);

    // Anyone else: not found.
    expect((await (await h.user()).c.get(`/v1/disputes/${d.id}/messages`)).status).toBe(404);

    // The author answers with evidence; staff see both threads and the file; the organization does not see the answer.
    const file = await h.upload(author, 'review_evidence');
    const reply = await author.c.post(`/v1/disputes/${d.id}/messages`, { body: 'Invoice attached.', media_ids: [file.id] });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.body).toMatchObject({ side: 'respondent', author: 'party' });
    expect((reply.body.media as Json[]).map((m) => m.media_asset_id)).toEqual([file.id]);
    expect((await p.as.c.get(`/v1/disputes/${d.id}/messages?organization_id=${p.id}`)).text).not.toContain('Invoice attached');

    const all = await mod.c.get(`/v1/admin/disputes/${d.id}/messages`, purpose('dispute', d.id));
    expect(all.status, all.text).toBe(200);
    expect((all.body.items as Json[]).map((m) => [m.side, m.author])).toEqual([
      ['raiser', 'staff'],
      ['respondent', 'staff'],
      ['respondent', 'party'],
    ]);
    expect(((all.body.items as Json[])[2]!.media as Json[]).length).toBe(1);
    const sideOnly = await mod.c.get(`/v1/admin/disputes/${d.id}/messages?side=raiser`, purpose('dispute', d.id));
    expect((sideOnly.body.items as Json[]).length).toBe(1);
    // The evidence file is about the dispute: staff download it under the dispute purpose.
    const dl = await mod.c.post(`/v1/admin/media/${file.id as string}/download-url`, { variant: 'original' }, purpose('dispute', d.id));
    expect(dl.status, dl.text).toBe(200);

    // Staff need the purpose of this dispute (PURP, S14).
    const other = await orgDispute();
    expect((await mod.c.get(`/v1/admin/disputes/${d.id}/messages`, purpose('dispute', other.id))).status).toBe(403);
    const wrong = await mod.c.post(
      `/v1/admin/disputes/${d.id}/messages`,
      { side: 'raiser', template_key: 'other', body: 'Another question.', reason: REASON },
      purpose('dispute', other.id),
    );
    expect(wrong.status).toBe(403);
    const [audit] = await h.q<{ n: string }>(
      sql`SELECT count(*) AS n FROM analytics.audit_logs WHERE action = 'dispute.message_posted' AND entity_id = ${d.id}::uuid`,
    );
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(2);
  });

  it('notifies the party of a staff message, refuses closed disputes and moderation appeals without another party', async () => {
    const d = await orgDispute();
    ok(await staffPost(d.id, 'respondent'), 'to author');
    await h.settle();
    const [n] = await h.q<{ template_key: string }>(sql`SELECT template_key FROM notification.notifications
      WHERE recipient_user_id = ${d.review.author.user.id}::uuid AND template_key = 'dispute.message_received'`);
    expect(n?.template_key).toBe('dispute.message_received');

    // A party reply is refused once the dispute is closed.
    const resolved = await mod.c.post(
      `/v1/admin/disputes/${d.id}/resolution`,
      { status: 'resolved_rejected', resolution: 'The review describes the first visit accurately.', reason: REASON },
      purpose('dispute', d.id),
    );
    expect(resolved.status, resolved.text).toBe(200);
    expect((await d.review.author.c.post(`/v1/disputes/${d.id}/messages`, { body: 'One more thing.' })).status).toBe(409);
    // Staff: the dispute purpose ends with the resolution, so the thread is closed to them too (404, like any closed item).
    expect((await staffPost(d.id, 'raiser')).status).toBe(404);

    // A moderation appeal has no other party (CarPal decided).
    const target = await publishedReview(p);
    const caseId = await caseFor('review', target.id);
    const action = ok(await act(caseId, { action_type: 'warn_user' }), 'warn');
    const appeal = ok(
      await target.author.c.post('/v1/disputes', {
        target: { type: 'moderation_action', id: action.id },
        dispute_type: 'moderation_appeal',
        reason: 'My review was accurate and has no personal data.',
      }),
      'appeal',
    );
    const other = await h.staff('platform_moderator');
    expect((await staffPost(appeal.id as string, 'respondent', {}, other)).status).toBe(409);
    expect((await staffPost(appeal.id as string, 'raiser', {}, other)).status).toBe(201);
  });
});

describe('dispute detail and withdrawal (BR-28, BR-30)', () => {
  it('admin.dispute_get carries the target snapshot and the other party', async () => {
    const d = await orgDispute();
    const res = await mod.c.get(`/v1/admin/disputes/${d.id}`, purpose('dispute', d.id));
    expect(res.status, res.text).toBe(200);
    expect(res.body.target_snapshot).toMatchObject({ type: 'review', id: d.review.id, available: true });
    expect((res.body.target_snapshot as Json).author).toMatchObject({ user_id: d.review.author.user.id, role: 'member', history: null });
    expect(res.body.respondent).toMatchObject({ party: { type: 'user', id: d.review.author.user.id }, contacted: false });
    expect(projectionViolations(res.body, { opId: 'admin.dispute_get', vins: h.vins, tradeAllowed: false })).toEqual([]);
    ok(await staffPost(d.id, 'respondent'), 'contact');
    expect((await mod.c.get(`/v1/admin/disputes/${d.id}`, purpose('dispute', d.id))).body.respondent).toMatchObject({ contacted: true });

    // An appeal of a moderation action: the action with its decider (staff only).
    const target = await publishedReview(p);
    const decider = await h.staff('platform_moderator');
    const action = ok(await act(await caseFor('review', target.id), { action_type: 'warn_user' }, decider), 'warn');
    const appeal = ok(
      await target.author.c.post('/v1/disputes', {
        target: { type: 'moderation_action', id: action.id },
        dispute_type: 'moderation_appeal',
        reason: 'My review was accurate and has no personal data.',
      }),
      'appeal',
    );
    const got = await mod.c.get(`/v1/admin/disputes/${appeal.id as string}`, purpose('dispute', appeal.id as string));
    expect(got.status, got.text).toBe(200);
    expect(got.body.target_snapshot).toMatchObject({
      type: 'moderation_action',
      available: true,
      action_type: 'warn_user',
      target: { type: 'review', id: target.id },
      reason: REASON,
    });
    expect((got.body.target_snapshot as Json).decided_by_display).toBeTruthy();
    expect(got.body.respondent).toBeNull();
    // The appellant's own view never names the decider.
    expect((await target.author.c.get(`/v1/disputes/${appeal.id as string}`)).text).not.toContain(
      (got.body.target_snapshot as Json).decided_by_display as string,
    );

    // A badge challenge: the badge with its organization.
    const badge = h.newId();
    await h.sys((db) =>
      db
        .insertInto('trust.provider_badges')
        .values({
          id: badge,
          provider_organization_id: p.id,
          badge_type: 'highly_rated',
          rule_key: 'highly_rated',
          rule_version: '54-2026-10',
          evaluation_snapshot: JSON.stringify({ rating: 4.8 }),
          requires_admin_approval: false,
          status: 'active',
        })
        .execute(),
    );
    const challenge = ok(
      await (
        await h.user()
      ).c.post('/v1/disputes', {
        target: { type: 'badge', id: badge },
        dispute_type: 'badge_challenge',
        reason: 'This garage has many removed reviews lately.',
      }),
      'challenge',
    );
    const b = await mod.c.get(`/v1/admin/disputes/${challenge.id as string}`, purpose('dispute', challenge.id as string));
    expect(b.status, b.text).toBe(200);
    expect(b.body.target_snapshot).toMatchObject({
      type: 'badge',
      available: true,
      badge_type: 'highly_rated',
      organization: { id: p.id },
    });
    expect(b.body.respondent).toMatchObject({ party: { type: 'organization', id: p.id } });
  });

  it('withdrawn needs the raiser request as the resolution, sets the decider and closes the threads', async () => {
    const d = await orgDispute();
    const crv = await h.staff('platform_community_reviewer');
    const noReason = await crv.c.post(
      `/v1/admin/disputes/${d.id}/resolution`,
      { status: 'withdrawn', reason: REASON },
      purpose('dispute', d.id),
    );
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toEqual([expect.objectContaining({ pointer: '/resolution', code: 'conditional_required' })]);
    const res = await crv.c.post(
      `/v1/admin/disputes/${d.id}/resolution`,
      { status: 'withdrawn', resolution: 'The business asked by phone to withdraw it (call 2026-11-14).', reason: REASON },
      purpose('dispute', d.id),
    );
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'withdrawn', resolution: expect.stringContaining('asked by phone') });
    const [row] = await h.q<{ resolved_by: string; resolved_at: Date }>(
      sql`SELECT resolved_by, resolved_at FROM trust.disputes WHERE id = ${d.id}::uuid`,
    );
    expect(row!.resolved_by).toBe(crv.user.id);
    expect(row!.resolved_at).toBeTruthy();
    // The review is unchanged (no outcome).
    const [rv] = await h.q<{ status: string }>(sql`SELECT status FROM trust.reviews WHERE id = ${d.review.id}::uuid`);
    expect(rv!.status).toBe('published');
    const mine = await crv.c.get('/v1/admin/me/decisions?kind=dispute');
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.items).toEqual([expect.objectContaining({ dispute_id: d.id, decision: 'withdrawn', dispute_status: 'withdrawn' })]);
    // The database refuses a staff withdrawal without the request.
    await expect(h.q(sql`UPDATE trust.disputes SET resolution = NULL WHERE id = ${d.id}::uuid`)).rejects.toThrow(
      /disputes_staff_withdrawal/,
    );
    // The raiser's own withdrawal still needs no resolution.
    const own = await orgDispute();
    const raiserUser = await p.as.c.post(`/v1/disputes/${own.id}/withdraw`, {});
    expect(raiserUser.status, raiserUser.text).toBe(200);
  });
});

describe('review and fitment moderation actions (BR-15)', () => {
  it('reduce_weight changes the trust score in the next scoring run, and 1 restores it', async () => {
    const org = await h.provider();
    for (let i = 0; i < 3; i++) await publishedReview(org, 5);
    const bad = await publishedReview(org, 1);
    const scorer = h.worker.get(TrustScorer, { strict: false });
    const before = await scorer.recompute(org.id);
    expect(before).not.toBeNull();
    const caseId = await caseFor('review', bad.id);
    // Step-up and the parameter are required.
    expect((await act(caseId, { action_type: 'reduce_weight' })).status).toBe(422);
    expect((await act(caseId, { action_type: 'reduce_weight', params: { weight_factor: '1.5' } })).status).toBe(422);
    const res = await act(caseId, { action_type: 'reduce_weight', params: { weight_factor: '0' } });
    expect(res.status, res.text).toBe(201);
    expect(res.body.action_type).toBe('reduce_weight');
    const [w] = await h.q<{ weight_factor: string; status: string }>(
      sql`SELECT weight_factor, status FROM trust.reviews WHERE id = ${bad.id}::uuid`,
    );
    expect(w).toEqual({ weight_factor: '0.000', status: 'published' });
    const after = await scorer.recompute(org.id);
    expect(after).not.toBe(before);
    ok(await act(caseId, { action_type: 'reduce_weight', params: { weight_factor: '1' } }), 'restore weight');
    expect(await scorer.recompute(org.id)).toBe(before);
    const [log] = await h.q<{ params: Json }>(
      sql`SELECT params FROM admin.moderation_actions WHERE moderation_case_id = ${caseId}::uuid ORDER BY created_at DESC LIMIT 1`,
    );
    expect(log!.params).toMatchObject({ weight_factor: '1.000', previous_weight_factor: '0.000' });
    // A content action does not take weights.
    expect(
      (await act(await caseFor('user', bad.author.user.id), { action_type: 'reduce_weight', params: { weight_factor: '0.5' } })).status,
    ).toBe(409);
  });

  it('edit_request hides the review until a moderator checks the author edit', async () => {
    const r = await publishedReview(p, 2, { body: 'They fixed the noise but it came back. Call me on 0912 345 6789 if needed.' });
    const caseId = await caseFor('review', r.id);
    const missing = await act(caseId, { action_type: 'edit_request', params: { edit_message: 'Please remove your phone number.' } });
    expect(missing.status).toBe(422);
    const outside = await act(caseId, {
      action_type: 'edit_request',
      params: { edit_spans: [{ field: 'body', start: 0, end: 5000 }], edit_message: 'Please remove your phone number.' },
    });
    expect(outside.status).toBe(422);
    const res = await act(caseId, {
      action_type: 'edit_request',
      params: { edit_spans: [{ field: 'body', start: 48, end: 72 }], edit_message: 'Please remove your phone number.' },
    });
    expect(res.status, res.text).toBe(201);
    expect(
      (
        await act(caseId, {
          action_type: 'edit_request',
          params: { edit_spans: [{ field: 'body', start: 0, end: 4 }], edit_message: 'Again please.' },
        })
      ).status,
    ).toBe(409);

    // Hidden: not public, not counted; the author sees the request (never the moderator).
    const [hidden] = await h.q<{ status: string; counts_toward_core_score: boolean }>(
      sql`SELECT status, counts_toward_core_score FROM trust.reviews WHERE id = ${r.id}::uuid`,
    );
    expect(hidden).toEqual({ status: 'pending_moderation', counts_toward_core_score: false });
    const view = await r.author.c.get(`/v1/me/reviews/${r.id}`);
    expect(view.status, view.text).toBe(200);
    expect(view.body.edit_request).toMatchObject({
      status: 'open',
      message: 'Please remove your phone number.',
      spans: [{ field: 'body', start: 48, end: 72 }],
    });
    expect(view.text).not.toContain(mod.user.email);
    await h.settle();
    const [n] = await h.q<{ n: string }>(sql`SELECT count(*) AS n FROM notification.notifications
      WHERE recipient_user_id = ${r.author.user.id}::uuid AND template_key = 'moderation.action_taken'`);
    expect(Number(n!.n)).toBeGreaterThanOrEqual(1);

    // Not back in the queue while the author has time; W4 never republishes it on its own.
    const review = h.admin.app.get(ModerationTargets, { strict: false }).get('review')!;
    const pending = () => h.fx.worker.run({ actorType: 'system' }, (scope) => review.pending!(scope, 5000));
    expect(await pending()).not.toContain(r.id);
    const version = ((await r.author.c.get(`/v1/me/reviews/${r.id}`)).body.version as number) ?? 0;

    // The author edits: the request is answered and the review comes back to a moderator.
    const edited = await r.author.c.patch(
      `/v1/me/reviews/${r.id}`,
      { body: 'They fixed the noise but it came back after a week.' },
      version,
    );
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body.edit_request).toMatchObject({ status: 'edited' });
    expect(await h.worker.get(ReviewWorkflow, { strict: false }).check(r.id)).toBe(false);
    expect(await pending()).toContain(r.id);

    // The moderator approves the edit: published again as it was, the request closed.
    const approved = await act(caseId, { action_type: 'approve' });
    expect(approved.status, approved.text).toBe(201);
    const [back] = await h.q<{ status: string; counts_toward_core_score: boolean; verified_status: string }>(
      sql`SELECT status, counts_toward_core_score, verified_status FROM trust.reviews WHERE id = ${r.id}::uuid`,
    );
    expect(back).toEqual({ status: 'published', counts_toward_core_score: true, verified_status: 'admin_verified' });
    const [req] = await h.q<{ status: string }>(sql`SELECT status FROM trust.review_edit_requests WHERE review_id = ${r.id}::uuid`);
    expect(req!.status).toBe('closed');
    expect((await r.author.c.get(`/v1/me/reviews/${r.id}`)).body.edit_request).toBeNull();
  });

  it('an edit request not answered within 7 days comes back to a moderator, who can remove the review', async () => {
    const r = await publishedReview(p);
    const caseId = await caseFor('review', r.id);
    ok(
      await act(caseId, {
        action_type: 'edit_request',
        params: { edit_spans: [{ field: 'title', start: 0, end: 5 }], edit_message: 'Please change the title.' },
      }),
      'edit request',
    );
    await h.q(sql`UPDATE trust.review_edit_requests SET due_at = now() - interval '1 minute' WHERE review_id = ${r.id}::uuid`);
    const review = h.admin.app.get(ModerationTargets, { strict: false }).get('review')!;
    expect(await h.fx.worker.run({ actorType: 'system' }, (scope) => review.pending!(scope, 5000))).toContain(r.id);
    ok(await act(caseId, { action_type: 'remove' }), 'remove');
    const [req] = await h.q<{ status: string }>(sql`SELECT status FROM trust.review_edit_requests WHERE review_id = ${r.id}::uuid`);
    expect(req!.status).toBe('closed');
  });

  it('downgrade_fitment lowers a row confidence only, and the vendor is told', async () => {
    const v = await h.vendor();
    const fit = h.newId();
    await h.sys((db) =>
      db
        .insertInto('inventory.inventory_fitment')
        .values({
          id: fit,
          inventory_item_id: v.itemId,
          brand_node_id: h.n.brand,
          confidence: 'confirmed',
          confirmed_by: v.as.user.id,
          source: 'manual',
          status: 'active',
        })
        .execute(),
    );
    const caseId = await caseFor('inventory_fitment', fit);
    expect((await act(caseId, { action_type: 'downgrade_fitment' })).status).toBe(422);
    const res = await act(caseId, { action_type: 'downgrade_fitment', params: { fitment_confidence: 'likely' } });
    expect(res.status, res.text).toBe(201);
    const [f] = await h.q<{ confidence: string; status: string }>(
      sql`SELECT confidence, status FROM inventory.inventory_fitment WHERE id = ${fit}::uuid`,
    );
    expect(f).toEqual({ confidence: 'likely', status: 'active' });
    // Never upwards or sideways.
    expect((await act(caseId, { action_type: 'downgrade_fitment', params: { fitment_confidence: 'likely' } })).status).toBe(422);
    ok(await act(caseId, { action_type: 'downgrade_fitment', params: { fitment_confidence: 'uncertain' } }), 'to uncertain');
    const [log] = await h.q<{ params: Json }>(
      sql`SELECT params FROM admin.moderation_actions WHERE moderation_case_id = ${caseId}::uuid ORDER BY created_at DESC LIMIT 1`,
    );
    expect(log!.params).toMatchObject({ fitment_confidence: 'uncertain', previous_confidence: 'likely', subject_organization_id: v.id });
    // Reviews do not take fitment downgrades.
    expect(
      (
        await act(await caseFor('review', (await publishedReview(p)).id), {
          action_type: 'downgrade_fitment',
          params: { fitment_confidence: 'likely' },
        })
      ).status,
    ).toBe(409);
  });
});
