// S26a (contract 1.5.0; backend/BR-update-plan.json S26a): pilot access and messages.
//   T1 staff seeded with an initial password change it at the first console sign-in, after the emailed code and before
//      any key or token; expiry, reissue, five wrong codes, an account that already has a key.
//   T3 the dispatcher's retry classes (permanent, held) and the SMS status sweep against the mock provider.
//   T4 the default rate, set_today / age_hours, the morning reminder once per day and none once the rate is set.
//   T5 the consent-text seed (13 drafts, a second run creates none, published versions untouched).
//   Health and config: SystemHealth providers, ClientConfig.auth.phone_signin_available.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { SendError } from '#libs/infra/index.js';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import {
  configuredDefaults,
  ensureDefaultRates,
  ExchangeRateReminderRule,
  regionClock,
} from '#modules/admin/application/exchange-rate-daily.js';
import { AuthServer } from '#modules/identity/application/auth-server.js';
import { NotificationDispatcher } from '#modules/notification/application/dispatcher.js';
import { route } from '#modules/notification/domain/routing.js';
import { parseConsentTexts, seedConsentTexts } from '#tools/db/consent-texts.js';
import { bootstrapStaff, parseSpec, reissueInitialPassword, type StaffDeps } from '#tools/db/staff.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoDir } from '#tools/db/config.js';
import { Harness, sql, type Actor, type Json } from './contract/harness.js';
import type { TestApp } from './test-app.js';

const ADMIN = 'cp-web-admin/1.0.0 (web 1.0)';
const ISSUER = 'https://id.carpals.ir';
const REDIRECT = 'https://admin.carpals.ir/bff/oauth/callback';
const ORIGIN = 'https://admin.carpals.ir';
const INITIAL = 'Initial-Pass-2026';
const NEW_PASSWORD = 'a much longer staff passphrase 26';

let h: Harness;
let adm: Actor;

beforeAll(async () => {
  h = await Harness.start();
  adm = await h.staff('platform_admin');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** One cp-web-admin interaction (code + PKCE) and its hosted sign-in calls. */
async function adminSignin(auth: TestApp) {
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cp-web-admin',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    acr_values: 'aal3',
  });
  const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
  expect(start.status, start.text).toBe(302);
  expect(start.headers.location).toMatch(new RegExp(`^${ISSUER}/signin\\?interaction_id=`));
  const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
  const cookie = (start.headers['set-cookie'] ?? '').split(';')[0]!;
  const post = (path: string, body: Json) =>
    auth.request<Json>({
      method: 'POST',
      path,
      body: { interaction_id: id, ...body },
      headers: { cookie, 'idempotency-key': uuidv7() },
      client: ADMIN,
    });
  return { id, post };
}

describe('T1: initial staff password changed at the first console sign-in (DQ-25)', () => {
  let deps: StaffDeps;
  const tag = uuidv7().slice(-12);
  const email = (n: string) => `s26a-${n}-${tag}@test.carpal.app`;
  const lastCode = (to: string) => h.auth.mail(to, 'identity.otp_code').at(-1)!.variables.code!;
  const method = (address: string) =>
    h.sys((db) =>
      db
        .selectFrom('identity.authentication_methods as m')
        .innerJoin('identity.user_accounts as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id', 'm.password_change_required', 'm.initial_password_expires_at'])
        .where('u.email', '=', address)
        .where('m.method_type', '=', 'email_password')
        .executeTakeFirstOrThrow(),
    );

  beforeAll(async () => {
    deps = { tx: h.auth.fixtures.worker, crypto: new CryptoServices(h.auth.config.secrets.master), env: 'dev', initialPassword: INITIAL };
    const created = await bootstrapStaff(
      deps,
      parseSpec(
        ['a', 'b', 'c', 'd'].map((n) => ({ email: email(n), name: `Admin ${n}`, roles: ['ADM'] })),
        'dev',
      ),
    );
    // The owner's initial password is set but never handed back; the flag and the 7-day expiry are on.
    expect(created.map((r) => [r.status, r.passwordSource, r.password])).toEqual(Array(4).fill(['created', 'initial', undefined]));
    const m = await method(email('a'));
    expect(m.password_change_required).toBe(true);
    expect(m.initial_password_expires_at!.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it('password → emailed code + new password → enrolment with the same code → aal3; nothing else opens before the change', async () => {
    const s = await adminSignin(h.auth);
    expect((await s.post('/v1/auth/signin', { email: email('a'), password: INITIAL })).body).toEqual({ next: 'change_password' });
    const code = lastCode(email('a'));
    // Enrolment and the second factor stay closed until the password is changed.
    expect((await s.post('/v1/auth/passkey-enrolment/options', { code })).status).toBe(401);
    expect((await s.post('/v1/auth/webauthn/options', { purpose: 'mfa' })).status).toBe(401);
    // A wrong code, a short password, the initial password again.
    expect(
      (await s.post('/v1/auth/password/initial', { code: code === '000000' ? '111111' : '000000', new_password: NEW_PASSWORD })).body.code,
    ).toBe('CODE_INVALID');
    const short = await s.post('/v1/auth/password/initial', { code, new_password: 'short1' });
    expect(short.status).toBe(422);
    const same = await s.post('/v1/auth/password/initial', { code, new_password: INITIAL });
    expect(same.status, same.text).toBe(422);
    expect(same.body.errors).toEqual([{ pointer: '/new_password', code: 'not_unique' }]);
    expect((await method(email('a'))).password_change_required).toBe(true);

    const changed = await s.post('/v1/auth/password/initial', { code, new_password: NEW_PASSWORD });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body).toEqual({ next: 'enrol_passkey' });
    const m = await method(email('a'));
    expect([m.password_change_required, m.initial_password_expires_at]).toEqual([false, null]);
    expect(h.auth.mail(email('a'), 'identity.password_changed')).toHaveLength(1);
    const audit = await h.q<{ action: string }>(
      sql`SELECT action FROM analytics.audit_logs WHERE entity_id = ${m.user_id}::uuid AND action = 'staff.initial_password_changed'`,
    );
    expect(audit).toHaveLength(1);
    // Once only: the step is gone.
    expect((await s.post('/v1/auth/password/initial', { code, new_password: `${NEW_PASSWORD}!` })).status).toBe(401);

    // The same code opens the enrolment; the new key proves itself at once.
    const key = new SoftAuthenticator('carpals.ir', ORIGIN);
    const options = await s.post('/v1/auth/passkey-enrolment/options', { code });
    expect(options.status, options.text).toBe(200);
    const enrolled = await s.post('/v1/auth/passkey-enrolment', { attestation: key.register(options.body) });
    expect(enrolled.body).toMatchObject({ next: 'mfa', mfa_methods: ['webauthn'] });
    const o = await s.post('/v1/auth/webauthn/options', { purpose: 'mfa' });
    expect((await s.post('/v1/auth/mfa/verify', { method: 'webauthn', assertion: key.assert(o.body) })).body).toEqual({ next: 'complete' });

    // The initial password no longer signs in; the new one goes straight to the key.
    const again = await adminSignin(h.auth);
    expect((await again.post('/v1/auth/signin', { email: email('a'), password: INITIAL })).status).toBe(401);
    expect((await again.post('/v1/auth/signin', { email: email('a'), password: NEW_PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    // Reissue is refused for an account that chose its own password.
    await expect(reissueInitialPassword(deps, email('a'))).rejects.toThrow(/already chose/);

    // An account that already has a key and still has the flag: the change comes first, then its key.
    await h.sys((db) =>
      db.updateTable('identity.authentication_methods').set({ password_change_required: true }).where('id', '=', m.id).execute(),
    );
    const flagged = await adminSignin(h.auth);
    expect((await flagged.post('/v1/auth/signin', { email: email('a'), password: NEW_PASSWORD })).body).toEqual({
      next: 'change_password',
    });
    const after = await flagged.post('/v1/auth/password/initial', { code: lastCode(email('a')), new_password: `${NEW_PASSWORD} again` });
    expect(after.body).toEqual({ next: 'mfa', mfa_methods: ['webauthn'] });
  });

  it('no token is issued while the flag is set (any client)', async () => {
    const m = await method(email('b'));
    const auth = h.auth.app.get(AuthServer, { strict: false });
    const refused = await h.auth.fixtures.worker
      .run({ actorType: 'system' }, (scope) =>
        auth.issueForSession(scope, {
          userId: m.user_id,
          clientId: 'cp-web-consumer',
          acr: 'aal1',
          authTime: Math.floor(Date.now() / 1000),
          scope: 'openid',
          mfaEnrolled: false,
          deviceLabel: 'test',
        }),
      )
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400, body: { error: 'invalid_grant', error_description: 'password change required' } });
  });

  it('five wrong codes end the interaction', async () => {
    const s = await adminSignin(h.auth);
    expect((await s.post('/v1/auth/signin', { email: email('c'), password: INITIAL })).body).toEqual({ next: 'change_password' });
    const right = lastCode(email('c'));
    const wrong = right === '999999' ? '888888' : '999999';
    for (let n = 0; n < 5; n++)
      expect((await s.post('/v1/auth/password/initial', { code: wrong, new_password: NEW_PASSWORD })).body.code).toBe('CODE_INVALID');
    const gone = await s.post('/v1/auth/password/initial', { code: right, new_password: NEW_PASSWORD });
    expect(gone.status).toBe(410);
    expect((await method(email('c'))).password_change_required).toBe(true);
  });

  it('after 7 days the initial password is refused generically; --reissue gives 7 more days', async () => {
    const m = await method(email('d'));
    await h.sys((db) =>
      db
        .updateTable('identity.authentication_methods')
        .set({ initial_password_expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', m.id)
        .execute(),
    );
    const s = await adminSignin(h.auth);
    const refused = await s.post('/v1/auth/signin', { email: email('d'), password: INITIAL });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('INVALID_CREDENTIALS');

    const r = await reissueInitialPassword({ ...deps, initialPassword: null }, email('d'));
    expect(r.passwordSource).toBe('generated');
    expect(r.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const again = await adminSignin(h.auth);
    expect((await again.post('/v1/auth/signin', { email: email('d'), password: r.password! })).body).toEqual({ next: 'change_password' });
    const audit = await h.q<{ action: string }>(
      sql`SELECT action FROM analytics.audit_logs WHERE entity_id = ${m.user_id}::uuid AND action = 'staff.initial_password_reissued'`,
    );
    expect(audit).toHaveLength(1);
  });
});

describe('T3: retry classes and the SMS status sweep', () => {
  async function smsNotification(o: { status: string; providerMessageId?: string; sentAgoMs?: number }) {
    const user = await h.auth.fixtures.user();
    const phone = `+98912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    return h.sys(async (db) => {
      await db.updateTable('identity.user_accounts').set({ phone, phone_verified_at: new Date() }).where('id', '=', user.id).execute();
      const n = await db
        .insertInto('notification.notifications')
        .values({
          recipient_user_id: user.id,
          event_type: 'appointment_reminder',
          category: 'appointments',
          priority: 'normal',
          template_key: 'appointment.reminder',
          template_params: '{}',
          locale: 'en',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const d = await db
        .insertInto('notification.notification_deliveries')
        .values({
          notification_id: n.id,
          channel: 'sms',
          status: o.status,
          ...(o.providerMessageId
            ? { provider: 'mock', provider_message_id: o.providerMessageId, sent_at: new Date(Date.now() - (o.sentAgoMs ?? 600_000)) }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { notificationId: n.id, deliveryId: d.id, phone };
    });
  }
  const delivery = (id: string) =>
    h.sys((db) => db.selectFrom('notification.notification_deliveries').selectAll().where('id', '=', id).executeTakeFirstOrThrow());

  it('the sweep records delivered and failed from the provider; a message older than 24 hours is not asked', async () => {
    const old = String(Date.now() - 3_600_000).padStart(13, '0');
    const ok = await smsNotification({ status: 'sent', providerMessageId: `mock-${old}-${'a'.repeat(12)}` });
    const bad = await smsNotification({ status: 'sent', providerMessageId: `mock-${old}-${'b'.repeat(12)}-u` });
    const stale = await smsNotification({ status: 'sent', providerMessageId: `mock-${old}-${'c'.repeat(12)}`, sentAgoMs: 25 * 3_600_000 });
    const dispatcher = h.worker.get(NotificationDispatcher, { strict: false });
    expect(await dispatcher.pollSmsStatus(new Date(Date.now() + 120_000))).toBeGreaterThanOrEqual(2);
    expect(await delivery(ok.deliveryId)).toMatchObject({ status: 'delivered' });
    expect((await delivery(ok.deliveryId)).delivered_at).not.toBeNull();
    expect(await delivery(bad.deliveryId)).toMatchObject({ status: 'failed', attempt_count: 3 });
    expect(await delivery(stale.deliveryId)).toMatchObject({ status: 'sent' });
  });

  it('a permanent refusal is not retried; a held message waits without spending an attempt; a success keeps the provider id', async () => {
    const dispatcher = h.worker.get(NotificationDispatcher, { strict: false });
    const sms = h.infra.sms;
    const send = sms.send.bind(sms);
    try {
      const perm = await smsNotification({ status: 'queued' });
      sms.send = () => Promise.reject(new SendError('number refused', true));
      await dispatcher.deliver([perm.notificationId]);
      expect(await delivery(perm.deliveryId)).toMatchObject({ status: 'failed', attempt_count: 3, provider: 'mock' });

      const held = await smsNotification({ status: 'queued' });
      const until = new Date(Date.now() + 30 * 60_000);
      sms.send = () => Promise.reject(new SendError('hourly cap', false, until));
      await dispatcher.deliver([held.notificationId]);
      const d = await delivery(held.deliveryId);
      expect(d).toMatchObject({ status: 'queued', attempt_count: 0 });
      expect(d.not_before!.getTime()).toBe(until.getTime());

      sms.send = send;
      const sent = await smsNotification({ status: 'queued' });
      await dispatcher.deliver([sent.notificationId]);
      const s = await delivery(sent.deliveryId);
      expect(s).toMatchObject({ status: 'sent', provider: 'mock' });
      expect(s.provider_message_id).toMatch(/^mock-\d{13}-[0-9a-f]{12}$/);
    } finally {
      sms.send = send;
    }
  });

  it('admin.system_health names the SMS provider and the mail transport; config.client hides phone sign-in only outside dev', async () => {
    const health = await adm.c.get('/v1/admin/system-health');
    expect(health.status, health.text).toBe(200);
    expect(health.body).toMatchObject({ sms_provider: 'mock', sms_simulated: true, mail_transport: 'file' });
    const config = await h.api.request<Json>({ path: '/v1/config/client', token: await h.auth.fixtures.anonymousToken() });
    expect(config.status, config.text).toBe(200);
    expect(config.body.auth).toEqual({ phone_signin_available: true }); // dev: the code is in outbox-sms.jsonl
  });
});

describe('T4: the daily exchange rate', () => {
  const irr = () =>
    h.sys((db) =>
      db
        .selectFrom('admin.exchange_rates')
        .select(['id', 'per_usd', 'updated_at', 'version'])
        .where('currency', '=', 'IRR')
        .executeTakeFirstOrThrow(),
    );

  it('a missing display-currency rate is created from the setting; an existing one is left alone', async () => {
    expect(configuredDefaults(h.auth.config)).toEqual({ IRR: '1000000' });
    const before = await irr();
    expect(await ensureDefaultRates(h.auth.fixtures.worker, { IRR: '42' }, ['IRR'])).toEqual([]);
    expect(String((await irr()).per_usd)).toBe(String(before.per_usd));
    // XTS (the ISO test code) stands in for a missing IRR row: the shared database keeps its IRR rate.
    await h.q(sql`DELETE FROM admin.exchange_rates WHERE currency = 'XTS'`);
    try {
      expect(await ensureDefaultRates(h.auth.fixtures.worker, { XTS: '1000000' }, ['XTS', 'USD'])).toEqual(['XTS']);
      const row = await h.sys((db) =>
        db.selectFrom('admin.exchange_rates').select(['per_usd', 'reason', 'id']).where('currency', '=', 'XTS').executeTakeFirstOrThrow(),
      );
      expect([Number(row.per_usd), row.reason]).toEqual([1000000, 'default from configuration']);
      expect(await ensureDefaultRates(h.auth.fixtures.worker, { XTS: '5' }, ['XTS'])).toEqual([]);
      const audit = await h.q<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM analytics.audit_logs WHERE entity_id = ${row.id}::uuid AND action = 'admin.exchange_rate_defaulted'`,
      );
      expect(audit[0]!.n).toBe(1);
    } finally {
      await h.q(sql`DELETE FROM admin.exchange_rates WHERE currency = 'XTS'`);
    }
  });

  it('ExchangeRate carries set_today and age_hours', async () => {
    const list = await adm.c.get('/v1/admin/exchange-rates');
    expect(list.status, list.text).toBe(200);
    const row = (list.body.items as Json[]).find((r) => r.currency === 'IRR')!;
    expect(typeof row.set_today).toBe('boolean');
    expect(row.age_hours).toBeGreaterThanOrEqual(0);
  });

  it('one morning reminder per day while the rate is not set that day, none once it is set; routed to administrators', async () => {
    const rule = h.worker.get(ExchangeRateReminderRule, { strict: false });
    const row = await irr();
    // A day far after the last change (no earlier run of this test reminded on it), 10:00 in Tehran.
    const day = regionClock(new Date(row.updated_at.getTime() + (400 + Math.floor(Math.random() * 20_000)) * 86_400_000)).day;
    const morning = new Date(`${day}T10:00:00+03:30`);
    const early = new Date(`${day}T08:00:00+03:30`);
    expect(await rule.run(early)).toBe(0); // before the reminder hour
    expect(await rule.run(morning)).toBe(1);
    expect(await rule.run(new Date(morning.getTime() + 3_600_000))).toBe(0); // once per day
    // The rate row itself is untouched (its updated_at and If-Match version belong to the rate).
    const after = await irr();
    expect([after.updated_at.getTime(), after.version]).toEqual([row.updated_at.getTime(), row.version]);
    const events = await h.q<{ payload: Json }>(
      sql`SELECT payload FROM core.domain_event_outbox WHERE event_type = 'exchange_rate.reminder_due' AND aggregate_id = ${row.id}::uuid
          ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(events[0]!.payload).toMatchObject({ currency: 'IRR', day });
    // The rate set that day: no reminder (same day, after the reminder hour).
    const setDay = regionClock(row.updated_at).day;
    expect(await rule.run(new Date(Math.max(row.updated_at.getTime() + 60_000, new Date(`${setDay}T09:30:00+03:30`).getTime())))).toBe(0);

    const [intent] = route({
      type: 'exchange_rate.reminder_due',
      aggregateType: 'exchange_rate',
      aggregateId: row.id,
      payload: { currency: 'IRR', per_usd: '1000000', day },
    });
    expect(intent).toMatchObject({
      audience: { kind: 'staff', roles: ['platform_admin'] },
      event_type: 'exchange_rate_reminder',
      template_key: 'staff.exchange_rate_reminder',
      channels: ['in_app', 'email'],
      priority: 'normal',
    });
  });
});

describe('T5: consent-text seed', () => {
  it('creates the 13 texts as drafts once; a second run creates none; published versions are untouched', async () => {
    const region = `s26a-${uuidv7().slice(-8)}`;
    const file = JSON.parse(readFileSync(join(repoDir, 'database', 'seeds', 'consent-texts.template.json'), 'utf8')) as unknown;
    const items = parseConsentTexts(file, { env: 'dev', allowPlaceholders: true });
    const first = await seedConsentTexts(h.auth.fixtures.worker, region, items);
    expect(first.filter((r) => r.status === 'created')).toHaveLength(13);
    const drafts = await h.q<{ status: string; n: number }>(
      sql`SELECT v.status, count(*)::int AS n FROM identity.policy_versions v JOIN identity.policy_documents d ON d.id = v.document_id
          WHERE d.region_key = ${region} GROUP BY v.status`,
    );
    expect(drafts).toEqual([{ status: 'draft', n: 13 }]);
    const second = await seedConsentTexts(h.auth.fixtures.worker, region, items);
    expect(second.every((r) => r.status === 'exists' && r.existing_status === 'draft')).toBe(true);
    const audit = await h.q<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM analytics.audit_logs WHERE action = 'policy.version_created'
          AND new_state_summary LIKE ${`%"region_key":"${region}"%`}`,
    );
    expect(audit[0]!.n).toBe(13);
    await h.q(
      sql`DELETE FROM identity.policy_versions WHERE document_id IN (SELECT id FROM identity.policy_documents WHERE region_key = ${region})`,
    );
    await h.q(sql`DELETE FROM identity.policy_documents WHERE region_key = ${region}`);
  });
});
