// S7 reviews and trust (40 §15): acceptance — a Path 2 review is never
// published before the business confirmed (or 7 days passed) and a CarPal
// reviewer approved (database check and API). Also the business's
// relationship answer and objection dispute, the deadline rule, responses,
// email invitations with the one-time code and grant, vendor reviews after a
// completed inquiry, disputes, withdrawal revoking evidence, and helpful votes.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalDeadlineRule } from '#modules/trust/trust-worker.module.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { audits, client, grantConsent, newId, outbox } from './s5-support.js';
import { flagsOn, flush, publishedProvider, publishedVendor, type PublishedOrg } from './s6-support.js';
import { customer, requested } from './s7-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;

beforeAll(async () => {
  app = await createTestApp({ host: 'api', providers: [flagsOn('reviews.invitation_email.enabled')] });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

const path2Body = (p: PublishedOrg, o: Json = {}) => ({
  subject_organization_id: p.id,
  subject_type: 'provider',
  overall_rating: 2,
  body: 'They fixed the noise but it came back after a week.',
  content_locale: 'en',
  ...o,
});

describe('Path 2 (S7 acceptance)', () => {
  it('is never published before the business confirmed and a CarPal reviewer approved (API and database check)', async () => {
    const p = await publishedProvider(app, n, { name: `Path Two ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const eligibility = await cu.c.post('/v1/reviews/eligibility', { subject_organization_id: p.id });
    expect(eligibility.body).toMatchObject({ allowed: true, path: 'approval_based', candidate_visits: [] });
    const created = await cu.c.post('/v1/reviews', path2Body(p));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'pending_approval',
      confirmation_path: 'approval_based',
      verified_status: 'pending_approval',
      business_confirmation_status: 'pending',
      reviewer_decision: 'pending',
      can_add_evidence: true,
    });
    const id = created.body.id as string;
    expect((await outbox(app, id)).map((e) => e.type)).toEqual(['review.created', 'review.approval.requested']);
    // Only one review without a visit per subject.
    expect((await cu.c.post('/v1/reviews/eligibility', { subject_organization_id: p.id })).body).toMatchObject({
      allowed: false,
      reason_code: 'already_reviewed',
    });

    // The business sees the relationship question only: no rating, no text.
    const approvals = await p.c.get(`/v1/orgs/${p.id}/review-approvals`);
    expect(approvals.body.items).toHaveLength(1);
    expect(approvals.body.items[0]).toMatchObject({ review_id: id, author_display_name: expect.any(String) });
    expect(approvals.text).not.toContain('came back');
    expect(approvals.text).not.toContain('overall_rating');
    expect((await p.c.get(`/v1/orgs/${p.id}/reviews/${id}`)).status).toBe(404);

    const answered = await p.c.post(`/v1/orgs/${p.id}/review-approvals/${id}/answer`, { answer: 'confirmed', note: 'Yes, last Tuesday' });
    expect(answered.status).toBe(200);
    expect(await audits(app, id)).toContain('review.approval_confirmed');
    expect((await p.c.post(`/v1/orgs/${p.id}/review-approvals/${id}/answer`, { answer: 'rejected' })).body.code).toBe('INVALID_TRANSITION');
    await flush(app, worker);
    // Confirmed by the business but no reviewer decision (S8): still hidden.
    expect((await cu.c.get(`/v1/me/reviews/${id}`)).body).toMatchObject({
      status: 'pending_approval',
      business_confirmation_status: 'confirmed',
    });
    const anon = await app.fixtures.anonymousToken();
    expect((await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon })).body.items).toEqual([]);

    // The database refuses publication without the reviewer's approval (reviews_path2_publish_rule).
    const refused = await app.fixtures.worker
      .run({ actorType: 'system' }, ({ db }) =>
        db
          .updateTable('trust.reviews')
          .set({ status: 'published', published_at: sql`now()` })
          .where('id', '=', id)
          .execute(),
      )
      .then(() => 'updated')
      .catch((e: Error) => e.message);
    expect(refused).not.toBe('updated');
    // With the reviewer's approval the same publication is accepted (what the S8 reviewer operation will do).
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('trust.reviews')
        .set({
          reviewer_decision: 'approved',
          verified_status: 'approved_without_visit',
          status: 'published',
          published_at: sql`now()`,
          trust_weight: '0.6',
          counts_toward_core_score: true,
        })
        .where('id', '=', id)
        .execute(),
    );
    const pub = await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon });
    expect(pub.body.items[0]).toMatchObject({ label: 'approved_by_business_and_carpal', overall_rating: 2 });
  });

  it('a rejected relationship opens a review_approval_objection dispute; silence for 7 days is no objection', async () => {
    const p = await publishedProvider(app, n, { name: `Objection ${newId().slice(-6)}` });
    const [a, b] = await Promise.all([customer(app, n), customer(app, n)]);
    const ra = (await a.c.post('/v1/reviews', path2Body(p))).body;
    const rb = (await b.c.post('/v1/reviews', path2Body(p, { overall_rating: 4 }))).body;
    expect((await p.c.post(`/v1/orgs/${p.id}/review-approvals/${ra.id}/answer`, { answer: 'rejected' })).status).toBe(200);
    const disputes = await p.c.get(`/v1/disputes?organization_id=${p.id}`);
    expect(disputes.body.items).toEqual([
      expect.objectContaining({ target: { type: 'review', id: ra.id }, dispute_type: 'review_approval_objection', status: 'open' }),
    ]);
    expect((await outbox(app, ra.id)).map((e) => e.type)).toContain('review.approval.objected');
    // The review stays: never removed by the business (52 Review rules); the author may add evidence.
    expect((await a.c.get(`/v1/me/reviews/${ra.id}`)).body).toMatchObject({
      status: 'pending_approval',
      business_confirmation_status: 'rejected',
      can_add_evidence: true,
    });

    // Deadline: no answer within 7 days → no_response.
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('trust.reviews')
        .set({ business_confirmation_due_at: new Date(Date.now() - 60_000) })
        .where('id', '=', rb.id)
        .execute(),
    );
    expect(await worker.get(ApprovalDeadlineRule).run()).toBeGreaterThanOrEqual(1);
    expect((await b.c.get(`/v1/me/reviews/${rb.id}`)).body.business_confirmation_status).toBe('no_response');
    expect((await p.c.post(`/v1/orgs/${p.id}/review-approvals/${rb.id}/answer`, { answer: 'confirmed' })).body.code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('author rules', () => {
  it('members cannot review their organization; vendor dimensions and edits before publication', async () => {
    const p = await publishedProvider(app, n, { name: `Rules ${newId().slice(-6)}` });
    const own = await p.c.post('/v1/reviews', path2Body(p));
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('REVIEW_NOT_ALLOWED');
    expect((await p.c.post('/v1/reviews/eligibility', { subject_organization_id: p.id })).body).toMatchObject({
      allowed: false,
      reason_code: 'member_of_subject',
    });
    const cu = await customer(app, n);
    const bad = await cu.c.post('/v1/reviews', path2Body(p, { sub_ratings: [{ dimension: 'part_accuracy', rating: 3 }], body: 'short' }));
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        { pointer: '/body', code: 'too_short', limit: '10' },
        { pointer: '/sub_ratings/0/dimension', code: 'enum' },
      ]),
    );
    const r = (await cu.c.post('/v1/reviews', path2Body(p, { sub_ratings: [{ dimension: 'timeliness', rating: 2 }] }))).body;
    const edited = await cu.c.patch(
      `/v1/me/reviews/${r.id}`,
      { overall_rating: 3, sub_ratings: [{ dimension: 'timeliness', rating: 3 }] },
      r.version,
    );
    expect(edited.body).toMatchObject({
      overall_rating: 3,
      sub_ratings: [{ dimension: 'timeliness', rating: 3 }],
      status: 'pending_approval',
    });
    expect((await outbox(app, r.id)).map((e) => e.type)).toContain('review.edited');
    // Withdrawal hides it and is audited.
    expect((await cu.c.del(`/v1/me/reviews/${r.id}`)).status).toBe(200);
    expect(await audits(app, r.id)).toContain('review.withdrawn');
    expect((await cu.c.get(`/v1/me/reviews/${r.id}`)).body.status).toBe('removed');
    expect((await cu.c.del(`/v1/me/reviews/${r.id}`)).status).toBe(404);
  });
});

describe('responses, disputes and helpful votes on a published review', () => {
  it('one draft and one published response; disputes by parties; helpful count without members', async () => {
    const p = await publishedProvider(app, n, { name: `Respond ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const a = await requested(p, cu, n);
    // A visit that took place (completed by the fixture path) frames a Path 1 review.
    await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      for (const status of ['confirmed', 'checked_in', 'in_progress', 'completed'] as const)
        await db
          .updateTable('appointment.appointments')
          .set({ status, ...(status === 'confirmed' ? { confirmed_start_at: new Date(Date.now() - 86_400_000) } : {}) })
          .where('id', '=', a.id)
          .execute();
    });
    const r = (await cu.c.post('/v1/reviews', { ...path2Body(p, { overall_rating: 1 }), context_appointment_id: a.id })).body;
    expect(r).toMatchObject({ confirmation_path: 'visit_based', verified_status: 'appointment_verified' });
    await flush(app, worker);
    const inbox = await p.c.get(`/v1/orgs/${p.id}/reviews`);
    expect(inbox.body.items.map((x: Json) => x.id)).toEqual([r.id]);
    expect(inbox.body.items[0]).toMatchObject({ status: 'published', response_draft: null, label: 'verified_visit' });

    const draft = await p.c.post(`/v1/orgs/${p.id}/reviews/${r.id}/responses`, {
      response_text: 'Sorry, please come back.',
      content_locale: 'en',
    });
    expect(draft.status).toBe(201);
    expect(
      (await p.c.post(`/v1/orgs/${p.id}/reviews/${r.id}/responses`, { response_text: 'Another', content_locale: 'en' })).body.code,
    ).toBe('DUPLICATE');
    const upd = await p.c.patch(
      `/v1/orgs/${p.id}/reviews/${r.id}/responses/${draft.body.id}`,
      { response_text: 'Sorry, we will redo it for free.' },
      draft.body.version,
    );
    expect(upd.body.response_text).toBe('Sorry, we will redo it for free.');
    expect((await p.c.get(`/v1/orgs/${p.id}/reviews?has_response=false`)).body.items).toHaveLength(1);
    const published = await p.c.post(`/v1/orgs/${p.id}/reviews/${r.id}/responses/${draft.body.id}/publish`);
    expect(published.body).toMatchObject({ status: 'published' });
    expect(await audits(app, draft.body.id)).toContain('review.response_published');
    const anon = await app.fixtures.anonymousToken();
    expect((await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon })).body.items[0].response).toMatchObject({
      response_text: 'Sorry, we will redo it for free.',
    });
    expect((await cu.c.get(`/v1/me/reviews/${r.id}`)).body.response.response_text).toBe('Sorry, we will redo it for free.');

    // Disputes: the subject reports the review once; a stranger cannot dispute it.
    const d = await p.c.post('/v1/disputes', {
      target: { type: 'review', id: r.id },
      dispute_type: 'inaccurate_review',
      reason: 'The work was redone for free.',
      raised_by_organization_id: p.id,
    });
    expect(d.status).toBe(201);
    expect(
      (
        await p.c.post('/v1/disputes', {
          target: { type: 'review', id: r.id },
          dispute_type: 'inaccurate_review',
          reason: 'The work was redone for free.',
          raised_by_organization_id: p.id,
        })
      ).body.code,
    ).toBe('DUPLICATE');
    expect((await p.c.get(`/v1/orgs/${p.id}/reviews/${r.id}`)).body.report_status).toBe('reported');
    const stranger = await customer(app, n);
    expect(
      (
        await stranger.c.post('/v1/disputes', {
          target: { type: 'review', id: r.id },
          dispute_type: 'fake_review',
          reason: 'I do not believe this review.',
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
    expect((await p.c.get(`/v1/disputes/${d.body.id}`)).body).toMatchObject({ status: 'open', resolution: null });
    expect((await stranger.c.get(`/v1/disputes/${d.body.id}`)).status).toBe(404);
    expect((await p.c.post(`/v1/disputes/${d.body.id}/withdraw`)).body.status).toBe('withdrawn');
    expect((await p.c.post(`/v1/disputes/${d.body.id}/withdraw`)).body.code).toBe('INVALID_TRANSITION');

    // Helpful votes: a member of the subject does not count (SEC-BF-9).
    const voter = await customer(app, n);
    expect((await voter.c.put('/v1/reactions', { target: { type: 'review', id: r.id }, reaction_type: 'helpful' })).body.count).toBe(1);
    expect((await p.c.put('/v1/reactions', { target: { type: 'review', id: r.id }, reaction_type: 'helpful' })).body.count).toBe(1);
    await flush(app, worker);
    expect((await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon })).body.items[0].helpful_count).toBe(1);

    // A 1-star review unanswered would cost trust after 7 days; withdrawal revokes its evidence (54 §1.1, §9).
    expect((await cu.c.del(`/v1/me/reviews/${r.id}`)).status).toBe(200);
    await flush(app, worker);
    const evidence = await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      const { rows } = await sql<{ status: string }>`
        SELECT status FROM organization.provider_capability_evidence WHERE reference_entity_type = 'review' AND reference_entity_id = ${r.id}::uuid`.execute(
        db,
      );
      return rows.map((x) => x.status);
    });
    expect(evidence).toEqual(['revoked']);
  });
});

describe('invitations', () => {
  it('an email invitation for a job log: open sends a code, verify grants, the review is Path 2 with the business confirmation given', async () => {
    const p = await publishedProvider(app, n, { name: `Invite ${newId().slice(-6)}` });
    const invitee = await app.fixtures.user();
    const jobLog = await app.fixtures.worker.run(
      { actorType: 'system' },
      async ({ db }) =>
        (
          await db
            .insertInto('organization.provider_job_logs')
            .values({
              provider_organization_id: p.id,
              job_date: '2026-10-01',
              service_system_node_id: n.system,
              logged_by_user_id: p.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    );
    const sent = await p.c.post(`/v1/orgs/${p.id}/review-invitations`, {
      provider_job_log_id: jobLog,
      channel: 'email',
      invited_contact: invitee.email,
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      status: 'sent',
      channel: 'email',
      business_confirmation_given: true,
      visit: { type: 'provider_job_log', id: jobLog },
    });
    expect(JSON.stringify(sent.body)).not.toContain(invitee.email);
    expect(
      (
        await p.c.post(`/v1/orgs/${p.id}/review-invitations`, {
          provider_job_log_id: jobLog,
          channel: 'email',
          invited_contact: invitee.email,
        })
      ).body.code,
    ).toBe('DUPLICATE');
    const mail = app.mail(invitee.email, 'review.invitation').at(-1)!;
    const token = mail.variables.link!.split('#')[1]!;

    const anon = await app.fixtures.anonymousToken();
    const open = await app.request<Json>({ method: 'POST', path: '/v1/review-invitations/open', token: anon, body: { token } });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ invitation_id: sent.body.id, path: 'approval_based', subject: { id: p.id } });
    expect(open.body.code_sent_to).toMatch(/^t•••@t•••\./);
    const code = app.mail(invitee.email, 'review.invitation_code').at(-1)!.variables.code!;

    const stranger = await app.fixtures.user();
    const strangerToken = await app.fixtures.token(stranger);
    expect((await client(app, strangerToken).post('/v1/review-invitations/verify', { token, code })).body.code).toBe(
      'LINK_RECIPIENT_MISMATCH',
    );
    const ic = client(app, await app.fixtures.token(invitee));
    expect((await ic.post('/v1/review-invitations/verify', { token, code: code === '000000' ? '111111' : '000000' })).body.code).toBe(
      'CODE_INVALID',
    );
    const verified = await ic.post('/v1/review-invitations/verify', { token, code });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ path: 'approval_based' });
    const review = await ic.post('/v1/reviews', {
      ...path2Body(p, { overall_rating: 5 }),
      invitation_grant: verified.body.invitation_grant,
    });
    expect(review.status).toBe(201);
    expect(review.body).toMatchObject({
      status: 'pending_approval',
      confirmation_path: 'approval_based',
      business_confirmation_status: 'confirmed',
    });
    // The grant and the link are single use.
    expect((await ic.post('/v1/reviews', { ...path2Body(p), invitation_grant: verified.body.invitation_grant })).body.code).toBe(
      'LINK_EXPIRED',
    );
    expect((await app.request<Json>({ method: 'POST', path: '/v1/review-invitations/open', token: anon, body: { token } })).body.code).toBe(
      'LINK_USED',
    );
    expect((await p.c.get(`/v1/orgs/${p.id}/review-invitations`)).body.items[0]).toMatchObject({ status: 'converted' });
    // Business-confirmed Path 2 reviews do not wait for the business answer.
    expect((await p.c.get(`/v1/orgs/${p.id}/review-approvals`)).body.items).toEqual([]);
  });

  it('email needs the customer review_invitations consent; members cannot invite themselves; cancel stops the link', async () => {
    const p = await publishedProvider(app, n, { name: `Consent ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const a = await app.fixtures.appointment({ id: p.id, type: 'provider' }, cu.user, cu.vehicleId, {
      status: 'completed',
      serviceSystemNodeId: n.system,
    });
    const noConsent = await p.c.post(`/v1/orgs/${p.id}/review-invitations`, { appointment_id: a, channel: 'email' });
    expect(noConsent.status).toBe(403);
    expect(noConsent.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'review_invitations' });
    await grantConsent(cu.c, 'review_invitations', null, null);
    const ok = await p.c.post(`/v1/orgs/${p.id}/review-invitations`, { appointment_id: a, channel: 'email' });
    expect(ok.status).toBe(201);
    expect((await outbox(app, ok.body.id)).map((e) => e.type)).toEqual(['review.invitation.sent']);
    const cancelled = await p.c.post(`/v1/orgs/${p.id}/review-invitations/${ok.body.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    const token = app.mail(cu.user.email, 'review.invitation').at(-1)!.variables.link!.split('#')[1]!;
    const anon = await app.fixtures.anonymousToken();
    expect((await app.request<Json>({ method: 'POST', path: '/v1/review-invitations/open', token: anon, body: { token } })).body.code).toBe(
      'LINK_EXPIRED',
    );
    // The provider's own member as the customer: self-review pattern.
    const memberCar = await app.fixtures.vehicle({ id: p.userId, email: 'x', platformRoles: [] }, n);
    const own = await app.fixtures.appointment({ id: p.id, type: 'provider' }, { id: p.userId, email: 'x', platformRoles: [] }, memberCar, {
      status: 'completed',
    });
    expect((await p.c.post(`/v1/orgs/${p.id}/review-invitations`, { appointment_id: own, channel: 'in_app' })).body.code).toBe(
      'REVIEW_NOT_ALLOWED',
    );
  });
});

describe('vendor reviews', () => {
  it('a completed stock inquiry invites the requester and frames an inquiry_verified review', async () => {
    const v = await publishedVendor(app, n, { name: `Parts ${newId().slice(-6)}` });
    const cu = await customer(app, n);
    const q = await cu.c.post('/v1/me/inquiries', { inventory_item_id: v.itemId, message: 'Is this in stock?', content_locale: 'en' });
    expect(q.status).toBe(201);
    expect(
      (await v.c.post(`${v.vnd}/inquiries/${q.body.id}/messages`, { body: 'Yes, ready for pickup', content_locale: 'en' })).status,
    ).toBe(201);
    expect((await v.c.post(`${v.vnd}/inquiries/${q.body.id}/transitions`, { to: 'completed' })).status).toBe(200);
    expect((await outbox(app, q.body.id)).map((e) => e.payload.new_status).filter(Boolean)).toEqual(['answered', 'completed']);
    await flush(app, worker);
    expect((await cu.c.get('/v1/me/review-invitations')).body.items[0]).toMatchObject({ visit: { type: 'stock_inquiry', id: q.body.id } });
    const notes = await cu.c.get('/v1/me/notifications');
    expect((notes.body.items as Json[]).map((x) => x.event_type)).toEqual(
      expect.arrayContaining(['inquiry_answered', 'review_invitation']),
    );
    const r = await cu.c.post('/v1/reviews', {
      subject_organization_id: v.id,
      subject_type: 'vendor',
      context_stock_inquiry_id: q.body.id,
      overall_rating: 4,
      body: 'Right part, quick pickup, fair price.',
      content_locale: 'en',
      sub_ratings: [{ dimension: 'part_accuracy', rating: 5 }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ confirmation_path: 'visit_based', verified_status: 'inquiry_verified', status: 'pending_moderation' });
    await flush(app, worker);
    expect((await cu.c.get(`/v1/me/reviews/${r.body.id}`)).body.status).toBe('published');
  });
});
