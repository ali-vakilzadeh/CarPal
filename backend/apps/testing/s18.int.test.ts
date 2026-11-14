// S18 (contract 1.4.0; backend/BR-update-plan.json S18): moderation queues and content context. The A-CON-01
// severity floor on every path (BR-32), the case list's source and reason filters and target summaries (BR-27, BR-32),
// typed target snapshots with the author block (BR-27, BR-33), admin.case_context (BR-33) and the reviewer's stage,
// business answer time and own decisions (BR-29). Records come from the contract sweep's fixtures (Harness).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { publishedPost, sharedProvider, showcase, symptomNode } from './contract/domain.js';
import { Harness, ok, sql, type Actor, type Json, type Published } from './contract/harness.js';
import { projectionViolations } from './contract/projection.js';
import { purpose, REASON } from './s8-support.js';

let h: Harness;
let mod: Actor;
let p: Published;

const caseFor = async (type: string, targetId: string, o: { reason?: string; severity?: string; source?: string } = {}) => {
  const source = o.source ?? 'admin';
  const [row] = await h.q<{ id: string; severity: string }>(sql`
    INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity, ai_flag_insight_id)
    VALUES (${type}, ${type}, ${targetId}::uuid, ${source}, ${o.reason ?? 'other'}, ${o.severity ?? 'low'},
            ${source === 'ai_flag' ? uuidv7() : null}::uuid)
    RETURNING id, severity`);
  return row!;
};

/** admin.case_get under the case's purpose; the pipeline checks the response against TargetSnapshot. */
async function caseGet(caseId: string): Promise<Json> {
  const res = await mod.c.get(`/v1/admin/moderation/cases/${caseId}`, purpose('case', caseId));
  expect(res.status, res.text).toBe(200);
  expect(projectionViolations(res.body, { opId: 'admin.case_get', vins: h.vins, tradeAllowed: false })).toEqual([]);
  return res.body;
}

const snapshotOf = async (type: string, id: string) => (await caseGet((await caseFor(type, id)).id)).target_snapshot as Json;

const review = async (o: Json = {}) => {
  const author = await h.user();
  const r = ok(
    await author.c.post('/v1/reviews', {
      subject_organization_id: p.id,
      subject_type: 'provider',
      overall_rating: 2,
      title: 'Noise came back',
      body: 'They fixed the noise but it came back after a week.',
      content_locale: 'en',
      ...o,
    }),
    'review',
  );
  return { author, id: r.id as string };
};

async function question(): Promise<{ asker: Actor; id: string }> {
  const asker = await h.user();
  const q = ok(
    await asker.c.post('/v1/questions', {
      vehicle_id: await h.vehicle(asker),
      symptom_node_id: await symptomNode(h),
      title: 'Grinding noise when braking',
      body: 'My car makes a grinding noise when I brake at low speed.',
      content_locale: 'en',
    }),
    'question',
  );
  return { asker, id: q.id as string };
}

const answer = async (questionId: string, body: string, as?: Actor) =>
  ok(await (as ?? (await h.user())).c.post(`/v1/questions/${questionId}/answers`, { body, content_locale: 'en' }), 'answer').id as string;

const comment = async (postId: string, body: string, as?: Actor) =>
  ok(await (as ?? (await h.user())).c.post('/v1/comments', { target: { type: 'post', id: postId }, body, content_locale: 'en' }), 'comment')
    .id as string;

beforeAll(async () => {
  h = await Harness.start();
  mod = await h.staff('platform_moderator');
  p = await sharedProvider(h);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('severity floor (BR-32, Docs/23 A-CON-01)', () => {
  it('report triage opens a privacy case at high whatever severity is sent, and says so in the audit entry', async () => {
    const target = await h.user();
    const rep = ok(
      await (await h.user()).c.post('/v1/reports', { target_type: 'user', target_id: target.user.id, reason: 'privacy' }),
      'report',
    );
    const res = await mod.c.post(`/v1/admin/reports/${rep.report_id}/triage`, { open_case: { severity: 'low' }, reason: REASON });
    expect(res.status, res.text).toBe(200);
    const [c] = await h.q<{ severity: string }>(
      sql`SELECT severity FROM admin.moderation_cases WHERE id = ${res.body.moderation_case_id as string}::uuid`,
    );
    expect(c!.severity).toBe('high');
    const [audit] = await h.q<{ next: string }>(
      sql`SELECT new_state_summary AS next FROM analytics.audit_logs WHERE action = 'moderation.report_triaged' AND entity_id = ${rep.report_id as string}::uuid`,
    );
    expect(audit!.next).toContain('severity low raised to high: privacy');
  });

  it('no path opens or changes an unsafe_advice, non_consensual_media or privacy case below high (database trigger)', async () => {
    expect((await caseFor('user', uuidv7(), { reason: 'unsafe_advice', severity: 'low' })).severity).toBe('high');
    expect((await caseFor('user', uuidv7(), { reason: 'non_consensual_media', severity: 'medium', source: 'ai_flag' })).severity).toBe(
      'high',
    );
    expect((await caseFor('user', uuidv7(), { reason: 'privacy', severity: 'critical', source: 'system_rule' })).severity).toBe('critical');
    expect((await caseFor('user', uuidv7(), { reason: 'spam', severity: 'low' })).severity).toBe('low');
    const c = await caseFor('user', uuidv7(), { reason: 'privacy', severity: 'high' });
    const [lowered] = await h.q<{ severity: string }>(
      sql`UPDATE admin.moderation_cases SET severity = 'medium' WHERE id = ${c.id}::uuid RETURNING severity`,
    );
    expect(lowered!.severity).toBe('high');
    const s = await caseFor('user', uuidv7(), { reason: 'spam', severity: 'low' });
    const [moved] = await h.q<{ severity: string }>(
      sql`UPDATE admin.moderation_cases SET reason = 'unsafe_advice' WHERE id = ${s.id}::uuid RETURNING severity`,
    );
    expect(moved!.severity).toBe('high');
  });
});

describe('case list: source and reason filters, target summary (BR-27, BR-32)', () => {
  it('several sources and reasons match any of them, comma-separated', async () => {
    const a = await caseFor('user', uuidv7(), { reason: 'privacy', source: 'user_report' });
    const b = await caseFor('user', uuidv7(), { reason: 'unsafe_advice', source: 'ai_flag' });
    const c = await caseFor('user', uuidv7(), { reason: 'spam', source: 'system_rule' });
    const res = await mod.c.get('/v1/admin/moderation/cases?reason=privacy,unsafe_advice&source=user_report,ai_flag&limit=100');
    expect(res.status, res.text).toBe(200);
    const items = res.body.items as Json[];
    expect(items.every((i) => ['privacy', 'unsafe_advice'].includes(i.reason as string))).toBe(true);
    expect(items.every((i) => ['user_report', 'ai_flag'].includes(i.source as string))).toBe(true);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(c.id);
    const one = await mod.c.get('/v1/admin/moderation/cases?reason=spam&source=system_rule&limit=100');
    expect((one.body.items as Json[]).map((i) => i.id)).toContain(c.id);
    // A repeated parameter stays 400; an unknown reason is 422 at its position.
    expect((await mod.c.get('/v1/admin/moderation/cases?reason=spam&reason=privacy')).body.code).toBe('UNKNOWN_QUERY_PARAM');
    const bad = await mod.c.get('/v1/admin/moderation/cases?reason=spam,nope');
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ pointer: '/query/reason/1' })]);
  });

  it('a review case shows an excerpt and the rating; long text is cut to 120 characters; accounts show no excerpt', async () => {
    const r = await review();
    const post = await publishedPost(h, p);
    const long = await comment(post.id as string, `${'Brake fluid '.repeat(30)}end.`);
    const user = await h.user();
    const cases = [await caseFor('review', r.id), await caseFor('comment', long), await caseFor('user', user.user.id)];
    const res = await mod.c.get('/v1/admin/moderation/cases?limit=100');
    const byId = new Map((res.body.items as Json[]).map((i) => [i.id, i.target_summary]));
    expect(byId.get(cases[0]!.id)).toEqual({ excerpt: 'Noise came back', rating: 2 });
    const cut = byId.get(cases[1]!.id) as { excerpt: string; rating: null };
    expect([...cut.excerpt]).toHaveLength(120);
    expect(cut.excerpt.endsWith('…')).toBe(true);
    expect(byId.get(cases[2]!.id)).toEqual({ excerpt: null, rating: null });
    // A record that is gone has no summary.
    const gone = await caseFor('post', uuidv7());
    const again = await mod.c.get('/v1/admin/moderation/cases?limit=100');
    expect((again.body.items as Json[]).find((i) => i.id === gone.id)!.target_summary).toBeNull();
  });
});

describe('typed target snapshots with the author (BR-27, BR-33)', () => {
  it('a review: the member who wrote it, with their review history', async () => {
    const r = await review();
    const s = await snapshotOf('review', r.id);
    expect(s).toMatchObject({ type: 'review', id: r.id, available: true, overall_rating: 2, title: 'Noise came back' });
    expect(s.author).toMatchObject({ user_id: r.author.user.id, role: 'member', organization: null });
    expect((s.author as Json).history).toEqual({ published: 0, removed: 0, warnings: 0 });
  });

  it('a post: written for the provider (role and organization card); a comment names its target', async () => {
    const post = await publishedPost(h, p);
    const s = await snapshotOf('post', post.id as string);
    expect(s).toMatchObject({ type: 'post', available: true, post_type: 'educational_tip', status: 'published' });
    expect(s.author).toMatchObject({ role: 'provider', organization: expect.objectContaining({ id: p.id }) });
    expect(((s.author as Json).history as Json).published).toBeGreaterThanOrEqual(1);
    const commenter = await h.user();
    const c = await comment(post.id as string, 'Thanks, very useful!', commenter);
    const cs = await snapshotOf('comment', c);
    expect(cs).toMatchObject({ type: 'comment', target: { type: 'post', id: post.id }, body: 'Thanks, very useful!' });
    expect(cs.author).toMatchObject({ user_id: commenter.user.id, role: 'member', organization: null });
  });

  it('a question and an answer; a warning shows in the author history', async () => {
    const q = await question();
    const qs = await snapshotOf('question', q.id);
    expect(qs).toMatchObject({ type: 'question', title: 'Grinding noise when braking', author: { user_id: q.asker.user.id } });
    const by = await h.user();
    const a = await answer(q.id, 'Most likely worn pads; have them checked soon.', by);
    const c = await caseFor('answer', a);
    const warned = await mod.c.post(
      `/v1/admin/moderation/cases/${c.id}/actions`,
      { action_type: 'warn_user', reason: REASON },
      purpose('case', c.id),
    );
    expect(warned.status, warned.text).toBe(201);
    const s = (await caseGet(c.id)).target_snapshot as Json;
    expect(s).toMatchObject({ type: 'answer', question_id: q.id, author: { user_id: by.user.id } });
    expect(((s.author as Json).history as Json).warnings).toBe(1);
  });

  it('a showcase: the customer consent record by display name only, and its media ids', async () => {
    const item = await showcase(h, p);
    expect(await snapshotOf('portfolio_item', item)).toMatchObject({ consent: null, media_ids: [expect.any(String)] });
    const customer = await h.user();
    const [consent] = await h.q<{ id: string }>(sql`
      INSERT INTO identity.consent_records (subject_type, subject_id, consent_type, scope_entity_type, scope_entity_id,
        granted_to_type, granted_to_id, policy_version, granted, granted_at, source)
      VALUES ('user', ${customer.user.id}::uuid, 'showcase_publishing', 'portfolio_item', ${item}::uuid,
        'organization', ${p.id}::uuid, '1', true, now(), 'ui') RETURNING id`);
    await h.q(sql`UPDATE organization.portfolio_items SET customer_consent_status = 'granted', consent_reference_id = ${consent!.id}::uuid
                   WHERE id = ${item}::uuid`);
    const s = await snapshotOf('portfolio_item', item);
    expect(s.consent).toMatchObject({
      customer_display_name: expect.any(String),
      consent_type: 'showcase_publishing',
      scope: { type: 'portfolio_item', id: item },
      granted: true,
      withdrawn_at: null,
    });
    expect(JSON.stringify(s)).not.toContain(customer.user.email);
  });

  it('a fitment row names its listing; items, files, organizations, locations, accounts and AI output are typed too', async () => {
    const v = await h.vendor();
    ok(
      await v.as.c.post(`/v1/orgs/${v.id}/vendor/inventory/${v.itemId}/fitment`, {
        items: [{ brand_node_id: h.n.brand, model_node_id: h.n.model, confidence: 'likely' }],
      }),
      'fitment',
    );
    const [f] = await h.q<{ id: string }>(
      sql`SELECT id FROM inventory.inventory_fitment WHERE inventory_item_id = ${v.itemId}::uuid LIMIT 1`,
    );
    expect(await snapshotOf('inventory_fitment', f!.id)).toMatchObject({
      type: 'inventory_fitment',
      confidence: 'likely',
      listing: { sku: expect.any(String), name_translations: expect.any(Object) },
    });
    expect(await snapshotOf('inventory_item', v.itemId)).toMatchObject({ type: 'inventory_item', vendor_organization_id: v.id });
    const asset = await h.upload(p.as, 'portfolio');
    const file = await snapshotOf('media_asset', asset.id as string);
    expect(file).toMatchObject({ type: 'media_asset', author: { user_id: p.as.user.id } });
    expect(await snapshotOf('organization', p.id)).toMatchObject({ type: 'organization', organization_type: 'provider' });
    expect(await snapshotOf('organization_location', p.locationId)).toMatchObject({ type: 'organization_location', organization_id: p.id });
    const u = await h.user();
    expect(await snapshotOf('user', u.user.id)).toMatchObject({ type: 'user', available: true, display_name: expect.any(String) });
    const [insight] = await h.q<{ id: string }>(sql`
      INSERT INTO ai_mcp.ai_insights (insight_type, subject_entity_type, subject_entity_id, source_tool_key, source_tool_version,
        model_version, locale, summary, visibility, organization_id)
      VALUES ('triage_summary', 'vehicle', ${uuidv7()}::uuid, 'tool:test.moderation', '1', 'test-model', 'en', 'Brake pads worn.', 'owner_only',
        ${p.id}::uuid) RETURNING id`);
    expect(await snapshotOf('ai_output', insight!.id)).toMatchObject({
      type: 'ai_output',
      organization_id: p.id,
      summary: 'Brake pads worn.',
    });
    expect(await snapshotOf('review', uuidv7())).toMatchObject({ type: 'review', available: false });
  });
});

describe('admin.case_context (BR-33)', () => {
  it('the answers around a reported answer, with the question as parent', async () => {
    const q = await question();
    const ids = [
      await answer(q.id, 'First answer: check the brake pads.'),
      await answer(q.id, 'Second answer: this one is reported.'),
      await answer(q.id, 'Third answer: check the discs too.'),
    ];
    const c = await caseFor('answer', ids[1]!);
    const res = await mod.c.get(`/v1/admin/moderation/cases/${c.id}/context`, purpose('case', c.id));
    expect(res.status, res.text).toBe(200);
    expect(res.body.parent).toMatchObject({ type: 'question', id: q.id, available: true });
    expect((res.body.items as Json[]).map((i) => [i.id, i.is_target])).toEqual([
      [ids[0], false],
      [ids[1], true],
      [ids[2], false],
    ]);
    expect((res.body.items as Json[])[0]!.author).toMatchObject({ role: 'member', history: null });
    expect(res.body.total).toBe(3);
  });

  it('a post that is the target lists its comments; other targets have no context', async () => {
    const post = await publishedPost(h, p);
    await comment(post.id as string, 'A comment on the reported post.');
    const c = await caseFor('post', post.id as string);
    const res = await mod.c.get(`/v1/admin/moderation/cases/${c.id}/context`, purpose('case', c.id));
    expect(res.body).toMatchObject({ parent: null, total: 1, items: [expect.objectContaining({ type: 'comment', is_target: false })] });
    const u = await caseFor('user', (await h.user()).user.id);
    const none = await mod.c.get(`/v1/admin/moderation/cases/${u.id}/context`, purpose('case', u.id));
    expect(none.body).toEqual({ parent: null, items: [], total: 0 });
  });

  it('is refused under a purpose for another case (403 PURPOSE_RECORD_MISMATCH) and audited under its own', async () => {
    const a = await caseFor('user', (await h.user()).user.id);
    const b = await caseFor('user', (await h.user()).user.id);
    const res = await mod.c.get(`/v1/admin/moderation/cases/${a.id}/context`, purpose('case', b.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PURPOSE_RECORD_MISMATCH');
    expect((await mod.c.get(`/v1/admin/moderation/cases/${a.id}/context`, purpose('case', a.id))).status).toBe(200);
    const [audit] = await h.q<{ purpose: string }>(sql`
      SELECT access_purpose AS purpose FROM analytics.audit_logs WHERE action = 'pii.read' AND entity_id = ${a.id}::uuid
       ORDER BY created_at DESC LIMIT 1`);
    expect(audit!.purpose).toBe(`case:${a.id}`);
  });
});

describe('reviewer stage, business answer time and own decisions (BR-29)', () => {
  it('StaffReviewApprovalView.stage follows the queue; business_answered_at is the business answer', async () => {
    const r = await review({ title: undefined });
    const crv = await h.staff('platform_community_reviewer');
    const get = async () => (await crv.c.get(`/v1/admin/review-approvals/${r.id}`, purpose('approval', r.id))).body;
    expect(await get()).toMatchObject({ stage: 'awaiting_business', business_answered_at: null });
    ok(await p.as.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, { answer: 'confirmed' }), 'business answer');
    const answered = await get();
    expect(answered.stage).toBe('awaiting_reviewer');
    expect(Date.parse(answered.business_answered_at as string)).toBeGreaterThan(Date.now() - 60_000);
    const decide = (decision: string) =>
      crv.c.post(
        `/v1/admin/review-approvals/${r.id}/decision`,
        { decision, reason_code: 'credible', reason: REASON },
        purpose('approval', r.id),
      );
    expect((await decide('evidence_requested')).body.stage).toBe('evidence_requested');
    expect((await decide('approved')).body.stage).toBeNull();
  });

  it('admin.my_decisions_list: the caller own approvals and dispute resolutions, newest first, without a purpose', async () => {
    const crv = await h.staff('platform_community_reviewer');
    const decided: string[] = [];
    for (const decision of ['evidence_requested', 'rejected']) {
      const r = await review();
      ok(await p.as.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, { answer: 'confirmed' }), 'business answer');
      ok(
        await crv.c.post(
          `/v1/admin/review-approvals/${r.id}/decision`,
          { decision, reason_code: 'checked', reason: REASON },
          purpose('approval', r.id),
        ),
        'decision',
      );
      decided.push(r.id);
    }
    const mine = await crv.c.get('/v1/admin/me/decisions');
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.truncated).toBe(false);
    expect((mine.body.items as Json[]).map((i) => [i.review_id, i.decision])).toEqual([
      [decided[1], 'rejected'],
      [decided[0], 'evidence_requested'],
    ]);
    expect((mine.body.items as Json[])[0]).toMatchObject({ kind: 'approval', subject: { id: p.id }, review_status: 'rejected' });

    // A dispute resolved by a moderator is theirs, not the reviewer's.
    const r = await review();
    await h.q(sql`UPDATE trust.reviews SET confirmation_path = 'visit_based', verified_status = 'admin_verified',
        business_confirmation_status = NULL, business_confirmation_due_at = NULL, reviewer_decision = NULL,
        status = 'published', published_at = now(), trust_weight = '1.000', counts_toward_core_score = true WHERE id = ${r.id}::uuid`);
    const d = ok(
      await p.as.c.post('/v1/disputes', {
        target: { type: 'review', id: r.id },
        dispute_type: 'inaccurate_review',
        reason: 'The work was redone for free.',
        raised_by_organization_id: p.id,
      }),
      'dispute',
    );
    const decider = await h.staff('platform_moderator');
    ok(
      await decider.c.post(
        `/v1/admin/disputes/${d.id}/resolution`,
        { status: 'resolved_rejected', resolution: 'The review describes the visit fairly.', reason: REASON },
        purpose('dispute', d.id as string),
      ),
      'resolve',
    );
    const theirs = await decider.c.get('/v1/admin/me/decisions?kind=dispute');
    expect(theirs.body.items).toEqual([
      expect.objectContaining({
        kind: 'dispute',
        dispute_id: d.id,
        decision: 'resolved_rejected',
        review_id: r.id,
        dispute_type: 'inaccurate_review',
      }),
    ]);
    expect((await crv.c.get('/v1/admin/me/decisions?kind=dispute')).body.items).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain(r.author.user.email);
    // STF(CRV, MOD): support staff cannot reach it (the admin plane answers 404 for another role).
    expect((await (await h.staff('platform_support')).c.get('/v1/admin/me/decisions')).status).toBe(404);
  });
});
