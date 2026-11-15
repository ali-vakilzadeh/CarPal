// S19 (contract 1.4.0; backend/BR-update-plan.json S19): verification and organization records. admin.orgs_search
// filters (city, plan, open cases, location issue, possible duplicate; BR-35 part 1); request more info on a
// verification check with the business's resubmission, the paused review clock, assignment and the richer queue item
// (BR-35 part 2, R-25); staff profile corrections and the profile history (BR-35 part 3); the list of assisted
// onboarding sessions (BR-34). Records come from the contract sweep's fixtures (Harness).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestOrg } from '#libs/testing/index.js';
import { Harness, ok, sql, type Actor, type Json } from './contract/harness.js';
import { projectionViolations } from './contract/projection.js';
import { openCase, purpose, REASON } from './s8-support.js';

let h: Harness;
let mod: Actor;

const tag = () => `S19 ${Math.random().toString(36).slice(2, 10)}`;

/** An organization with a name, an active location in `city` and optional contact phone (system fixture writes). */
async function orgIn(name: string, city: string, o: { phone?: string; farApart?: boolean } = {}): Promise<TestOrg> {
  const org = await h.fx.org('provider');
  await h.q(sql`UPDATE organization.organizations SET name = ${name}, contact_phone = ${o.phone ?? null} WHERE id = ${org.id}::uuid`);
  await h.q(sql`INSERT INTO organization.organization_locations
      (organization_id, address_line_1, city, country, latitude, longitude, geo_source, timezone, is_primary, location_check_status)
    VALUES (${org.id}::uuid, '12 Test Street', ${city}, 'IR', 35.7, 51.4, 'user_pin', 'Asia/Tehran', true,
            ${o.farApart ? 'far_apart' : 'consistent'})`);
  return org;
}

const search = (body: Json, as: Actor = mod) => as.c.post('/v1/admin/orgs/search', { limit: 100, ...body });
const ids = (res: { body: Json }) => (res.body.items as Json[]).map((r) => r.id as string);

/** A pending check of a new provider, submitted by its owner. */
async function pendingCheck(type = 'business_identity', body: Json = {}) {
  const owner = await h.member('provider');
  const v = ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications`, { verification_type: type, ...body }), 'verification');
  return { owner, id: v.id as string };
}

const decide = (id: string, body: Json, as: Actor = mod) =>
  as.c.post(`/v1/admin/verifications/${id}/decision`, { reason: REASON, ...body }, purpose('verification', id));

const infoRequest = (o: Json = {}) => ({
  decision: 'info_requested',
  info_request: {
    missing_items: ['registration_number', 'readable_copy'],
    template_key: 'unreadable_documents',
    message: 'The licence photo is blurred. Please send a clear copy and the registration number.',
    ...o,
  },
});

beforeAll(async () => {
  h = await Harness.start();
  mod = await h.staff('platform_moderator');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('organization search filters (BR-35 part 1)', () => {
  it('finds possible duplicates by normalized name in a shared city or by phone, and flags the rows', async () => {
    const t = tag();
    const a = await orgIn(`${t} Garage`, 'Tehran');
    const b = await orgIn(`${t.toUpperCase()}  garage.`, ' tehran ');
    const elsewhere = await orgIn(`${t} Garage`, 'Shiraz');
    const phone = `+98912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const p1 = await orgIn(`${t} Phone One`, 'Tabriz', { phone });
    const p2 = await orgIn(`${t} Phone Two`, 'Mashhad', { phone });

    const dup = await search({ name: t, possible_duplicate: true });
    expect(dup.status, dup.text).toBe(200);
    expect(ids(dup).sort()).toEqual([a.id, b.id, p1.id, p2.id].sort());
    expect((dup.body.items as Json[]).every((r) => r.possible_duplicate === true)).toBe(true);
    const not = await search({ name: t, possible_duplicate: false });
    expect(ids(not)).toEqual([elsewhere.id]);
    expect((not.body.items as Json[])[0]).toMatchObject({ possible_duplicate: false, location_issue: false, city: 'Shiraz' });
    // Still no contact data or points in a search row (S14, DI-31).
    expect(projectionViolations(dup.body, { opId: 'admin.orgs_search', vins: h.vins, tradeAllowed: false })).toEqual([]);
    expect(dup.text).not.toContain(phone);

    // A merged organization is neither flagged nor a match.
    await h.q(sql`UPDATE organization.organizations SET status = 'merged', merged_into_organization_id = ${a.id}::uuid
      WHERE id = ${b.id}::uuid`);
    expect(ids(await search({ name: t, possible_duplicate: true })).sort()).toEqual([p1.id, p2.id].sort());
  });

  it('filters by city, plan, open cases and location issues (far-apart pin or open wrong-location report)', async () => {
    const t = tag();
    const plain = await orgIn(`${t} Plain`, 'Isfahan');
    const far = await orgIn(`${t} Far`, 'Isfahan', { farApart: true });
    const reported = await orgIn(`${t} Reported`, 'Karaj');
    const withCase = await orgIn(`${t} Case`, 'Karaj');
    await h.fx.subscription(plain, 'provider_pro');
    await h.fx.subscription(far, 'provider_basic');

    expect(ids(await search({ name: t, city: 'isfahan' })).sort()).toEqual([plain.id, far.id].sort());
    expect(ids(await search({ name: t, plan_key: 'provider_pro' }))).toEqual([plain.id]);

    await openCase(h.api, { type: 'organization', targetId: withCase.id });
    const casesOnly = await search({ name: t, has_open_cases: true });
    expect(ids(casesOnly)).toEqual([withCase.id]);
    expect((casesOnly.body.items as Json[])[0]!.open_cases).toBe(1);
    expect(ids(await search({ name: t, has_open_cases: false })).sort()).toEqual([plain.id, far.id, reported.id].sort());

    // A wrong-location report about one of the organization's locations.
    const [loc] = await h.q<{ id: string }>(
      sql`SELECT id FROM organization.organization_locations WHERE organization_id = ${reported.id}::uuid`,
    );
    const reporter = await h.user();
    ok(
      await reporter.c.post('/v1/reports', {
        target_type: 'organization_location',
        target_id: loc!.id,
        reason: 'wrong_location_or_closed',
      }),
      'report',
    );
    const issues = await search({ name: t, location_issue: true });
    expect(ids(issues).sort()).toEqual([far.id, reported.id].sort());
    expect((issues.body.items as Json[]).every((r) => r.location_issue === true)).toBe(true);
    expect(ids(await search({ name: t, location_issue: false, city: 'Karaj' }))).toEqual([withCase.id]);
  });

  it('scans in batches for the cross-module filters: a short page carries a cursor until the end', async () => {
    const t = tag();
    const org = await orgIn(`${t} Paged`, 'Qom');
    await openCase(h.api, { type: 'organization', targetId: org.id });
    // No name filter: the whole table is scanned in pages of at most 1,000 organizations.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await search({ has_open_cases: true, limit: 100, ...(cursor ? { cursor } : {}) });
      expect(res.status, res.text).toBe(200);
      seen.push(...ids(res));
      cursor = (res.body.next_cursor as string | null) ?? undefined;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toContain(org.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('request more info on a verification check (BR-35 part 2, R-25)', () => {
  it('keeps the check pending, pauses its clock until the business resubmits, and notifies the business', async () => {
    const { owner, id } = await pendingCheck();
    const before = ok(await mod.c.get('/v1/admin/verifications?status=pending&limit=100&assignee=unassigned'), 'queue');
    const queued = (before.items as Json[]).find((i) => i.id === id)!;
    expect(queued).toMatchObject({ assignee: null, sla_paused_since: null, info_request: null, callback_result: 'not_requested' });
    expect(queued.owner).toMatchObject({ user_id: owner.user.id });

    const asked = await decide(id, infoRequest());
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body).toMatchObject({
      status: 'pending',
      info_request: {
        status: 'open',
        missing_items: ['registration_number', 'readable_copy'],
        template_key: 'unreadable_documents',
        answered_at: null,
      },
    });
    // One open request at a time.
    const again = await decide(id, infoRequest({ template_key: 'other' }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');

    // The queue: paused, assigned to the moderator who asked; filtered as waiting for the business.
    const waiting = ok(await mod.c.get('/v1/admin/verifications?status=pending&limit=100&info_requested=true&assignee=me'), 'queue');
    const item = (waiting.items as Json[]).find((i) => i.id === id)!;
    expect(item.sla_paused_since).toBeTruthy();
    expect(item.assignee).toMatchObject({ user_id: mod.user.id });
    const start = Date.parse(item.sla_started_at as string);

    // The business reads the request (never the moderator) and is notified.
    const mine = ok(await owner.c.get(`/v1/orgs/${owner.org!.id}/verifications`), 'list');
    const seen = (mine.items as Json[]).find((v) => v.id === id)!;
    expect(seen.info_request).toMatchObject({ status: 'open', message: expect.stringContaining('blurred') });
    expect(JSON.stringify(seen)).not.toContain(mod.user.id);
    await h.settle();
    const [n] = await h.q<{ template_key: string }>(sql`SELECT template_key FROM notification.notifications
      WHERE recipient_user_id = ${owner.user.id}::uuid AND template_key = 'organization.verification_info_requested'`);
    expect(n?.template_key).toBe('organization.verification_info_requested');

    // Pretend CarPal waited one hour: the paused time moves the clock's start forward on resubmission.
    await h.q(sql`UPDATE organization.organization_verifications SET sla_paused_at = sla_paused_at - interval '1 hour'
      WHERE id = ${id}::uuid`);
    const doc = await h.upload(owner, 'verification_document', { mime: 'application/pdf' });
    const back = await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications/${id}/resubmit`, {
      submitted_document_ids: [doc.id],
      registration_number: '10101234567',
      note: 'Clear copy attached.',
    });
    expect(back.status, back.text).toBe(200);
    expect(back.body).toMatchObject({
      status: 'pending',
      registration_number: '10101234567',
      submitted_document_ids: [doc.id],
      info_request: { status: 'answered', response_note: 'Clear copy attached.', added_document_ids: [doc.id] },
    });
    const resumed = ok(await mod.c.get('/v1/admin/verifications?status=pending&limit=100&info_requested=false&assignee=me'), 'queue');
    const r = (resumed.items as Json[]).find((i) => i.id === id)!;
    expect(r.sla_paused_since).toBeNull();
    expect(Date.parse(r.sla_started_at as string) - start).toBeGreaterThanOrEqual(3_590_000);
    // Nothing left to answer.
    const twice = await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications/${id}/resubmit`, { note: 'Again.' });
    expect(twice.status).toBe(409);

    // The answered check is decided as usual; the moderator's own decision closes the purpose.
    const done = await decide(id, { decision: 'verified' });
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ status: 'verified', info_request: { status: 'answered' } });
    const [audit] = await h.q<{ n: string }>(sql`SELECT count(*) AS n FROM analytics.audit_logs
      WHERE entity_id = ${id}::uuid AND action IN ('organization.verification_info_requested', 'organization.verification_resubmitted')`);
    expect(Number(audit!.n)).toBe(2);
  });

  it('closes an unanswered request when staff decide, and validates the decision input', async () => {
    const { owner, id } = await pendingCheck('location');
    expect((await decide(id, { decision: 'info_requested' })).status).toBe(422);
    expect((await decide(id, { decision: 'verified', info_request: infoRequest().info_request })).status).toBe(422);
    expect((await decide(id, { decision: 'info_requested', rejection_reason: 'x', info_request: infoRequest().info_request })).status).toBe(
      422,
    );
    ok(await decide(id, infoRequest({ missing_items: ['location_pin'], template_key: 'location_mismatch' })), 'asked');
    // The registration number belongs to the business identity check.
    const wrong = await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications/${id}/resubmit`, { registration_number: '1' });
    expect(wrong.status).toBe(422);
    const rejected = await decide(id, { decision: 'rejected', rejection_reason: 'No answer about the pin.' });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body.info_request).toMatchObject({ status: 'closed' });
    const [row] = await h.q<{ sla_paused_at: Date | null }>(
      sql`SELECT sla_paused_at FROM organization.organization_verifications WHERE id = ${id}::uuid`,
    );
    expect(row!.sla_paused_at).toBeNull();
    expect((await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications/${id}/resubmit`, { note: 'Late.' })).status).toBe(409);
  });

  it('assigns checks; the purpose then opens for the assignee only', async () => {
    const other = await h.staff('platform_moderator');
    const { id } = await pendingCheck();
    const assigned = await mod.c.post(`/v1/admin/verifications/${id}/assign`, { assignee_user_id: other.user.id, reason: REASON });
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body).toMatchObject({ id, assignee: { user_id: other.user.id }, status: 'pending' });
    expect(assigned.body.assigned_at).toBeTruthy();
    // Only moderators and administrators can be given a check.
    const support = await h.staff('platform_support');
    const refused = await mod.c.post(`/v1/admin/verifications/${id}/assign`, { assignee_user_id: support.user.id, reason: REASON });
    expect(refused.status).toBe(422);
    // The assignee works on it; another moderator's purpose is not in their queue (404).
    expect((await decide(id, infoRequest())).status).toBe(404);
    expect((await decide(id, infoRequest(), other)).status).toBe(200);
    const mine = ok(await other.c.get('/v1/admin/verifications?status=pending&limit=100&assignee=me'), 'queue');
    expect((mine.items as Json[]).map((i) => i.id)).toContain(id);
    // Decided checks cannot be reassigned.
    ok(await decide(id, { decision: 'rejected', rejection_reason: 'Duplicate business.' }, other), 'rejected');
    expect((await other.c.post(`/v1/admin/verifications/${id}/assign`, { reason: REASON })).status).toBe(409);
  });

  it('shows the registration number, the call-back result and the possible-duplicate flag in the queue', async () => {
    const { owner, id } = await pendingCheck('business_identity', { registration_number: '14001234567' });
    // A phone check of the same organization: its latest status is the call-back result.
    await h.q(sql`INSERT INTO organization.organization_verifications (organization_id, verification_type, status, reviewed_by, reviewed_at)
      VALUES (${owner.org!.id}::uuid, 'phone', 'verified', ${mod.user.id}::uuid, now())`);
    // The queue is oldest first: a database used by many runs holds more than one page of pending checks.
    let item: Json | undefined;
    for (let cursor: string | null = null, first = true; !item && (first || cursor); first = false) {
      const q = ok(
        await mod.c.get(
          `/v1/admin/verifications?status=pending&verification_type=business_identity&limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        ),
        'queue',
      );
      item = (q.items as Json[]).find((i) => i.id === id);
      cursor = q.next_cursor as string | null;
    }
    expect(item).toMatchObject({
      registration_number: '14001234567',
      callback_result: 'verified',
      possible_duplicate: false,
      ai_precheck: null,
    });
    // Other checks refuse the registration number.
    const bad = await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications`, { verification_type: 'address', registration_number: '1' });
    expect(bad.status).toBe(422);
  });
});

describe('profile corrections and history (BR-35 part 3)', () => {
  it('corrects named fields with a reason, audits it, notifies the organization and lists the history under a purpose', async () => {
    const owner = await h.member('provider');
    const orgId = owner.org!.id;
    const org = ok(await owner.c.get(`/v1/orgs/${orgId}`), 'org');
    ok(
      await owner.c.patch(`/v1/orgs/${orgId}`, { name: 'Ali Garage', contact_phone: '+989121112233' }, org.version as number),
      'member edit',
    );

    const fixed = await mod.c.post(`/v1/admin/orgs/${orgId}/correct`, {
      name: 'Ali Auto Garage',
      website: 'https://aliautogarage.example.com',
      description_translations: { en: 'Brakes and suspension' },
      reason: 'Name typo reported by the owner on the phone',
    });
    expect(fixed.status, fixed.text).toBe(200);
    expect(fixed.body).toMatchObject({
      actor: 'staff',
      source: 'admin.org_correct',
      reason: 'Name typo reported by the owner on the phone',
      changes: [
        { field: 'name', previous: 'Ali Garage', next: 'Ali Auto Garage' },
        { field: 'website', previous: null, next: 'https://aliautogarage.example.com' },
        { field: 'description_translations', previous_translations: null, next_translations: { en: 'Brakes and suspension' } },
      ],
    });
    // Contact data and the slug stay the organization's own; a correction that changes nothing is refused.
    expect((await mod.c.post(`/v1/admin/orgs/${orgId}/correct`, { contact_phone: '+989120000000', reason: REASON })).status).toBe(422);
    const same = await mod.c.post(`/v1/admin/orgs/${orgId}/correct`, { name: 'Ali Auto Garage', reason: REASON });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('INVALID_TRANSITION');

    const [audit] = await h.q<{ reason: string }>(sql`SELECT reason FROM analytics.audit_logs
      WHERE action = 'organization.profile_corrected' AND entity_id = ${orgId}::uuid`);
    expect(audit?.reason).toBe('Name typo reported by the owner on the phone');
    await h.settle();
    const [n] = await h.q<{ template_key: string }>(sql`SELECT template_key FROM notification.notifications
      WHERE recipient_user_id = ${owner.user.id}::uuid AND template_key = 'organization.profile_corrected'`);
    expect(n?.template_key).toBe('organization.profile_corrected');

    // The history: staff correction first, then the member's edit (with the contact change), under a purpose only.
    const support = await h.staff('platform_support');
    const caseId = await openCase(h.api, { type: 'organization', targetId: orgId });
    const history = await support.c.get(`/v1/admin/orgs/${orgId}/history`, purpose('case', caseId));
    expect(history.status, history.text).toBe(200);
    const items = history.body.items as Json[];
    expect(items.map((i) => i.actor)).toEqual(['staff', 'member']);
    expect(items[1]).toMatchObject({
      source: 'org.update',
      reason: null,
      changes: [
        { field: 'name', next: 'Ali Garage' },
        { field: 'contact_phone', previous: null, next: '+989121112233' },
      ],
    });
    expect((await support.c.get(`/v1/admin/orgs/${orgId}/history`)).status).toBe(400);
    const elsewhere = await h.fx.org('provider');
    const otherCase = await openCase(h.api, { type: 'organization', targetId: elsewhere.id });
    expect((await support.c.get(`/v1/admin/orgs/${orgId}/history`, purpose('case', otherCase))).status).toBe(403);
    const [read] = await h.q<{ n: string }>(sql`SELECT count(*) AS n FROM analytics.audit_logs
      WHERE action = 'pii.read' AND entity_id = ${orgId}::uuid AND access_purpose = ${`case:${caseId}`}`);
    expect(Number(read!.n)).toBeGreaterThanOrEqual(1);

    // Merged organizations cannot be corrected.
    await h.q(sql`UPDATE organization.organizations SET status = 'merged', merged_into_organization_id = ${elsewhere.id}::uuid
      WHERE id = ${orgId}::uuid`);
    expect((await mod.c.post(`/v1/admin/orgs/${orgId}/correct`, { name: 'Another Name', reason: REASON })).status).toBe(409);
  });
});

describe('assisted onboarding sessions list (BR-34)', () => {
  it('lists my open sessions after a reload, and shows a session past its 4 hours as expired', async () => {
    const me = await h.staff('platform_support');
    const colleague = await h.staff('platform_admin');
    const [a, b, c] = await Promise.all([h.fx.org('provider'), h.fx.org('provider'), h.fx.org('provider')]);
    const start = (as: Actor, org: TestOrg) =>
      as.c.post(`/v1/admin/orgs/${org.id}/assist-sessions`, { flow_type: 'provider', reason: REASON });
    const open = ok(await start(me, a), 'mine');
    const old = ok(await start(me, b), 'old');
    ok(await start(colleague, c), 'theirs');
    await h.q(sql`UPDATE admin.assist_sessions SET started_at = now() - interval '5 hours', expires_at = now() - interval '1 hour'
      WHERE id = ${old.assist_session_id as string}::uuid`);

    const active = await me.c.get('/v1/admin/assist-sessions?mine=true&status=active');
    expect(active.status, active.text).toBe(200);
    const items = active.body.items as Json[];
    expect(items.map((i) => i.assist_session_id)).toEqual([open.assist_session_id]);
    expect(items[0]).toMatchObject({ organization: { id: a.id }, flow_type: 'provider', status: 'active', mine: true, ended_at: null });

    const expired = ok(await me.c.get(`/v1/admin/assist-sessions?mine=true&status=expired&organization_id=${b.id}`), 'expired');
    expect((expired.items as Json[]).map((i) => i.status)).toEqual(['expired']);
    const theirs = ok(await me.c.get(`/v1/admin/assist-sessions?organization_id=${c.id}`), 'theirs');
    expect(theirs.items as Json[]).toEqual([expect.objectContaining({ mine: false, status: 'active' })]);
    // Moderators do not run assisted sessions (STF refusal: 404).
    expect((await mod.c.get('/v1/admin/assist-sessions')).status).toBe(404);
  });
});
