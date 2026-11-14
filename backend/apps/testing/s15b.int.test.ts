// S15b (contract 1.4.0; backend/BR-update-plan.json S15b, owner decisions DQ-18 and DQ-19): consent texts as
// versioned documents (one per ConsentType and region, seeded 1.0 for ir-pilot), grants bound to the text in force,
// re-consent of granted consents for users (Me.policy_reconsent, policy.accept) and organizations (ConsentRecord
// flags, org.consents_confirm), and the administrator's keep / pause choice that the consent gate follows.
// Every version this suite publishes is deleted at the end (with the consents and confirmations that point to it), so
// the seeded 1.0 texts are back in force.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentChecker, type ConsentQuery } from '#libs/consent-gate/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { identityPersonalData } from '#modules/identity/application/dsr-worker.js';
import { PolicyVersionRule } from '#modules/identity/application/policy-ops.js';
import { ConsentGrants } from '#modules/identity/interface/identity.js';
import type { INestApplicationContext } from '@nestjs/common';
import type { Json } from './s4-support.js';
import { client, type Client } from './s5-support.js';
import { REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, testConfig, testLogger, type TestApp } from './test-app.js';

let infra: Infra;
let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let a: StaffApi;
let b: StaffApi;
/** Versions created here: deleted after the suite with everything that refers to them. */
const created: string[] = [];

type SysScope = Parameters<Parameters<TestApp['fixtures']['worker']['run']>[1]>[0];
const sys = <T>(fn: (scope: SysScope) => Promise<T>): Promise<T> => api.fixtures.worker.run({ actorType: 'system' }, fn);
const fresh = () => ({ acr: 'aal2' as const, authTime: Math.floor(Date.now() / 1000) });

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  api = await createTestApp({ host: 'api', infra });
  admin = await createTestApp({ host: 'admin-api', infra });
  worker = await createTestWorker({ infra });
  a = (await staff(admin, 'platform_admin')).c;
  b = (await staff(admin, 'platform_admin')).c;
}, 60_000);

afterAll(async () => {
  if (created.length)
    await sys(async ({ db }) => {
      const records = db.selectFrom('identity.consent_records').select('id').where('policy_version_id', 'in', created);
      await db
        .deleteFrom('identity.consent_confirmations')
        .where((eb) => eb.or([eb('policy_version_id', 'in', created), eb('consent_id', 'in', records)]))
        .execute();
      await db.deleteFrom('identity.consent_records').where('policy_version_id', 'in', created).execute();
      await db.deleteFrom('identity.policy_acceptances').where('policy_version_id', 'in', created).execute();
      await db.deleteFrom('identity.policy_versions').where('id', 'in', created).execute();
    });
  await worker?.get(PolicyVersionRule).run();
  await worker?.close();
  await admin?.close();
  await api?.close();
  await infra?.close();
});

const label = (prefix: string) => `${prefix}-${uuidv7().slice(-8)}`;

async function draft(key: string, policyVersion: string): Promise<Json> {
  const res = await a.post(`/v1/admin/policies/${key}/versions`, {
    policy_version: policyVersion,
    title_translations: { en: 'Test consent text', fa: 'متن رضایت آزمون' },
    body_translations: { en: '# Consent\n\nBody.', fa: '# رضایت\n\nبدنه.' },
    reason: REASON,
  });
  expect(res.status, res.text).toBe(201);
  created.push(res.body.id as string);
  return res.body;
}

/** Publish request by admin A (in force at once), approved by admin B; returns the version after approval. */
async function publish(id: string, o: { reconsent?: boolean; action?: 'keep' | 'pause' } = {}): Promise<Json> {
  const req = await a.post(`/v1/admin/policy-versions/${id}/publish`, {
    effective_at: new Date(Date.now() - 5_000).toISOString(),
    requires_reconsent: o.reconsent ?? false,
    ...(o.action ? { reconsent_action: o.action } : {}),
    reason: REASON,
  });
  expect(req.status, req.text).toBe(202);
  const decided = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason: 'Legal approved' });
  expect(decided.status, decided.text).toBe(200);
  return (await a.get(`/v1/admin/policy-versions/${id}`)).body;
}

/** A new consent-text version of `key` in force now; returns its label. */
async function inForce(key: string, o: { reconsent?: boolean; action?: 'keep' | 'pause' } = {}): Promise<string> {
  const v = label('c');
  const d = await draft(key, v);
  expect(await publish(d.id as string, o)).toMatchObject({ status: 'published', requires_reconsent: o.reconsent ?? false });
  return v;
}

async function userClient(): Promise<{ user: TestUser; c: Client }> {
  const user = await api.fixtures.user();
  return { user, c: client(api, await api.fixtures.token(user)) };
}

const reconsentOf = async (c: Client) => {
  const me = await c.get('/v1/me');
  expect(me.status, me.text).toBe(200);
  return me.body.policy_reconsent as Json[];
};
const consentOf = async (c: Client, id: string) => ((await c.get('/v1/me/consents')).body.items as Json[]).find((x) => x.id === id) as Json;
const granted = (q: ConsentQuery) => sys((scope) => api.app.get(ConsentChecker, { strict: false }).isGranted(scope, q));
const seededId = (key: string) =>
  sys(async ({ db }) =>
    db
      .selectFrom('identity.policy_versions as v')
      .innerJoin('identity.policy_documents as d', 'd.id', 'v.document_id')
      .select('v.id')
      .where('d.policy_key', '=', key)
      .where('d.region_key', '=', 'ir-pilot')
      .where('v.policy_version', '=', '1.0')
      .executeTakeFirstOrThrow(),
  );

describe('consent texts as documents (DQ-18)', () => {
  it('lists every consent type after the three policies, with 1.0 in force; policy.current serves a consent text', async () => {
    const list = await a.get('/v1/admin/policies');
    expect(list.status, list.text).toBe(200);
    const items = list.body.items as Json[];
    expect(items).toHaveLength(16);
    expect(items.slice(0, 3).map((d) => d.reconsent_mode)).toEqual(['blocking', 'blocking', 'notice']);
    expect(items.slice(3).map((d) => d.policy_key)).toEqual([
      'vehicle_data_sharing',
      'service_history_sharing',
      'vendor_fitment_context',
      'photo_publishing',
      'showcase_publishing',
      'ai_personalization',
      'review_invitations',
      'fleet_driver_data_visibility',
      'fleet_data_ai_use',
      'provider_analytics_ai_use',
      'vendor_inventory_ai_use',
      'location_usage',
      'marketing',
    ]);
    for (const d of items.slice(3)) {
      expect(d).toMatchObject({ region_key: 'ir-pilot', reconsent_mode: 'consent' });
      expect((d.versions as Json[]).find((v) => v.policy_version === '1.0')).toMatchObject({
        status: 'published',
        reconsent_action: null,
        locales: ['en', 'fa'],
      });
    }

    const { c } = await userClient();
    const fa = await c.get('/v1/policies/marketing', { 'accept-language': 'fa' });
    expect(fa.status, fa.text).toBe(200);
    expect(fa.body).toMatchObject({
      policy_key: 'marketing',
      policy_version: '1.0',
      reconsent_mode: 'consent',
      reconsent_action: null,
      title: { text: 'پیام‌های تبلیغاتی', locale: 'fa' },
    });
  });

  it('accepts the re-consent choice only on consent texts that require re-consent (default keep)', async () => {
    const terms = await draft('terms', label('t'));
    const onTerms = await a.post(`/v1/admin/policy-versions/${terms.id}/publish`, {
      effective_at: new Date().toISOString(),
      requires_reconsent: true,
      reconsent_action: 'keep',
      reason: REASON,
    });
    expect(onTerms.status).toBe(422);
    expect(onTerms.body.errors).toContainEqual(expect.objectContaining({ pointer: '/reconsent_action', code: 'conditional_forbidden' }));
    const m = await draft('marketing', label('m'));
    const noReconsent = await a.post(`/v1/admin/policy-versions/${m.id}/publish`, {
      effective_at: new Date().toISOString(),
      requires_reconsent: false,
      reconsent_action: 'pause',
      reason: REASON,
    });
    expect(noReconsent.status).toBe(422);
    // The four-eyes request names the choice; without one, keep is applied.
    const req = await a.post(`/v1/admin/policy-versions/${m.id}/publish`, {
      effective_at: new Date(Date.now() + 86_400_000).toISOString(),
      requires_reconsent: true,
      reason: REASON,
    });
    expect(req.status, req.text).toBe(202);
    expect(req.body.summary).toContain('stay in effect until confirmed or withdrawn');
    const rejected = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'reject', reason: 'Not now' });
    expect(rejected.status, rejected.text).toBe(200);
  });
});

describe('grants bound to the consent text in force (S15b.T2)', () => {
  it('refuses another label on every grant path and records the text on the consent', async () => {
    const { user, c } = await userClient();
    const old = await c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '0.9' });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('POLICY_VERSION_OUTDATED');
    const ok = await c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '1.0' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({
      policy_version: '1.0',
      policy_version_id: (await seededId('marketing')).id,
      confirmed_policy_version: null,
      reconsent_required: false,
      paused: false,
    });

    // Organization consents (owner, aal2).
    const { org, user: owner } = await api.fixtures.memberOf('fleet', 'fleet_owner');
    const oc = client(api, await api.fixtures.token(owner, fresh()));
    const orgOld = await oc.post(`/v1/orgs/${org.id}/consents`, { consent_type: 'fleet_data_ai_use', policy_version: '2026-10' });
    expect(orgOld.body.code).toBe('POLICY_VERSION_OUTDATED');
    const orgOk = await oc.post(`/v1/orgs/${org.id}/consents`, { consent_type: 'fleet_data_ai_use', policy_version: '1.0' });
    expect(orgOk.status, orgOk.text).toBe(201);
    expect(orgOk.body.policy_version_id).toBe((await seededId('fleet_data_ai_use')).id);

    // Grants recorded by other modules (appointments' share_history, inquiries' share_vehicle_context).
    const provider = await api.fixtures.org('provider');
    const grants = api.app.get(ConsentGrants, { strict: false });
    const scoped = (policyVersion: string) =>
      sys((scope) =>
        grants.grantScoped(scope, {
          subjectUserId: user.id,
          consentType: 'vehicle_data_sharing',
          scope: { type: 'appointment', id: uuidv7() },
          grantee: { type: 'organization', id: provider.id },
          policyVersion,
        }),
      );
    await expect(scoped('1.1')).rejects.toMatchObject({ code: 'POLICY_VERSION_OUTDATED' });
    const id = await scoped('1.0');
    const row = await sys(({ db }) =>
      db.selectFrom('identity.consent_records').select('policy_version_id').where('id', '=', id).executeTakeFirstOrThrow(),
    );
    expect(row.policy_version_id).toBe((await seededId('vehicle_data_sharing')).id);
  });
});

describe('re-consent of granted consents (S15b.T3, DQ-19)', () => {
  it('keep: lists the consents under the older text, the gate still answers granted, confirming clears the entry', async () => {
    const { user, c } = await userClient();
    const g = await c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '1.0' });
    expect(g.status, g.text).toBe(201);
    const gate = { consentType: 'marketing' as const, subject: { type: 'user' as const, id: user.id } };
    expect(await reconsentOf(c)).toEqual([]);

    const v2 = await inForce('marketing', { reconsent: true, action: 'keep' });
    expect(await reconsentOf(c)).toEqual([
      expect.objectContaining({ policy_key: 'marketing', policy_version: v2, mode: 'consent', consent_ids: [g.body.id], paused: false }),
    ]);
    expect(await consentOf(c, g.body.id as string)).toMatchObject({ reconsent_required: true, paused: false });
    expect(await granted(gate)).toBe(true);

    // A new grant must name the new text; it is not listed.
    expect((await c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '1.0' })).body.code).toBe(
      'POLICY_VERSION_OUTDATED',
    );
    const later = await c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: v2 });
    expect(later.status, later.text).toBe(201);
    expect(later.body.reconsent_required).toBe(false);
    expect(((await reconsentOf(c))[0]!.consent_ids as string[]).includes(later.body.id as string)).toBe(false);

    // Confirming with the old label is refused; with the text in force it clears the entry.
    expect((await c.post('/v1/me/policy-acceptances', { policy_key: 'marketing', policy_version: '1.0' })).body.code).toBe(
      'POLICY_VERSION_OUTDATED',
    );
    const acc = await c.post('/v1/me/policy-acceptances', { policy_key: 'marketing', policy_version: v2 });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.body.policy_reconsent).toEqual([]);
    expect(await consentOf(c, g.body.id as string)).toMatchObject({
      policy_version: '1.0',
      confirmed_policy_version: v2,
      reconsent_required: false,
      paused: false,
    });
    expect((await consentOf(c, g.body.id as string)).confirmed_at).not.toBeNull();

    // The confirmation is part of the DSR export.
    const sections = await sys(async (scope) => identityPersonalData.export!(scope, user.id));
    const confirmations = sections.find((s) => s.section === 'consent_confirmations');
    expect(confirmations?.records.map((r) => r.fields)).toEqual([
      expect.objectContaining({ consent_id: g.body.id, consent_type: 'marketing', policy_version: v2 }),
    ]);
  });

  it('pause: a paused consent fails the gate until confirmed; withdrawing clears the entry', async () => {
    const { user, c } = await userClient();
    const first = await c.post('/v1/me/consents', {
      consent_type: 'ai_personalization',
      policy_version: '1.0',
      granted_to: { type: 'platform' },
    });
    expect(first.status, first.text).toBe(201);
    const gate: ConsentQuery = { consentType: 'ai_personalization', subject: { type: 'user', id: user.id }, grantee: { type: 'platform' } };
    expect(await granted(gate)).toBe(true);

    const v2 = await inForce('ai_personalization', { reconsent: true, action: 'pause' });
    expect(await granted(gate)).toBe(false);
    expect(await reconsentOf(c)).toEqual([
      expect.objectContaining({ policy_key: 'ai_personalization', mode: 'consent', consent_ids: [first.body.id], paused: true }),
    ]);
    expect(await consentOf(c, first.body.id as string)).toMatchObject({ reconsent_required: true, paused: true });
    // policy.current tells the client what the version does.
    expect((await c.get('/v1/policies/ai_personalization')).body).toMatchObject({ policy_version: v2, reconsent_action: 'pause' });

    // Withdrawing instead of confirming clears the entry; the gate stays closed.
    const w = await c.post(`/v1/me/consents/${first.body.id}/withdraw`);
    expect(w.status, w.text).toBe(200);
    expect(w.body).toMatchObject({ reconsent_required: false, paused: false });
    expect(await reconsentOf(c)).toEqual([]);
    expect(await granted(gate)).toBe(false);

    // Another user's paused consent comes back at once when confirmed.
    const other = await userClient();
    const second = await other.c.post('/v1/me/consents', {
      consent_type: 'ai_personalization',
      policy_version: v2,
      granted_to: { type: 'platform' },
    });
    expect(second.status, second.text).toBe(201);
    const otherGate: ConsentQuery = { ...gate, subject: { type: 'user', id: other.user.id } };
    expect(await granted(otherGate)).toBe(true);
    const v3 = await inForce('ai_personalization', { reconsent: true, action: 'pause' });
    expect(await granted(otherGate)).toBe(false);
    const acc = await other.c.post('/v1/me/policy-acceptances', { policy_key: 'ai_personalization', policy_version: v3 });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.body.policy_reconsent).toEqual([]);
    expect(await granted(otherGate)).toBe(true);

    // A later version without re-consent asks nobody again.
    await inForce('ai_personalization');
    expect(await reconsentOf(other.c)).toEqual([]);
    expect(await granted(otherGate)).toBe(true);
  });

  it('organization consents: flagged in org.consents_list, paused in the gate, confirmed by the owner', async () => {
    const { org, user: owner } = await api.fixtures.memberOf('fleet', 'fleet_owner');
    const oc = client(api, await api.fixtures.token(owner, fresh()));
    const g = await oc.post(`/v1/orgs/${org.id}/consents`, { consent_type: 'fleet_data_ai_use', policy_version: '1.0' });
    expect(g.status, g.text).toBe(201);
    const gate: ConsentQuery = { consentType: 'fleet_data_ai_use', subject: { type: 'organization', id: org.id } };
    expect(await granted(gate)).toBe(true);

    const v2 = await inForce('fleet_data_ai_use', { reconsent: true, action: 'pause' });
    expect(await granted(gate)).toBe(false);
    const listed = ((await oc.get(`/v1/orgs/${org.id}/consents`)).body.items as Json[]).find((x) => x.id === g.body.id);
    expect(listed).toMatchObject({ reconsent_required: true, paused: true });
    // Organization consents are not in the owner's own prompt.
    expect(await reconsentOf(oc)).toEqual([]);

    const confirm = (policyVersion: string) =>
      oc.post(`/v1/orgs/${org.id}/consents/${g.body.id}/confirm`, { policy_version: policyVersion });
    expect((await confirm('1.0')).body.code).toBe('POLICY_VERSION_OUTDATED');
    const ok = await confirm(v2);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ confirmed_policy_version: v2, reconsent_required: false, paused: false });
    expect(await granted(gate)).toBe(true);
    // Again: nothing new, same answer.
    expect((await confirm(v2)).body).toMatchObject({ confirmed_policy_version: v2, reconsent_required: false });

    // A withdrawn consent cannot be confirmed; another organization's consent is not found.
    await oc.post(`/v1/orgs/${org.id}/consents/${g.body.id}/withdraw`);
    expect((await confirm(v2)).body).toMatchObject({ code: 'INVALID_TRANSITION' });
    const stranger = await api.fixtures.memberOf('fleet', 'fleet_owner');
    const sc = client(api, await api.fixtures.token(stranger.user, fresh()));
    expect((await sc.post(`/v1/orgs/${stranger.org.id}/consents/${g.body.id}/confirm`, { policy_version: v2 })).status).toBe(404);
  });
});
