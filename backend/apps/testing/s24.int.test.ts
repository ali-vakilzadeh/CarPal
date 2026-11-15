// S24 (contract 1.4.0; backend/BR-update-plan.json S24): support tickets (admin console BR-13; owner decisions DQ-07
// in-app only, DQ-20 row 4). Users and businesses file tickets on the api host and read only their own; staff work them
// in the inbox under the ticket's purpose (support staff and administrators only), answer with templates, assign,
// turn them into a moderation case, privacy request, dispute or plan request, and close them; every staff change is
// audited. Also the team's clock, reopening, the work summary queue, notifications and the DSR export and erasure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { sharedProvider } from './contract/domain.js';
import { Harness, ok, sql, type Actor, type Json, type Published } from './contract/harness.js';
import { purpose, REASON } from './s8-support.js';

let h: Harness;
let sup: Actor;
let p: Published;

async function file(as: Actor, o: Json = {}): Promise<string> {
  return ok(
    await as.c.post('/v1/support/tickets', {
      topic: 'appointment_problem',
      subject: 'The shop did not show up',
      body: 'The mobile mechanic did not come at the confirmed time and does not answer.',
      ...o,
    }),
    'ticket',
  ).id as string;
}

const inbox = (ticketId: string, path = '') => `/v1/admin/support/tickets/${ticketId}${path}`;
const reply = (ticketId: string, o: Json = {}, as: Actor = sup) =>
  as.c.post(
    inbox(ticketId, '/messages'),
    { template_key: 'request_information', body: 'When was the visit?', reason: REASON, ...o },
    purpose('ticket', ticketId),
  );
const convert = (ticketId: string, body: Json, as: Actor = sup) =>
  as.c.post(inbox(ticketId, '/conversions'), { reason: REASON, ...body }, purpose('ticket', ticketId));
const close = (ticketId: string, o: Json = {}, as: Actor = sup) =>
  as.c.post(inbox(ticketId, '/close'), { outcome: 'answered', reason: REASON, ...o }, purpose('ticket', ticketId));

const row = async (ticketId: string) =>
  (
    await h.q<{ status: string; clock_started_at: Date | null; first_response_at: Date | null; outcome: string | null }>(
      sql`SELECT status, clock_started_at, first_response_at, outcome FROM admin.support_tickets WHERE id = ${ticketId}::uuid`,
    )
  )[0]!;

const audits = (ticketId: string) =>
  h.q<{ action: string; access_purpose: string | null }>(
    sql`SELECT action, access_purpose FROM analytics.audit_logs WHERE entity_type = 'support_ticket' AND entity_id = ${ticketId}::uuid
        ORDER BY created_at`,
  );

beforeAll(async () => {
  h = await Harness.start();
  sup = await h.staff('platform_support');
  p = await sharedProvider(h);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('tickets on the api host (a user reads only their own tickets)', () => {
  it('files, lists and reads the caller own tickets; another user gets 404 and an empty list', async () => {
    const owner = await h.user();
    const other = await h.user();
    const id = await file(owner, { diagnostics: { platform: 'web_pwa', app_version: '1.4.0', screen: 'appointments' } });
    const mine = ok(await owner.c.get('/v1/support/tickets'), 'list');
    expect(mine.items.map((t: Json) => t.id)).toEqual([id]);
    const got = ok(await owner.c.get(`/v1/support/tickets/${id}`), 'get');
    expect(got).toMatchObject({ id, status: 'new', can_reply: true, organization_id: null });
    expect(got).not.toHaveProperty('diagnostics');
    expect((await other.c.get(`/v1/support/tickets/${id}`)).status).toBe(404);
    expect((await other.c.post(`/v1/support/tickets/${id}/messages`, { body: 'Me too' })).status).toBe(404);
    expect(ok(await other.c.get('/v1/support/tickets'), 'other list').items).toEqual([]);
  });

  it('files for a business only as its member; other members do not see the ticket', async () => {
    const outsider = await h.user();
    const refused = await outsider.c.post('/v1/support/tickets', {
      topic: 'plan_billing',
      subject: 'Plan question',
      body: 'Which plan lets us add more staff accounts?',
      organization_id: p.id,
    });
    expect(refused.status).toBe(404);
    const id = await file(p.as, { topic: 'plan_billing', subject: 'Plan question', organization_id: p.id });
    const colleague = await h.colleague(p.as, 'provider_manager');
    expect((await colleague.c.get(`/v1/support/tickets/${id}`)).status).toBe(404);
  });

  it('refuses a sixth open ticket and short messages', async () => {
    const u = await h.user();
    for (let i = 0; i < 5; i += 1) await file(u);
    const sixth = await u.c.post('/v1/support/tickets', { topic: 'other', subject: 'Again', body: 'Another question about the app.' });
    expect([sixth.status, sixth.body.code]).toEqual([409, 'INVALID_TRANSITION']); // too_many_open (detail is log-only, SEC-OUT-5)
    const v = await h.user();
    const short = await v.c.post('/v1/support/tickets', { topic: 'other', subject: 'Help', body: 'Help me  ' });
    expect([short.status, short.body.errors?.[0]?.pointer]).toEqual([422, '/body']);
  });

  it('moves between the team and the user, reopens within 14 days and refuses later', async () => {
    const u = await h.user();
    const id = await file(u);
    expect((await row(id)).clock_started_at).not.toBeNull();
    ok(await reply(id), 'staff reply');
    let r = await row(id);
    expect([r.status, r.clock_started_at, r.first_response_at === null]).toEqual(['waiting_on_user', null, false]);
    ok(await u.c.post(`/v1/support/tickets/${id}/messages`, { body: 'Last Monday at 10.' }), 'user reply');
    r = await row(id);
    expect(r.status).toBe('waiting_on_team');
    expect(r.clock_started_at).not.toBeNull();
    ok(await close(id), 'close');
    const solved = ok(await u.c.get(`/v1/support/tickets/${id}`), 'solved');
    expect(solved).toMatchObject({ status: 'solved', outcome: 'answered', can_reply: true });
    ok(await u.c.post(`/v1/support/tickets/${id}/messages`, { body: 'It happened again today.' }), 'reopen');
    expect((await row(id)).status).toBe('waiting_on_team');
    ok(await close(id), 'close again');
    await h.q(sql`UPDATE admin.support_tickets SET solved_at = now() - interval '15 days' WHERE id = ${id}::uuid`);
    const late = await u.c.post(`/v1/support/tickets/${id}/messages`, { body: 'Still broken.' });
    expect([late.status, late.body.code]).toEqual([409, 'INVALID_TRANSITION']); // closed
    expect(ok(await u.c.get(`/v1/support/tickets/${id}`), 'late').can_reply).toBe(false);
  });
});

describe('the staff inbox (purpose, roles, audit)', () => {
  it('reads a ticket only under its purpose, as support or an administrator, and audits the read', async () => {
    const u = await h.user();
    const id = await file(u);
    expect((await sup.c.get(inbox(id))).status).toBe(400);
    const caseId = (
      await h.q<{ id: string }>(sql`
      INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity)
      VALUES ('user', 'user', ${(await h.user()).user.id}::uuid, 'admin', 'other', 'low') RETURNING id`)
    )[0]!.id;
    const wrong = await sup.c.get(inbox(id), purpose('case', caseId));
    expect([wrong.status, wrong.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
    // A moderator cannot use a ticket as a purpose (support staff and administrators only).
    const mod = await h.staff('platform_moderator');
    expect((await mod.c.get(`/v1/admin/users/${u.user.id}`, purpose('ticket', id))).status).toBe(404);
    const detail = ok(await sup.c.get(inbox(id), purpose('ticket', id)), 'get');
    expect(detail).toMatchObject({ id, requester: { user_id: u.user.id }, items: [expect.objectContaining({ author: 'requester' })] });
    expect(JSON.stringify(detail)).not.toContain(u.user.email);
    // The requester is a subject: the user record under the ticket; another user is not.
    ok(await sup.c.get(`/v1/admin/users/${u.user.id}`, purpose('ticket', id)), 'requester');
    const stranger = await h.user();
    expect((await sup.c.get(`/v1/admin/users/${stranger.user.id}`, purpose('ticket', id))).status).toBe(403);
    const [read] = await h.q<{ access_purpose: string }>(sql`SELECT access_purpose FROM analytics.audit_logs
      WHERE action = 'pii.read' AND entity_type = 'support_ticket' AND entity_id = ${id}::uuid`);
    expect(read!.access_purpose).toBe(`ticket:${id}`);
  });

  it('an assigned ticket is the assignee purpose only; a solved one is no purpose', async () => {
    const id = await file(await h.user());
    const other = await h.staff('platform_support');
    ok(await sup.c.post(inbox(id, '/assign'), { assignee_user_id: other.user.id, reason: REASON }), 'assign');
    expect((await sup.c.get(inbox(id), purpose('ticket', id))).status).toBe(404);
    ok(await other.c.get(inbox(id), purpose('ticket', id)), 'assignee');
    const mod = await h.staff('platform_moderator');
    const refused = await sup.c.post(inbox(id, '/assign'), { assignee_user_id: mod.user.id, reason: REASON });
    expect([refused.status, refused.body.errors?.[0]?.pointer]).toEqual([422, '/assignee_user_id']);
    ok(await close(id, {}, other), 'close');
    expect((await other.c.get(inbox(id), purpose('ticket', id))).status).toBe(404);
  });

  it('staff replies show as CarPal to the requester, and every staff change is audited with the purpose', async () => {
    const u = await h.user();
    const id = await file(u);
    ok(await sup.c.post(inbox(id, '/assign'), { reason: REASON }), 'assign self');
    const m = ok(await reply(id, { template_key: 'acknowledgement', body: 'We are looking into it.', status: 'waiting_on_team' }), 'ack');
    expect(m).toMatchObject({ author: 'staff', author_display: 'CarPal', template_key: 'acknowledgement' });
    expect(m.staff_author_display).not.toBe('CarPal');
    const r = await row(id);
    expect([r.status, r.clock_started_at === null, r.first_response_at === null]).toEqual(['waiting_on_team', false, false]);
    const thread = ok(await u.c.get(`/v1/support/tickets/${id}`), 'thread');
    expect(thread.items[1]).toEqual(expect.objectContaining({ author: 'staff', author_display: 'CarPal' }));
    expect(JSON.stringify(thread)).not.toContain(sup.user.email);
    expect(JSON.stringify(thread)).not.toContain('acknowledgement');
    ok(await close(id, { outcome: 'out_of_scope', resolution_note: 'Asked about another app.' }), 'close');
    expect(ok(await u.c.get(`/v1/support/tickets/${id}`), 'solved')).not.toHaveProperty('resolution_note');
    const actions = await audits(id);
    expect(actions.map((a) => a.action)).toEqual(['support.ticket_assigned', 'support.reply_posted', 'support.ticket_solved']);
    expect(actions.slice(1).every((a) => a.access_purpose === `ticket:${id}`)).toBe(true);
    // Solved: no more staff replies or conversions.
    expect(
      (await sup.c.post(inbox(id, '/messages'), { template_key: 'other', body: 'x', reason: REASON }, purpose('ticket', id))).status,
    ).toBe(404);
  });

  it('a staff reply and a solved ticket notify the requester (support_update), the requester reply does not', async () => {
    const u = await h.user();
    const id = await file(u);
    ok(await reply(id), 'staff reply');
    ok(await u.c.post(`/v1/support/tickets/${id}/messages`, { body: 'Yesterday morning.' }), 'user reply');
    ok(await close(id), 'close');
    await h.settle();
    const notes = await h.q<{ template_key: string; event_type: string; reference_entity_type: string }>(sql`
      SELECT template_key, event_type, reference_entity_type FROM notification.notifications
       WHERE recipient_user_id = ${u.user.id}::uuid AND reference_entity_id = ${id}::uuid ORDER BY created_at`);
    expect(notes).toEqual([
      { template_key: 'support.reply_received', event_type: 'support_update', reference_entity_type: 'support_ticket' },
      { template_key: 'support.ticket_solved', event_type: 'support_update', reference_entity_type: 'support_ticket' },
    ]);
  });

  it('the work summary lists the support queue for support staff, not for moderators', async () => {
    const id = await file(await h.user());
    const summary = ok(await sup.c.get('/v1/admin/work-summary'), 'summary');
    const queue = summary.items.find((q: Json) => q.queue === 'support_tickets');
    expect(queue).toBeDefined();
    expect(queue.open).toBeGreaterThan(0);
    expect(queue.sla).not.toBeNull();
    const mod = await h.staff('platform_moderator');
    const modSummary = ok(await mod.c.get('/v1/admin/work-summary'), 'mod summary');
    expect(modSummary.items.map((q: Json) => q.queue)).not.toContain('support_tickets');
    ok(await close(id), 'close');
  });
});

describe('turning a ticket into work items (DQ-20 row 4)', () => {
  it('opens a moderation case as the requester report, then joins the open case of the same target', async () => {
    const u = await h.user();
    const target = await h.user();
    const id = await file(u, { topic: 'other', subject: 'Harassing messages', body: 'This user sends me insults under every post.' });
    const first = ok(
      await convert(id, {
        into: 'moderation_case',
        case_target: { type: 'user', id: target.user.id },
        moderation_reason: 'privacy',
        severity: 'low',
      }),
      'convert',
    );
    expect(first.item.type).toBe('moderation_case');
    const [c] = await h.q<{ severity: string; source: string }>(
      sql`SELECT severity, source FROM admin.moderation_cases WHERE id = ${first.item.id}::uuid`,
    );
    expect(c).toEqual({ severity: 'high', source: 'user_report' }); // S18 floor for privacy
    const [rep] = await h.q<{ reporter_user_id: string; status: string; details: string }>(sql`
      SELECT reporter_user_id, status, details FROM admin.content_reports WHERE moderation_case_id = ${first.item.id}::uuid`);
    expect(rep).toEqual({ reporter_user_id: u.user.id, status: 'triaged', details: 'This user sends me insults under every post.' });
    const id2 = await file(await h.user(), { subject: 'Same user', body: 'Same person insults me too, every day.' });
    const second = ok(
      await convert(id2, {
        into: 'moderation_case',
        case_target: { type: 'user', id: target.user.id },
        moderation_reason: 'harassment',
        severity: 'medium',
      }),
      'second',
    );
    expect(second.item.id).toBe(first.item.id);
    expect(second.ticket.linked_items).toEqual([{ type: 'moderation_case', id: first.item.id }]);
    const missing = await convert(id, {
      into: 'moderation_case',
      case_target: { type: 'user', id: '01900000-0000-7000-8000-000000000000' },
      moderation_reason: 'spam',
      severity: 'low',
    });
    expect([missing.status, missing.body.errors?.[0]?.pointer]).toEqual([422, '/case_target/id']);
  });

  it('files a privacy request for the requester (one open per type), then closes as converted', async () => {
    const u = await h.user();
    const id = await file(u, { topic: 'data', subject: 'Delete my data', body: 'Please send me a copy of everything you store about me.' });
    const notYet = await close(id, { outcome: 'converted' });
    expect([notYet.status, notYet.body.code]).toEqual([409, 'INVALID_TRANSITION']); // not_converted
    const res = ok(await convert(id, { into: 'privacy_request', request_type: 'export' }), 'dsr');
    expect(res.item.type).toBe('data_subject_request');
    const dsr = ok(await u.c.get(`/v1/me/data-requests/${res.item.id}`), 'own dsr');
    expect(dsr).toMatchObject({ request_type: 'export', status: 'received' });
    const dup = await convert(id, { into: 'privacy_request', request_type: 'export' });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE']);
    ok(await close(id, { outcome: 'converted' }), 'close converted');
    expect((await audits(id)).map((a) => a.action)).toEqual(['support.ticket_converted', 'support.ticket_solved']);
  });

  it('raises a dispute for the requester only about a record they are party to', async () => {
    const author = await h.user();
    const review = ok(
      await author.c.post('/v1/reviews', {
        subject_organization_id: p.id,
        subject_type: 'provider',
        overall_rating: 2,
        title: 'Charged twice',
        body: 'They charged me twice for the same oil change and never refunded it.',
        content_locale: 'en',
      }),
      'review',
    );
    const id = await file(author, { body: 'The shop says my review is fake but I have the invoice from that day.' });
    const bad = await convert(id, { into: 'dispute', dispute_target: { type: 'review', id: review.id }, dispute_type: 'badge_challenge' });
    expect([bad.status, bad.body.errors?.[0]?.pointer]).toEqual([422, '/dispute_type']);
    const res = ok(
      await convert(id, { into: 'dispute', dispute_target: { type: 'review', id: review.id }, dispute_type: 'mediation_request' }),
      'dispute',
    );
    const [d] = await h.q<{ raised_by_user_id: string; raised_by_organization_id: string | null; reason: string }>(sql`
      SELECT raised_by_user_id, raised_by_organization_id, reason FROM trust.disputes WHERE id = ${res.item.id}::uuid`);
    expect(d).toEqual({
      raised_by_user_id: author.user.id,
      raised_by_organization_id: null,
      reason: 'The shop says my review is fake but I have the invoice from that day.',
    });
    const strangerTicket = await file(await h.user());
    const notParty = await convert(strangerTicket, {
      into: 'dispute',
      dispute_target: { type: 'review', id: review.id },
      dispute_type: 'mediation_request',
    });
    expect([notParty.status, notParty.body.errors?.[0]?.pointer]).toEqual([422, '/dispute_target/id']);
  });

  it('records a plan request only for an organization ticket filed by its owner', async () => {
    const owner = await h.member('provider');
    const id = await file(owner, {
      topic: 'plan_billing',
      subject: 'More staff',
      body: 'We need more staff accounts for our second branch.',
      organization_id: owner.org!.id,
    });
    const wrongAudience = await convert(id, { into: 'plan_request', plan_key: 'fleet_50' });
    expect([wrongAudience.status, wrongAudience.body.errors?.[0]?.pointer]).toEqual([422, '/plan_key']);
    const res = ok(await convert(id, { into: 'plan_request', plan_key: 'provider_pro' }), 'plan request');
    const [r] = await h.q<{ organization_id: string; requested_by_user_id: string; status: string }>(sql`
      SELECT organization_id, requested_by_user_id, status FROM billing.subscription_change_requests WHERE id = ${res.item.id}::uuid`);
    expect(r).toEqual({ organization_id: owner.org!.id, requested_by_user_id: owner.user.id, status: 'open' });
    const manager = await h.colleague(owner, 'provider_manager');
    const managerTicket = await file(manager, { topic: 'plan_billing', organization_id: owner.org!.id });
    const notOwner = await convert(managerTicket, { into: 'plan_request', plan_key: 'provider_pro' });
    expect([notOwner.status, notOwner.body.code]).toEqual([409, 'INVALID_TRANSITION']); // not_owner
    const personal = await file(await h.user());
    const noOrg = await convert(personal, { into: 'plan_request', plan_key: 'provider_pro' });
    expect([noOrg.status, noOrg.body.code]).toEqual([409, 'INVALID_TRANSITION']); // no_organization
  });

  it('checks the members each conversion needs', async () => {
    const id = await file(await h.user());
    const res = await convert(id, { into: 'privacy_request', plan_key: 'provider_pro' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: Json) => [e.pointer, e.code])).toEqual([
      ['/request_type', 'conditional_required'],
      ['/plan_key', 'conditional_forbidden'],
    ]);
  });
});

describe('privacy requests about the requester', () => {
  it('exports the tickets with the thread (staff as CarPal) and erases them', async () => {
    const u = await h.user();
    const id = await file(u);
    ok(await reply(id), 'staff reply');
    const registry = h.worker.get(PersonalDataRegistry, { strict: false });
    const handler = registry.entries().find(([m]) => m === 'support')![1];
    const sections = await h.fx.worker.run({ actorType: 'system' }, (scope) => handler.export!(scope, u.user.id));
    expect(sections.map((s) => [s.section, s.records.length])).toEqual([
      ['support_tickets', 1],
      ['support_ticket_messages', 2],
    ]);
    expect(sections[1]!.records.map((r) => r.fields.author)).toEqual(['you', 'CarPal']);
    const erased = await h.fx.worker.run({ actorType: 'system' }, (scope) => handler.erase!(scope, u.user.id));
    expect(erased).toBe(1);
    expect(await h.q(sql`SELECT 1 FROM admin.support_ticket_messages WHERE ticket_id = ${id}::uuid`)).toEqual([]);
  });
});
