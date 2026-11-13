// S15 (contract 1.4.0, legal go-live; backend/BR-update-plan.json S15, admin console BR-12, A-POL-01): policy
// documents with versioned EN/FA texts, drafts and a four-eyes publish with an effective date and a re-consent flag,
// the public text in force (policy.current), acceptances at sign-up and from the re-consent prompt (policy.accept,
// Me.policy_reconsent), the worker rule that brings scheduled versions into force, and the DSR export section.
// Every version this suite publishes is deleted again at the end, so the seeded 1.0 texts are back in force.
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { identityPersonalData } from '#modules/identity/application/dsr-worker.js';
import { PolicyVersionRule } from '#modules/identity/application/policy-ops.js';
import type { Json } from './s4-support.js';
import { client, type Client } from './s5-support.js';
import { REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, testConfig, testLogger, type TestApp } from './test-app.js';

let infra: Infra;
let api: TestApp;
let admin: TestApp;
let auth: TestApp;
let worker: INestApplicationContext;
let a: StaffApi;
let b: StaffApi;
/** Versions created here: deleted (with their acceptances) after the suite. */
const created: string[] = [];

type SysScope = Parameters<Parameters<TestApp['fixtures']['worker']['run']>[1]>[0];
const sys = <T>(fn: (scope: SysScope) => Promise<T>): Promise<T> => api.fixtures.worker.run({ actorType: 'system' }, fn);

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  api = await createTestApp({ host: 'api', infra });
  admin = await createTestApp({ host: 'admin-api', infra });
  auth = await createTestApp({ host: 'auth', infra });
  worker = await createTestWorker({ infra });
  a = (await staff(admin, 'platform_admin')).c;
  b = (await staff(admin, 'platform_admin')).c;
}, 60_000);

afterAll(async () => {
  if (created.length)
    await sys(async ({ db }) => {
      await db.deleteFrom('identity.policy_acceptances').where('policy_version_id', 'in', created).execute();
      await db.deleteFrom('identity.policy_versions').where('id', 'in', created).execute();
    });
  // The seeded 1.0 versions are in force again; the rule puts their stored status back to published.
  await worker?.get(PolicyVersionRule).run();
  await worker?.close();
  await auth?.close();
  await admin?.close();
  await api?.close();
  await infra?.close();
});

const label = (prefix: string) => `${prefix}-${uuidv7().slice(-8)}`;

function write(policyVersion: string, o: { body?: Json; fa?: boolean } = {}): Json {
  return {
    policy_version: policyVersion,
    title_translations: { en: 'Test policy', fa: 'سیاست آزمون' },
    body_translations: o.body ?? (o.fa === false ? { en: '# Text\n\nEnglish only.' } : { en: '# Text\n\nBody.', fa: '# متن\n\nبدنه.' }),
    reason: REASON,
  };
}

async function draft(key: string, policyVersion: string): Promise<Json> {
  const res = await a.post(`/v1/admin/policies/${key}/versions`, write(policyVersion));
  expect(res.status, res.text).toBe(201);
  created.push(res.body.id as string);
  return res.body;
}

/** Publish request by admin A, approved by admin B; returns the version after approval. */
async function publish(id: string, o: { effectiveAt?: string; reconsent?: boolean } = {}): Promise<Json> {
  const req = await a.post(`/v1/admin/policy-versions/${id}/publish`, {
    // A few seconds in the past is accepted (clock skew) and comes into force at approval.
    effective_at: o.effectiveAt ?? new Date(Date.now() - 5_000).toISOString(),
    requires_reconsent: o.reconsent ?? false,
    reason: REASON,
  });
  expect(req.status, req.text).toBe(202);
  const decided = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason: 'Legal approved' });
  expect(decided.status, decided.text).toBe(200);
  return (await a.get(`/v1/admin/policy-versions/${id}`)).body;
}

async function userClient(): Promise<{ user: TestUser; c: Client }> {
  const user = await api.fixtures.user();
  return { user, c: client(api, await api.fixtures.token(user)) };
}

const current = (c: Client, key: string, locale = 'en') => c.get(`/v1/policies/${key}`, { 'accept-language': locale });
const reconsentOf = async (c: Client) => {
  const me = await c.get('/v1/me');
  expect(me.status, me.text).toBe(200);
  return me.body.policy_reconsent as Json[];
};

describe('admin policy texts: drafts (BR-12, A-POL-01)', () => {
  it('lists the three documents with the seeded 1.0 in force; drafts need every locale, unique labels and If-Match', async () => {
    const list = await a.get('/v1/admin/policies');
    expect(list.status, list.text).toBe(200);
    const items = list.body.items as Json[];
    expect(items.map((d) => [d.policy_key, d.reconsent_mode, d.region_key])).toEqual([
      ['terms', 'blocking', 'ir-pilot'],
      ['privacy', 'blocking', 'ir-pilot'],
      ['community_guidelines', 'notice', 'ir-pilot'],
    ]);
    const terms = items[0]!.versions as Json[];
    expect(terms.find((v) => v.policy_version === '1.0')).toMatchObject({
      status: 'published',
      published_by_display: null,
      locales: ['en', 'fa'],
    });

    const noFa = await a.post('/v1/admin/policies/privacy/versions', write(label('p'), { fa: false }));
    expect(noFa.status).toBe(422);
    expect(noFa.body.errors).toContainEqual(expect.objectContaining({ pointer: '/body_translations/fa', code: 'required' }));
    expect((await a.post('/v1/admin/policies/cookies/versions', write(label('p')))).status).toBe(404);

    const p = label('p');
    const res = await a.post('/v1/admin/policies/privacy/versions', write(p));
    expect(res.status, res.text).toBe(201);
    created.push(res.body.id as string);
    expect(res.headers.location).toBe(`/v1/admin/policy-versions/${res.body.id}`);
    expect(res.body).toMatchObject({ policy_key: 'privacy', policy_version: p, status: 'draft', effective_at: null, version: 1 });
    expect(res.body.title).toEqual({ text: 'Test policy', locale: 'en' });
    expect((await a.post('/v1/admin/policies/privacy/versions', write(p))).body.code).toBe('DUPLICATE');

    const stale = await a.patch(
      `/v1/admin/policy-versions/${res.body.id}`,
      { change_summary_translations: { en: 'x', fa: 'ی' }, reason: REASON },
      7,
    );
    expect(stale.status).toBe(412);
    const upd = await a.patch(
      `/v1/admin/policy-versions/${res.body.id}`,
      { change_summary_translations: { en: 'Clearer wording', fa: 'نگارش روشن‌تر' }, reason: REASON },
      1,
    );
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body).toMatchObject({ version: 2, change_summary_translations: { en: 'Clearer wording', fa: 'نگارش روشن‌تر' } });
    // A draft is staff-only: the public read still serves 1.0.
    const { c } = await userClient();
    expect((await current(c, 'privacy')).body.policy_version).toBe('1.0');
  });

  it('accepts a whole legal text in both locales (body up to 256 KiB, SEC-IN-1) and refuses more', async () => {
    const para = 'CarPal connects you with independent repair businesses. '.repeat(10) + '\n\n';
    const big = { en: para.repeat(70), fa: 'کارپال شما را با تعمیرگاه‌های مستقل آشنا می‌کند. '.repeat(10).concat('\n\n').repeat(60) };
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(64 * 1024);
    const ok = await a.post('/v1/admin/policies/terms/versions', write(label('t'), { body: big }));
    expect(ok.status, ok.text).toBe(201);
    created.push(ok.body.id as string);
    const tooBig = await a.post('/v1/admin/policies/terms/versions', write(label('t'), { body: { en: 'x'.repeat(270_000), fa: 'ی' } }));
    expect(tooBig.status).toBe(413);
    // Other operations keep the 64 KiB default.
    const other = await a.post('/v1/admin/four-eyes/00000000-0000-7000-8000-000000000000/decision', {
      decision: 'reject',
      reason: 'x'.repeat(70 * 1024),
    });
    expect(other.status).toBe(413);
  });
});

describe('publishing (four-eyes, effective date, read-only once published)', () => {
  it('needs a second administrator; the published version is read-only and supersedes the previous one', async () => {
    const g = label('g');
    const d = await draft('community_guidelines', g);
    const past = await a.post(`/v1/admin/policy-versions/${d.id}/publish`, {
      effective_at: new Date(Date.now() - 3_600_000).toISOString(),
      requires_reconsent: false,
      reason: REASON,
    });
    expect(past.status).toBe(422);
    expect(past.body.errors).toEqual([{ pointer: '/effective_at', code: 'in_past' }]);

    const req = await a.post(`/v1/admin/policy-versions/${d.id}/publish`, {
      effective_at: new Date().toISOString(),
      requires_reconsent: false,
      reason: REASON,
    });
    expect(req.status, req.text).toBe(202);
    expect(req.body).toMatchObject({ op_id: 'admin.policy_version_publish', status: 'pending' });
    expect(req.body.summary).toContain(`Community Guidelines ${g} (ir-pilot)`);
    // Nothing changes before the second administrator approves.
    expect((await a.get(`/v1/admin/policy-versions/${d.id}`)).body.status).toBe('draft');
    const { c } = await userClient();
    expect((await current(c, 'community_guidelines')).body.policy_version).not.toBe(g);
    const self = await a.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason: 'Own change' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    const ok = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason: 'Legal approved' });
    expect(ok.status, ok.text).toBe(200);

    const v = (await a.get(`/v1/admin/policy-versions/${d.id}`)).body;
    expect(v).toMatchObject({ status: 'published', published_by_display: 'Test', approved_by_display: 'Test', requires_reconsent: false });
    expect(v.published_at).toEqual(expect.any(String));
    expect((await current(c, 'community_guidelines')).body).toMatchObject({ policy_version: g, reconsent_mode: 'notice', upcoming: null });
    const docs = (await a.get('/v1/admin/policies')).body.items as Json[];
    const versions = docs.find((x) => x.policy_key === 'community_guidelines')!.versions as Json[];
    expect(versions.find((x) => x.policy_version === '1.0')!.status).toBe('superseded');
    expect(versions[0]).toMatchObject({ id: d.id, status: 'published' });

    // Read-only: the API refuses edits and a second publish; the database refuses a direct change too.
    const edit = await a.patch(`/v1/admin/policy-versions/${d.id}`, { policy_version: label('x'), reason: REASON }, v.version as number);
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('INVALID_TRANSITION');
    const again = await a.post(`/v1/admin/policy-versions/${d.id}/publish`, {
      effective_at: new Date(Date.now() + 60_000).toISOString(),
      requires_reconsent: true,
      reason: REASON,
    });
    expect(again.status).toBe(409);
    await expect(
      sys(({ db }) =>
        db
          .updateTable('identity.policy_versions')
          .set({ body_translations: JSON.stringify({ en: 'changed', fa: 'تغییر' }) })
          .where('id', '=', d.id as string)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    const audit = await sys(({ db }) =>
      db
        .selectFrom('analytics.audit_logs')
        .select(['action', 'reason'])
        .where('entity_id', '=', d.id as string)
        .orderBy('created_at')
        .execute(),
    );
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['policy.version_created', 'policy.version_published']));
  });

  it('a scheduled version is announced, blocks another schedule, and comes into force at its effective date', async () => {
    const { c } = await userClient();
    const before = (await current(c, 'community_guidelines')).body.policy_version as string;
    const s = label('s');
    const d = await draft('community_guidelines', s);
    const v = await publish(d.id as string, { effectiveAt: new Date(Date.now() + 2_500).toISOString() });
    expect(v.status).toBe('scheduled');
    const now = (await current(c, 'community_guidelines')).body;
    expect(now.policy_version).toBe(before);
    expect(now.upcoming).toMatchObject({ policy_version: s, requires_reconsent: false });

    const other = await draft('community_guidelines', label('o'));
    const blocked = await a.post(`/v1/admin/policy-versions/${other.id}/publish`, {
      effective_at: new Date(Date.now() + 86_400_000).toISOString(),
      requires_reconsent: false,
      reason: REASON,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVALID_TRANSITION');

    await new Promise((r) => setTimeout(r, 3_000));
    // Reads decide by the clock, before the worker has run.
    expect((await current(c, 'community_guidelines')).body).toMatchObject({ policy_version: s, upcoming: null });
    expect((await a.get(`/v1/admin/policy-versions/${d.id}`)).body.status).toBe('published');
    const stored = async () =>
      sys(({ db }) =>
        db
          .selectFrom('identity.policy_versions')
          .select('status')
          .where('id', '=', d.id as string)
          .executeTakeFirstOrThrow(),
      );
    expect((await stored()).status).toBe('scheduled');
    expect(await worker.get(PolicyVersionRule).run()).toBeGreaterThanOrEqual(2);
    expect((await stored()).status).toBe('published');
  });
});

describe('policy.current (public text in force)', () => {
  it('returns the version in force in the requested locale (then en), cacheable only for anonymous callers', async () => {
    const { c } = await userClient();
    const fa = await current(c, 'terms', 'fa');
    expect(fa.status, fa.text).toBe(200);
    expect(fa.body).toMatchObject({ policy_key: 'terms', reconsent_mode: 'blocking', requires_reconsent: false });
    expect(fa.body.title.locale).toBe('fa');
    expect(fa.body.body.locale).toBe('fa');
    expect(fa.headers['content-language']).toBe('fa');
    expect((await current(c, 'terms', 'de')).body.title.locale).toBe('en');
    expect(fa.headers['cache-control']).toBe('no-store'); // signed-in caller
    expect((await current(c, 'cookies')).status).toBe(404);
  });
});

describe('re-consent and acceptance (Me.policy_reconsent, policy.accept, auth.signup)', () => {
  it('flags older accounts for a notice policy, every account for a blocking one, and clears the flag on acceptance', async () => {
    const old = await userClient();
    expect(await reconsentOf(old.c)).toEqual([]);

    // Community guidelines (notice): only accounts older than the new version are asked.
    await new Promise((r) => setTimeout(r, 20));
    const g = label('g');
    await publish((await draft('community_guidelines', g)).id as string, { reconsent: true });
    const young = await userClient();
    expect(await reconsentOf(old.c)).toEqual([
      { policy_key: 'community_guidelines', policy_version: g, effective_at: expect.any(String), mode: 'notice' },
    ]);
    expect(await reconsentOf(young.c)).toEqual([]);
    const outdated = await old.c.post('/v1/me/policy-acceptances', { policy_key: 'community_guidelines', policy_version: '1.0' });
    expect(outdated.status).toBe(409);
    expect(outdated.body.code).toBe('POLICY_VERSION_OUTDATED');
    const acc = await old.c.post('/v1/me/policy-acceptances', { policy_key: 'community_guidelines', policy_version: g });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.body).toMatchObject({ acceptance: { policy_key: 'community_guidelines', policy_version: g }, policy_reconsent: [] });
    const twice = await old.c.post('/v1/me/policy-acceptances', { policy_key: 'community_guidelines', policy_version: g });
    expect(twice.body.acceptance.accepted_at).toBe(acc.body.acceptance.accepted_at);

    // Terms (blocking): every account that has not accepted the new version is asked, whatever its age.
    const t = label('t');
    await publish((await draft('terms', t)).id as string, { reconsent: true });
    for (const u of [old, young])
      expect(await reconsentOf(u.c)).toEqual([
        { policy_key: 'terms', policy_version: t, effective_at: expect.any(String), mode: 'blocking' },
      ]);
    const ok = await old.c.post('/v1/me/policy-acceptances', { policy_key: 'terms', policy_version: t });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.policy_reconsent).toEqual([]);
    expect(await reconsentOf(young.c)).toHaveLength(1);
    const account = await sys(({ db }) =>
      db
        .selectFrom('identity.user_accounts')
        .select(['terms_version', 'terms_accepted_at'])
        .where('id', '=', old.user.id)
        .executeTakeFirstOrThrow(),
    );
    expect(account.terms_version).toBe(t);
    expect(account.terms_accepted_at.toISOString()).toBe(ok.body.acceptance.accepted_at);

    // A later version without re-consent does not ask again; the prompt then names the version in force.
    const t2 = label('t');
    await publish((await draft('terms', t2)).id as string, { reconsent: false });
    expect(await reconsentOf(old.c)).toEqual([]);
    expect(await reconsentOf(young.c)).toEqual([
      { policy_key: 'terms', policy_version: t2, effective_at: expect.any(String), mode: 'blocking' },
    ]);

    // The DSR export lists the acceptances.
    const sections = await sys(async (scope) => identityPersonalData.export!(scope, old.user.id));
    const rows = sections.find((s) => s.section === 'policy_acceptances')!.records.map((r) => r.fields);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policy_key: 'terms', policy_version: t, source: 'prompt', region_key: 'ir-pilot' }),
        expect.objectContaining({ policy_key: 'community_guidelines', policy_version: g, source: 'prompt' }),
      ]),
    );
  });

  it('sign-up needs the terms and privacy versions in force and records their acceptance', async () => {
    const terms = (await sys(({ db }) =>
      db
        .selectFrom('identity.policy_versions as v')
        .innerJoin('identity.policy_documents as d', 'd.id', 'v.document_id')
        .select('v.policy_version')
        .where('d.policy_key', '=', 'terms')
        .where('d.region_key', '=', 'ir-pilot')
        .where('v.status', '<>', 'draft')
        .orderBy('v.effective_at', 'desc')
        .executeTakeFirstOrThrow(),
    )) as { policy_version: string };
    expect(terms.policy_version).not.toBe('1.0'); // the previous test published newer terms

    const signup = async (email: string, termsVersion: string) => {
      const p = { challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url') };
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: 'cp-mobile',
        redirect_uri: 'https://carpals.ir/oauth/callback',
        scope: 'openid offline_access',
        state: randomBytes(16).toString('base64url'),
        nonce: randomBytes(16).toString('base64url'),
        code_challenge: p.challenge,
        code_challenge_method: 'S256',
      });
      const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
      expect(start.status).toBe(302);
      const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
      const cookie = (start.headers['set-cookie'] ?? '').split(';')[0]!;
      return auth.request<Json>({
        method: 'POST',
        path: '/v1/auth/signup',
        headers: { cookie, 'idempotency-key': uuidv7() },
        body: {
          interaction_id: id,
          full_name: 'Policy Tester',
          email,
          password: 'correct horse battery staple',
          locale: 'en',
          terms_version: termsVersion,
          privacy_policy_version: '1.0',
        },
      });
    };
    const stale = await signup(`s15-${uuidv7()}@test.carpal.app`, '1.0');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('POLICY_VERSION_OUTDATED');

    const email = `s15-${uuidv7()}@test.carpal.app`;
    const res = await signup(email, terms.policy_version);
    expect(res.status, res.text).toBe(202);
    const rows = await sys(({ db }) =>
      db
        .selectFrom('identity.policy_acceptances as a')
        .innerJoin('identity.user_accounts as u', 'u.id', 'a.user_id')
        .innerJoin('identity.policy_versions as v', 'v.id', 'a.policy_version_id')
        .innerJoin('identity.policy_documents as d', 'd.id', 'v.document_id')
        .select(['d.policy_key', 'v.policy_version', 'a.source'])
        .where('u.email', '=', email)
        .orderBy('d.policy_key')
        .execute(),
    );
    expect(rows).toEqual([
      { policy_key: 'privacy', policy_version: '1.0', source: 'signup' },
      { policy_key: 'terms', policy_version: terms.policy_version, source: 'signup' },
    ]);
  });
});
