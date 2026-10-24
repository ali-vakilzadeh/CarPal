// Contract sweep resolvers: reviews and trust (40 §15) — author and business
// operations, invitations with the one-time code, responses, Path 2
// approvals, disputes, badges and trust signals — public reviews (§14.3) and
// the reviewer/moderator plane (§23.4). Internal scoring weights and AI flags
// never appear (SEC-OUT-1, projection scan).
import { sql } from 'kysely';
import { expect } from 'vitest';
import { purpose, REASON } from '../../s8-support.js';
import { sharedProvider } from '../domain.js';
import { ok, type Actor, type Harness, type Json, type Published, type Resolvers, LINK_SECRET } from '../harness.js';

const path2Body = (p: Published, o: Json = {}) => ({
  subject_organization_id: p.id,
  subject_type: 'provider',
  overall_rating: 2,
  body: 'They fixed the noise but it came back after a week.',
  content_locale: 'en',
  ...o,
});

/** A Path 2 review of a new customer, pending the business answer and the reviewer. */
async function pendingReview(h: Harness, p: Published): Promise<{ author: Actor; id: string; version: number }> {
  const author = await h.user();
  const r = ok(await author.c.post('/v1/reviews', path2Body(p)), 'reviews.create');
  return { author, id: r.id as string, version: r.version as number };
}

/** A published Path 1 review (as W4 publishes a verified visit), with its author. */
async function publishedReview(h: Harness, p: Published): Promise<{ author: Actor; id: string }> {
  const r = await pendingReview(h, p);
  await h.q(sql`UPDATE trust.reviews SET confirmation_path = 'visit_based', verified_status = 'admin_verified',
      business_confirmation_status = NULL, business_confirmation_due_at = NULL, reviewer_decision = NULL,
      status = 'published', published_at = now(), trust_weight = '1.000', counts_toward_core_score = true
    WHERE id = ${r.id}::uuid`);
  return { author: r.author, id: r.id };
}

/** A completed appointment of a new customer at the provider (an invitation can name it). */
async function completedVisit(h: Harness, p: Published): Promise<{ customer: Actor; appointmentId: string }> {
  const customer = await h.user();
  const appointmentId = await h.fx.appointment(p.as.org!, customer.user, await h.vehicle(customer), {
    status: 'completed',
    serviceSystemNodeId: h.n.system,
  });
  return { customer, appointmentId };
}

/** An email invitation for a job log of the provider: the invitee and the link token from the mail. */
async function emailInvitation(h: Harness, p: Published): Promise<{ invitee: Actor; token: string; id: string }> {
  const invitee = await h.user();
  const jobLog = await h.sys(
    async (db) =>
      (
        await db
          .insertInto('organization.provider_job_logs')
          .values({
            provider_organization_id: p.id,
            job_date: '2026-10-01',
            service_system_node_id: h.n.system,
            logged_by_user_id: p.as.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );
  const sent = ok(
    await p.as.c.post(`/v1/orgs/${p.id}/review-invitations`, {
      provider_job_log_id: jobLog,
      channel: 'email',
      invited_contact: invitee.user.email,
    }),
    'invitation',
  );
  const mail = h.api.mail(invitee.user.email, 'review.invitation').at(-1)!;
  return { invitee, token: mail.variables.link!.split('#')[1]!, id: sent.id as string };
}

async function response(h: Harness, p: Published): Promise<{ reviewId: string; r: Json }> {
  const { id } = await publishedReview(h, p);
  const r = ok(
    await p.as.c.post(`/v1/orgs/${p.id}/reviews/${id}/responses`, { response_text: 'Sorry, please come back.', content_locale: 'en' }),
    'response',
  );
  return { reviewId: id, r };
}

async function dispute(h: Harness, p: Published): Promise<{ reviewId: string; id: string }> {
  const { id: reviewId } = await publishedReview(h, p);
  const d = ok(
    await p.as.c.post('/v1/disputes', {
      target: { type: 'review', id: reviewId },
      dispute_type: 'inaccurate_review',
      reason: 'The work was redone for free.',
      raised_by_organization_id: p.id,
    }),
    'dispute',
  );
  return { reviewId, id: d.id as string };
}

export const resolvers: Resolvers = {
  'public.org_reviews': async (h) => {
    const p = await sharedProvider(h);
    await publishedReview(h, p);
    return { as: await h.anonymous(), params: { org_id: p.id }, check: (res) => expect(res.body.items.length).toBeGreaterThan(0) };
  },
  'reviews.eligibility': async (h) => ({ as: await h.user(), body: { subject_organization_id: (await sharedProvider(h)).id } }),
  'reviews.create': async (h) => ({ as: await h.user(), body: path2Body(await sharedProvider(h)) }),
  'reviews.mine_list': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    return { as: r.author };
  },
  'reviews.mine_get': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    return { as: r.author, params: { review_id: r.id } };
  },
  'reviews.mine_update': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    return { as: r.author, params: { review_id: r.id }, version: r.version, body: { overall_rating: 3 } };
  },
  'reviews.mine_withdraw': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    return { as: r.author, params: { review_id: r.id } };
  },
  'reviews.evidence_add': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    const photo = await h.upload(r.author, 'review_evidence');
    return { as: r.author, params: { review_id: r.id }, body: { media_ids: [photo.id] }, bodyRefs: true };
  },
  'review_invitations.mine_list': async (h) => {
    const p = await sharedProvider(h);
    const v = await completedVisit(h, p);
    ok(await p.as.c.post(`/v1/orgs/${p.id}/review-invitations`, { appointment_id: v.appointmentId, channel: 'in_app' }), 'invitation');
    return { as: v.customer, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'review_invitations.open': async (h) => {
    const inv = await emailInvitation(h, await sharedProvider(h));
    return { as: await h.anonymous(), body: { token: inv.token }, check: (res) => expect(res.text).not.toContain(inv.invitee.user.email) };
  },
  'review_invitations.verify': async (h) => {
    const inv = await emailInvitation(h, await sharedProvider(h));
    ok(
      await h.api.request<Json>({
        method: 'POST',
        path: '/v1/review-invitations/open',
        token: ((await h.anonymous()) as { token: string }).token,
        body: { token: inv.token },
      }),
      'open',
    );
    const code = h.api.mail(inv.invitee.user.email, 'review.invitation_code').at(-1)!.variables.code!;
    // Another signed-in user cannot verify a link sent to someone else.
    return {
      as: inv.invitee,
      body: { token: inv.token, code },
      bola: { attackers: [await h.stranger()], expect: [403], code: 'LINK_RECIPIENT_MISMATCH', absent: LINK_SECRET },
    };
  },
  'review_invitations.send': async (h) => {
    const p = await sharedProvider(h);
    const v = await completedVisit(h, p);
    return { as: p.as, body: { appointment_id: v.appointmentId, channel: 'in_app' }, bodyRefs: true };
  },
  'review_invitations.org_list': async (h) => {
    const p = await sharedProvider(h);
    await emailInvitation(h, p);
    return { as: p.as };
  },
  'review_invitations.cancel': async (h) => {
    const p = await sharedProvider(h);
    const inv = await emailInvitation(h, p);
    return { as: p.as, params: { invitation_id: inv.id } };
  },
  'reviews.org_list': async (h) => {
    const p = await sharedProvider(h);
    await publishedReview(h, p);
    return { as: p.as };
  },
  'reviews.org_get': async (h) => {
    const p = await sharedProvider(h);
    const r = await publishedReview(h, p);
    return { as: p.as, params: { review_id: r.id }, check: (res) => expect(res.text).not.toContain(r.author.user.email) };
  },
  'review_responses.create': async (h) => {
    const p = await sharedProvider(h);
    const r = await publishedReview(h, p);
    return { as: p.as, params: { review_id: r.id }, body: { response_text: 'Sorry, please come back.', content_locale: 'en' } };
  },
  'review_responses.update': async (h) => {
    const p = await sharedProvider(h);
    const { reviewId, r } = await response(h, p);
    return {
      as: p.as,
      params: { review_id: reviewId, response_id: r.id as string },
      version: r.version as number,
      body: { response_text: 'Sorry, we will redo it for free.' },
    };
  },
  'review_responses.publish': async (h) => {
    const p = await sharedProvider(h);
    const { reviewId, r } = await response(h, p);
    return { as: p.as, params: { review_id: reviewId, response_id: r.id as string } };
  },
  'review_responses.delete': async (h) => {
    const p = await sharedProvider(h);
    const { reviewId, r } = await response(h, p);
    return { as: p.as, params: { review_id: reviewId, response_id: r.id as string } };
  },
  'review_approvals.list': async (h) => {
    const p = await sharedProvider(h);
    await pendingReview(h, p);
    // The business sees the relationship question only: no rating and no text.
    return { as: p.as, check: (res) => expect(res.text).not.toContain('came back') };
  },
  'review_approvals.answer': async (h) => {
    const p = await sharedProvider(h);
    const r = await pendingReview(h, p);
    return { as: p.as, params: { review_id: r.id }, body: { answer: 'confirmed', note: 'Yes, last Tuesday' } };
  },
  'disputes.create': async (h) => {
    const p = await sharedProvider(h);
    const r = await publishedReview(h, p);
    return {
      as: p.as,
      body: {
        target: { type: 'review', id: r.id },
        dispute_type: 'inaccurate_review',
        reason: 'The work was redone for free.',
        raised_by_organization_id: p.id,
      },
      bodyRefs: true,
    };
  },
  'disputes.mine_list': async (h) => {
    const p = await sharedProvider(h);
    await dispute(h, p);
    return { as: p.as, query: { organization_id: p.id } };
  },
  'disputes.get': async (h) => {
    const p = await sharedProvider(h);
    const d = await dispute(h, p);
    return { as: p.as, params: { dispute_id: d.id } };
  },
  'disputes.withdraw': async (h) => {
    const p = await sharedProvider(h);
    const d = await dispute(h, p);
    return { as: p.as, params: { dispute_id: d.id } };
  },
  'badges.list': async (h) => ({ as: (await sharedProvider(h)).as }),
  'trust_signals.list': async (h) => ({ as: (await sharedProvider(h)).as }),
  'admin.review_approvals_queue': async (h) => ({
    as: await h.staff('platform_community_reviewer'),
    query: { stage: 'awaiting_business', limit: 10 },
  }),
  'admin.review_approval_get': async (h) => {
    const r = await pendingReview(h, await sharedProvider(h));
    return {
      as: await h.staff('platform_community_reviewer'),
      params: { review_id: r.id },
      headers: purpose('approval', r.id),
      check: (res) => expect(res.text).not.toContain(r.author.user.email),
    };
  },
  'admin.review_approval_decide': async (h) => {
    const p = await sharedProvider(h);
    const r = await pendingReview(h, p);
    ok(await p.as.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, { answer: 'confirmed' }), 'business answer');
    return {
      as: await h.staff('platform_community_reviewer'),
      params: { review_id: r.id },
      headers: purpose('approval', r.id),
      body: { decision: 'approved', reason_code: 'credible', reason: REASON },
    };
  },
  'admin.review_move_to_approval_path': async (h) => {
    const r = await publishedReview(h, await sharedProvider(h));
    return {
      as: await h.staff('platform_moderator'),
      params: { review_id: r.id },
      body: { reason: REASON },
      check: (res) => h.rejectChange(res.body.change_id as string, 'platform_moderator'),
    };
  },
  'admin.disputes_queue': async (h) => ({ as: await h.staff('platform_moderator'), query: { status: 'open', limit: 10 } }),
  'admin.dispute_get': async (h) => {
    const d = await dispute(h, await sharedProvider(h));
    return { as: await h.staff('platform_moderator'), params: { dispute_id: d.id }, headers: purpose('dispute', d.id) };
  },
  'admin.dispute_resolve': async (h) => {
    const d = await dispute(h, await sharedProvider(h));
    return {
      as: await h.staff('platform_moderator'),
      params: { dispute_id: d.id },
      headers: purpose('dispute', d.id),
      body: { status: 'in_mediation', reason: REASON },
    };
  },
  'admin.badge_approve': async (h) => {
    const p = await sharedProvider(h);
    const badge = h.newId();
    await h.sys((db) =>
      db
        .insertInto('trust.provider_badges')
        .values({
          id: badge,
          provider_organization_id: p.id,
          badge_type: 'verified_business',
          rule_key: 'verified_business',
          rule_version: '54-2026-10',
          evaluation_snapshot: JSON.stringify({ verified: ['business_identity', 'location'] }),
          requires_admin_approval: true,
          status: 'pending_approval',
        })
        .execute(),
    );
    return { as: await h.staff('platform_moderator'), params: { badge_id: badge }, body: { reason: REASON } };
  },
};
