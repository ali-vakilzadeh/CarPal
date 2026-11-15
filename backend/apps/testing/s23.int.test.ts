// S23 (contract 1.4.0; backend/BR-update-plan.json S23, admin console BR-16, DI-06, DI-07): the staff reads behind the
// A-USR-02 tabs (vehicles, appointments, consents, sessions and devices) and the A-ORG-02 tabs (capabilities and badges,
// portfolio, inventory quality, members, plan history). Every read is PURP and bound per S14 to the user or
// organization in its path; the PII reads write a pii.read entry naming the bound subject. Records come from the
// contract sweep's fixtures (Harness).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { Harness, ok, sql, type Actor, type Json } from './contract/harness.js';
import { projectionViolations } from './contract/projection.js';
import { openCase, purpose } from './s8-support.js';

let h: Harness;
let mod: Actor;
let sup: Actor;
let crv: Actor;

const USER_OPS = ['vehicles', 'appointments', 'consents', 'sessions'] as const;
const ORG_OPS = ['capabilities', 'portfolio', 'inventory-quality', 'members', 'plan-history'] as const;
const PII_ORG_OPS = new Set(['portfolio', 'members']);
const items = (res: { body: Json }) => res.body.items as Json[];

/** pii.read entries of a request: the subject the purpose was bound to is named in the summary (S14). */
async function piiReads(entityId: string, casePurpose: string) {
  return h.q<{ new_state_summary: string }>(
    sql`SELECT new_state_summary FROM analytics.audit_logs
         WHERE action = 'pii.read' AND entity_id = ${entityId}::uuid AND access_purpose = ${casePurpose}`,
  );
}

beforeAll(async () => {
  h = await Harness.start();
  [mod, sup, crv] = await Promise.all([h.staff('platform_moderator'), h.staff('platform_support'), h.staff('platform_community_reviewer')]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('purpose binding of the nine reads (S14)', () => {
  it('user tabs: refused without a purpose, under a purpose about someone else and to a community reviewer; read under their own', async () => {
    const u = await h.user();
    const other = await h.user();
    const caseU = await openCase(h.api, { targetId: u.user.id });
    const caseOther = await openCase(h.api, { targetId: other.user.id });
    for (const tab of USER_OPS) {
      const path = `/v1/admin/users/${u.user.id}/${tab}`;
      expect((await mod.c.get(path)).status, tab).toBe(400);
      const wrong = await mod.c.get(path, purpose('case', caseOther));
      expect([wrong.status, wrong.body.code], tab).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
      // A staff role the operation does not name is not told the route exists (as S13).
      expect((await crv.c.get(path, purpose('case', caseU))).status, tab).toBe(404);
      const res = await sup.c.get(path, purpose('case', caseU));
      expect(res.status, `${tab}: ${res.text}`).toBe(200);
      expect(projectionViolations(res.body, { opId: `admin.user_${tab}`, vins: h.vins, tradeAllowed: false }), tab).toEqual([]);
    }
    // Each PII read named the case and the user it was bound to; nothing was logged for the other user.
    const reads = await piiReads(u.user.id, `case:${caseU}`);
    for (const group of ['vehicles (summary)', 'appointments (summary)', 'consent history', 'sessions and devices'])
      expect(reads.map((r) => r.new_state_summary)).toContain(`${group}; subject user:${u.user.id}`);
    expect(await piiReads(u.user.id, `case:${caseOther}`)).toHaveLength(0);
  });

  it('organization tabs: the same binding; only portfolio and members are PII reads', async () => {
    const o = await h.member('vendor');
    const otherOrg = await h.member('vendor');
    const caseO = await openCase(h.api, { type: 'organization', targetId: o.org!.id });
    const caseOther = await openCase(h.api, { type: 'organization', targetId: otherOrg.org!.id });
    for (const tab of ORG_OPS) {
      const path = `/v1/admin/orgs/${o.org!.id}/${tab}`;
      expect((await mod.c.get(path)).status, tab).toBe(400);
      const wrong = await mod.c.get(path, purpose('case', caseOther));
      expect([wrong.status, wrong.body.code], tab).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
      expect((await crv.c.get(path, purpose('case', caseO))).status, tab).toBe(404);
      const res = await mod.c.get(path, purpose('case', caseO));
      expect(res.status, `${tab}: ${res.text}`).toBe(200);
    }
    const reads = (await piiReads(o.org!.id, `case:${caseO}`)).map((r) => r.new_state_summary);
    expect(reads).toEqual(
      expect.arrayContaining([
        `portfolio with customer consents; subject organization:${o.org!.id}`,
        `members and invitations; subject organization:${o.org!.id}`,
      ]),
    );
    expect(reads).toHaveLength(PII_ORG_OPS.size);
  });

  it('a verification purpose admits its organization and its submitter, not the organization’s other members', async () => {
    const owner = await h.member('provider');
    const staffer = await h.colleague(owner, 'provider_staff');
    const v = ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/verifications`, { verification_type: 'business_identity' }), 'verification');
    const p = purpose('verification', v.id as string);
    expect((await mod.c.get(`/v1/admin/orgs/${owner.org!.id}/members`, p)).status).toBe(200);
    expect((await mod.c.get(`/v1/admin/users/${owner.user.id}/sessions`, p)).status).toBe(200);
    const notSubject = await mod.c.get(`/v1/admin/users/${staffer.user.id}/sessions`, p);
    expect([notSubject.status, notSubject.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
  });
});

describe('user tabs (A-USR-02, DI-07)', () => {
  it('vehicles: the user’s own only, masked plate and VIN, status filter and paging', async () => {
    const u = await h.user();
    const [a, b] = [await h.vehicle(u), await h.vehicle(u, { status: 'in_repair', year: 2015 })];
    await h.q(sql`UPDATE vehicle.vehicles SET license_plate = 'IR 12 B 345 42', notes = 'S23 private note' WHERE id = ${a}::uuid`);
    const someoneElse = await h.vehicle(await h.user());
    const fleet = await h.vehicle(await h.member('fleet'));
    const caseU = await openCase(h.api, { targetId: u.user.id });
    const all = await mod.c.get(`/v1/admin/users/${u.user.id}/vehicles`, purpose('case', caseU));
    expect(all.status, all.text).toBe(200);
    expect(items(all).map((v) => v.id)).toEqual([b, a]);
    expect(items(all)[1]).toEqual({
      id: a,
      brand: expect.objectContaining({ text: expect.any(String) }),
      model: expect.objectContaining({ text: expect.any(String) }),
      series: null,
      year: 2018,
      status: 'active',
      vin_last4: null,
      plate_masked: '•••• 42',
      created_at: expect.any(String),
    });
    expect(all.text).not.toContain('345');
    expect(all.text).not.toContain('private note');
    expect(all.text).not.toContain(someoneElse);
    expect(all.text).not.toContain(fleet);
    const repair = await mod.c.get(`/v1/admin/users/${u.user.id}/vehicles?status=in_repair`, purpose('case', caseU));
    expect(items(repair).map((v) => v.id)).toEqual([b]);
    const first = await mod.c.get(`/v1/admin/users/${u.user.id}/vehicles?limit=1`, purpose('case', caseU));
    expect(items(first).map((v) => v.id)).toEqual([b]);
    const next = await mod.c.get(
      `/v1/admin/users/${u.user.id}/vehicles?limit=1&cursor=${encodeURIComponent(first.body.next_cursor as string)}`,
      purpose('case', caseU),
    );
    expect(items(next).map((v) => v.id)).toEqual([a]);
    expect(next.body.next_cursor).toBeNull();
  });

  it('appointments: requested by the user, with business and vehicle card, never the description; status filter', async () => {
    const p = await h.provider();
    const u = await h.user();
    const vehicleId = await h.vehicle(u);
    const requested = await h.fx.appointment({ id: p.id, type: 'provider' }, u.user, vehicleId, { serviceSystemNodeId: h.n.system });
    const confirmed = await h.fx.appointment({ id: p.id, type: 'provider' }, u.user, vehicleId, {
      status: 'confirmed',
      start: new Date(Date.now() + 86_400_000),
    });
    // Another user's appointment with the same business is not listed.
    const other = await h.user();
    await h.fx.appointment({ id: p.id, type: 'provider' }, other.user, await h.vehicle(other));
    const caseU = await openCase(h.api, { targetId: u.user.id });
    const res = await sup.c.get(`/v1/admin/users/${u.user.id}/appointments`, purpose('case', caseU));
    expect(res.status, res.text).toBe(200);
    expect(items(res).map((a) => a.id)).toEqual([confirmed, requested]);
    expect(items(res)[1]).toMatchObject({
      provider: { id: p.id, organization_type: 'provider' },
      requester_type: 'user',
      requester_organization: null,
      vehicle: { id: vehicleId, year: 2018 },
      appointment_type: 'repair',
      service_system: expect.objectContaining({ text: expect.any(String) }),
      status: 'requested',
      confirmed_start_at: null,
    });
    expect(items(res)[0]).toMatchObject({ status: 'confirmed', confirmed_start_at: expect.any(String) });
    expect(res.text).not.toContain('squeal');
    const only = await sup.c.get(`/v1/admin/users/${u.user.id}/appointments?status=confirmed`, purpose('case', caseU));
    expect(items(only).map((a) => a.id)).toEqual([confirmed]);
  });

  it('consents: the full history, withdrawn included, with the active filter; staff cannot write', async () => {
    const u = await h.user();
    const m = ok(await u.c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '1.0' }), 'marketing');
    ok(await u.c.post(`/v1/me/consents/${m.id}/withdraw`, {}), 'withdraw');
    const ai = ok(await u.c.post('/v1/me/consents', { consent_type: 'ai_personalization', policy_version: '1.0' }), 'ai');
    const caseU = await openCase(h.api, { targetId: u.user.id });
    const all = await sup.c.get(`/v1/admin/users/${u.user.id}/consents`, purpose('case', caseU));
    expect(all.status, all.text).toBe(200);
    expect(items(all).map((c) => [c.id, c.consent_type, c.withdrawn_at === null])).toEqual([
      [ai.id, 'ai_personalization', true],
      [m.id, 'marketing', false],
    ]);
    expect(items(all)[0]).toMatchObject({ subject_type: 'user', subject_id: u.user.id, granted: true, source: 'ui' });
    const active = await sup.c.get(`/v1/admin/users/${u.user.id}/consents?active=true`, purpose('case', caseU));
    expect(items(active).map((c) => c.id)).toEqual([ai.id]);
    const marketing = await sup.c.get(`/v1/admin/users/${u.user.id}/consents?consent_type=marketing`, purpose('case', caseU));
    expect(items(marketing).map((c) => c.id)).toEqual([m.id]);
    // Read-only: the admin plane has no consent write (Docs/23 A-USR-02 Consents).
    expect((await sup.c.post(`/v1/admin/users/${u.user.id}/consents`, {}, purpose('case', caseU))).status).toBe(405);
  });

  it('sessions: active sessions with device and assurance and the push devices, never a token', async () => {
    const u = await h.user();
    await h.fx.token(u.user, { clientId: 'cp-web-consumer' });
    const tokenHash = randomBytes(32);
    const secretToken = `fcm-${uuidv7()}`;
    const [active, revoked] = [uuidv7(), uuidv7()];
    await h.q(sql`INSERT INTO notification.push_device_tokens (id, user_id, platform, token_encrypted, token_hash, app_version, locale, status)
      VALUES (${revoked}::uuid, ${u.user.id}::uuid, 'android', ${Buffer.from(secretToken)}, ${randomBytes(32)}, '1.0.0', 'fa', 'revoked'),
             (${active}::uuid, ${u.user.id}::uuid, 'ios', ${Buffer.from(secretToken)}, ${tokenHash}, '1.2.0', 'en', 'active')`);
    const caseU = await openCase(h.api, { targetId: u.user.id });
    const res = await sup.c.get(`/v1/admin/users/${u.user.id}/sessions`, purpose('case', caseU));
    expect(res.status, res.text).toBe(200);
    expect(res.body.sessions_total).toBe(2);
    expect((res.body.sessions as Json[]).map((s) => s.client_id).sort()).toEqual(['cp-mobile', 'cp-web-consumer']);
    for (const s of res.body.sessions as Json[]) {
      expect(s).toEqual({
        id: expect.any(String),
        client_id: expect.any(String),
        device_label: expect.any(String),
        created_at: expect.any(String),
        last_seen_at: expect.any(String),
        country: null,
        acr: expect.stringMatching(/^aal[123]$/),
        staff: false,
      });
    }
    expect(res.body.push_devices).toEqual([
      expect.objectContaining({ id: active, platform: 'ios', app_version: '1.2.0', locale: 'en', status: 'active' }),
      expect.objectContaining({ id: revoked, platform: 'android', status: 'revoked' }),
    ]);
    expect(res.text).not.toContain(secretToken);
    expect(res.text).not.toContain(u.token);
  });
});

describe('organization tabs (A-ORG-02, DI-06)', () => {
  it('capabilities and badges: the matrix strongest first and every badge with its rule evaluation', async () => {
    const p = await h.provider();
    const cap = ok(
      await p.as.c.post(`/v1/orgs/${p.id}/provider/capabilities`, {
        service_system_node_id: h.n.system,
        experience_level: 'advanced',
        public_visibility: true,
      }),
      'capability',
    );
    await h.q(sql`UPDATE organization.provider_capabilities SET confidence_score = 42.5 WHERE id = ${cap.id as string}::uuid`);
    const evaluation = { rule: 'highly_rated', inputs: { rating: 4.8, reviews: 31 }, passed: true };
    const [revoked, active] = [uuidv7(), uuidv7()];
    await h.q(sql`INSERT INTO trust.provider_badges (id, provider_organization_id, badge_type, rule_key, rule_version, evaluation_snapshot, status, revoked_reason)
      VALUES (${revoked}::uuid, ${p.id}::uuid, 'fast_responder', 'fast_responder', '1', '{"passed": false}'::jsonb, 'revoked', 'S23 test'),
             (${active}::uuid, ${p.id}::uuid, 'highly_rated', 'highly_rated', '1', ${JSON.stringify(evaluation)}::jsonb, 'active', null)`);
    const caseO = await openCase(h.api, { type: 'organization', targetId: p.id });
    const res = await mod.c.get(`/v1/admin/orgs/${p.id}/capabilities`, purpose('case', caseO));
    expect(res.status, res.text).toBe(200);
    expect((res.body.capabilities as Json[])[0]).toMatchObject({
      id: cap.id,
      confidence_score: expect.any(String),
      source: 'self_declared',
    });
    expect(res.body.capabilities_total).toBe((res.body.capabilities as Json[]).length);
    expect((res.body.badges as Json[]).map((b) => [b.id, b.status])).toEqual([
      [active, 'active'],
      [revoked, 'revoked'],
    ]);
    expect((res.body.badges as Json[])[0]).toMatchObject({ rule_key: 'highly_rated', evaluation_snapshot: evaluation });
  });

  it('portfolio: showcases with consent status, the customer’s consent record by display name and open cases', async () => {
    const p = await h.provider();
    const customer = await h.user();
    const item = ok(
      await p.as.c.post(`/v1/orgs/${p.id}/provider/portfolio`, {
        title: 'Clutch replacement',
        content_locale: 'en',
        service_system_node_id: h.n.system,
        visibility: 'public',
      }),
      'portfolio',
    );
    const consent = ok(
      await customer.c.post('/v1/me/consents', {
        consent_type: 'showcase_publishing',
        policy_version: '1.0',
        granted_to: { type: 'organization', id: p.id },
      }),
      'consent',
    );
    await h.q(sql`UPDATE organization.portfolio_items SET consent_reference_id = ${consent.id as string}::uuid, customer_consent_status = 'granted'
      WHERE id = ${item.id as string}::uuid`);
    await openCase(h.api, { type: 'portfolio_item', targetId: item.id as string });
    const caseO = await openCase(h.api, { type: 'organization', targetId: p.id });
    const res = await sup.c.get(`/v1/admin/orgs/${p.id}/portfolio`, purpose('case', caseO));
    expect(res.status, res.text).toBe(200);
    const row = items(res).find((i) => i.id === item.id)!;
    expect(row).toMatchObject({
      title: 'Clutch replacement',
      customer_consent_status: 'granted',
      moderation_status: expect.any(String),
      open_cases: 1,
      consent: { customer_display_name: expect.any(String), consent_type: 'showcase_publishing', granted: true, withdrawn_at: null },
    });
    expect(res.text).not.toContain(customer.user.email);
    const drafts = await sup.c.get(`/v1/admin/orgs/${p.id}/portfolio?status=archived`, purpose('case', caseO));
    expect(items(drafts)).toEqual([]);
  });

  it('inventory quality: counts by status, data quality, the catalog score and flagged items with their flags', async () => {
    const v = await h.vendor();
    const base = `/v1/orgs/${v.id}/vendor/inventory`;
    const body = (sku: string) => ({
      sku: `${sku}-${h.newId().slice(-8)}`,
      name_translations: { en: 'Oil filter', fa: 'فیلتر روغن' },
      part_origin: 'aftermarket',
      condition: 'new',
      part_category_node_id: h.n.partCategory,
      price_public: '120000',
      currency: 'USD',
      price_on_request: false,
      stock_status: 'in_stock',
      visibility: 'public',
      status: 'active',
    });
    const [dup, review, plain] = [
      ok(await v.as.c.post(base, body('DUP')), 'dup'),
      ok(await v.as.c.post(base, body('REV')), 'review'),
      ok(await v.as.c.post(base, body('OK')), 'plain'),
    ];
    await h.q(sql`UPDATE inventory.inventory_items SET duplicate_of_item_id = ${v.itemId}::uuid WHERE id = ${dup.id as string}::uuid`);
    await h.q(sql`UPDATE inventory.inventory_items SET status = 'pending_review' WHERE id = ${review.id as string}::uuid`);
    await openCase(h.api, { type: 'inventory_item', targetId: v.itemId });
    const caseO = await openCase(h.api, { type: 'organization', targetId: v.id });
    const res = await mod.c.get(`/v1/admin/orgs/${v.id}/inventory-quality`, purpose('case', caseO));
    expect(res.status, res.text).toBe(200);
    expect(res.body.counts).toEqual({ draft: 0, active: 3, pending_review: 1, hidden: 0, discontinued: 0, removed: 0 });
    expect(res.body).toMatchObject({
      average_data_quality: expect.any(Number),
      confirmed_fitment_items: 0,
      inquiries_90d: 0,
      inquiry_fulfillment_percent: null,
      catalog_quality_score: expect.any(Number),
      flagged_total: 3,
    });
    const flags = Object.fromEntries(
      (res.body.flagged as Json[]).map((i) => [i.id, (i.flags as string[]).filter((f) => f !== 'low_quality')]),
    );
    expect(flags).toEqual({
      [v.itemId]: ['open_case'],
      [dup.id as string]: ['possible_duplicate'],
      [review.id as string]: ['pending_review'],
    });
    expect(flags[plain.id as string]).toBeUndefined();
    expect(projectionViolations(res.body, { opId: 'admin.org_inventory_quality', vins: h.vins, tradeAllowed: false })).toEqual([]);

    // An organization without inventory answers zeros.
    const provider = await h.member('provider');
    const caseP = await openCase(h.api, { type: 'organization', targetId: provider.org!.id });
    const none = await mod.c.get(`/v1/admin/orgs/${provider.org!.id}/inventory-quality`, purpose('case', caseP));
    expect(none.body).toMatchObject({ average_data_quality: null, catalog_quality_score: 0, flagged: [], flagged_total: 0 });
  });

  it('members: members and pending invitations with role and status, filters', async () => {
    const owner = await h.member('provider');
    await h.colleague(owner, 'provider_manager');
    const invitee = `s23-${uuidv7()}@test.carpal.app`;
    ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/members/invitations`, { email: invitee, role: 'provider_staff' }), 'invite');
    const caseO = await openCase(h.api, { type: 'organization', targetId: owner.org!.id });
    const res = await sup.c.get(`/v1/admin/orgs/${owner.org!.id}/members`, purpose('case', caseO));
    expect(res.status, res.text).toBe(200);
    expect(items(res).map((m) => [m.role, m.status])).toEqual([
      ['provider_owner', 'active'],
      ['provider_manager', 'active'],
      ['provider_staff', 'invited'],
    ]);
    expect(items(res)[2]).toMatchObject({ user_id: null, email: invitee });
    const invited = await sup.c.get(`/v1/admin/orgs/${owner.org!.id}/members?status=invited`, purpose('case', caseO));
    expect(items(invited).map((m) => m.email)).toEqual([invitee]);
  });

  it('plan history: every subscription newest first with who assigned it and the plan request it answered', async () => {
    const o = await h.member('provider');
    const first = await h.fx.subscription(o.org!, 'provider_basic', { status: 'trial' });
    await h.q(sql`UPDATE billing.subscriptions SET status = 'expired' WHERE id = ${first}::uuid`);
    const second = await h.fx.subscription(o.org!, 'provider_pro');
    const assigner = await h.staff('platform_admin');
    const requestId = uuidv7();
    await h.q(sql`UPDATE billing.subscriptions SET assigned_by = ${assigner.user.id}::uuid WHERE id = ${second}::uuid`);
    await h.q(sql`INSERT INTO billing.subscription_change_requests
        (id, organization_id, requested_by_user_id, current_subscription_id, requested_plan_id, note, status, handled_by, handled_at, resulting_subscription_id)
      SELECT ${requestId}::uuid, ${o.org!.id}::uuid, ${o.user.id}::uuid, ${first}::uuid, p.id, 'We need more seats', 'assigned',
             ${assigner.user.id}::uuid, now(), ${second}::uuid
        FROM billing.plans p WHERE p.plan_key = 'provider_pro'`);
    const caseO = await openCase(h.api, { type: 'organization', targetId: o.org!.id });
    const res = await sup.c.get(`/v1/admin/orgs/${o.org!.id}/plan-history`, purpose('case', caseO));
    expect(res.status, res.text).toBe(200);
    expect(items(res).map((s) => [s.id, s.plan_key, s.status])).toEqual([
      [second, 'provider_pro', 'active'],
      [first, 'provider_basic', 'expired'],
    ]);
    expect(items(res)[0]).toMatchObject({
      subscriber: { type: 'organization', id: o.org!.id },
      assigned_by_display: expect.any(String),
      change_request: {
        id: requestId,
        requested_plan_key: 'provider_pro',
        note: 'We need more seats',
        requested_by_display: expect.any(String),
      },
    });
    expect(items(res)[1]).toMatchObject({ assigned_by_display: null, change_request: null, trial_ends_at: expect.any(String) });
    const page = await sup.c.get(`/v1/admin/orgs/${o.org!.id}/plan-history?limit=1`, purpose('case', caseO));
    expect(items(page).map((s) => s.id)).toEqual([second]);
    expect(page.body.next_cursor).toEqual(expect.any(String));
  });
});
