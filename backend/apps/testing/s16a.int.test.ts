// S16a (contract 1.4.0; backend/BR-update-plan.json S16a, admin console BR-19, owner decisions DQ-04 and DQ-11): staff
// recovery codes (issued with the first passkey, shown once, keyed hashes only, single use, a new set voids the old
// one), the caller's own keys on the admin plane (list, backup key, remove, never the last; fresh aal3 within 5
// minutes; synced passkeys refused), the break-glass reset from the server shell, and disable ending the member's
// pending four-eyes requests.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import { BREAK_GLASS_EVENT, StaffBreakGlassConsumer, StaffRecoveryCodes } from '#modules/identity/application/staff-security.js';
import { breakGlassStaff } from '#tools/db/staff.js';
import type { Json } from './s4-support.js';
import { REASON, staff, staffApi, type StaffApi } from './s8-support.js';
import type { INestApplicationContext } from '@nestjs/common';
import { createTestApp, createTestWorker, testConfig, testLogger, type TestApp } from './test-app.js';

const ADMIN = 'cp-web-admin/1.0.0 (web 1.0)';
const REDIRECT = 'https://admin.carpals.ir/bff/oauth/callback';
const ORIGIN = 'https://admin.carpals.ir';
const PASSWORD = 'correct horse battery staple';
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

let infra: Infra;
let auth: TestApp;
let admin: TestApp;
let crypto: CryptoServices;
let worker: INestApplicationContext;

type SysScope = Parameters<Parameters<TestApp['fixtures']['worker']['run']>[1]>[0];
const sys = <T>(fn: (scope: SysScope) => Promise<T>): Promise<T> => admin.fixtures.worker.run({ actorType: 'system' }, fn);

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  auth = await createTestApp({ host: 'auth', infra });
  admin = await createTestApp({ host: 'admin-api', infra });
  crypto = new CryptoServices(config.secrets.master);
  worker = await createTestWorker({ infra });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await auth?.close();
  await infra?.close();
});

/** One cp-web-admin authorization and the hosted sign-in calls of its interaction (lite mode: no PoW). */
async function adminSignin() {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cp-web-admin',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
    code_challenge_method: 'S256',
    acr_values: 'aal3',
  });
  const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
  expect(start.status, start.text).toBe(302);
  const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
  const cookie = (start.headers['set-cookie'] ?? '').split(';')[0]!;
  return (path: string, body: Json) =>
    auth.request<Json>({
      method: 'POST',
      path,
      body: { interaction_id: id, ...body },
      headers: { cookie, 'idempotency-key': uuidv7() },
      client: ADMIN,
    });
}

/** Password → enrol_passkey → emailed code → register `key`: the auth.passkey_enrol answer. */
async function enrol(user: TestUser, key: SoftAuthenticator) {
  const post = await adminSignin();
  expect((await post('/v1/auth/signin', { email: user.email, password: PASSWORD })).body).toEqual({ next: 'enrol_passkey' });
  const code = auth.mail(user.email, 'identity.otp_code').at(-1)!.variables.code!;
  const options = await post('/v1/auth/passkey-enrolment/options', { code });
  expect(options.status, options.text).toBe(200);
  return post('/v1/auth/passkey-enrolment', { attestation: key.register(options.body) });
}

const openCodes = (userId: string) =>
  sys((s) =>
    s.db
      .selectFrom('identity.staff_recovery_codes')
      .selectAll()
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute(),
  );

/** A staff member with one device-bound key, registered through the admin plane. */
async function staffWithKey(...roles: string[]): Promise<{ user: TestUser; c: StaffApi; key: SoftAuthenticator }> {
  const s = await staff(admin, ...(roles.length ? roles : ['platform_moderator']));
  const key = new SoftAuthenticator('carpals.ir', ORIGIN);
  const options = await s.c.post('/v1/admin/me/passkeys/options', { label: 'Office key' });
  expect(options.status, options.text).toBe(200);
  const res = await s.c.post('/v1/admin/me/passkeys', { attestation: key.register(options.body) });
  expect(res.status, res.text).toBe(201);
  return { ...s, key };
}

describe('S16a recovery codes (BR-19, DQ-04)', () => {
  it('the first passkey enrolment returns ten codes once; only keyed hashes are stored; staff_me counts them', async () => {
    const user = await auth.fixtures.staff('platform_admin');
    await auth.fixtures.withPassword(user, PASSWORD);
    const enrolled = await enrol(user, new SoftAuthenticator('carpals.ir', ORIGIN));
    expect(enrolled.status, enrolled.text).toBe(200);
    expect(enrolled.body).toMatchObject({ next: 'mfa', mfa_methods: ['webauthn'] });
    const codes = enrolled.body.recovery_codes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(CODE);

    const rows = await openCodes(user.id);
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.set_id)).size).toBe(1);
    const stored = JSON.stringify(rows);
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(c.replace(/-/g, ''));
    }
    for (const r of rows) expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);

    const me = await staffApi(admin, await admin.fixtures.token(user, { staff: true })).get('/v1/admin/me');
    expect(me.status, me.text).toBe(200);
    expect(me.body.recovery_codes_remaining).toBe(10);
  });

  it('existing staff without codes get 0, so the console asks them to create a set', async () => {
    const { c } = await staff(admin, 'platform_support');
    expect((await c.get('/v1/admin/me')).body.recovery_codes_remaining).toBe(0);
  });

  it('a code is single use, read the Crockford way, bound to its account, and void after a new set', async () => {
    const svc = admin.app.get(StaffRecoveryCodes);
    const a = await admin.fixtures.staff('platform_moderator');
    const b = await admin.fixtures.staff('platform_moderator');
    const codes = await sys((s) => svc.issue(s, a.id));
    const typed = codes[0]!.toLowerCase().replace(/-/g, ' ');
    expect(await sys((s) => svc.use(s, b.id, codes[0]!))).toBe(false);
    expect(await sys((s) => svc.use(s, a.id, typed))).toBe(true);
    expect(await sys((s) => svc.use(s, a.id, codes[0]!))).toBe(false);
    expect(await sys((s) => svc.use(s, a.id, 'not a code'))).toBe(false);
    expect(await sys((s) => svc.remaining(s, a.id))).toBe(9);
    const fresh = await sys((s) => svc.issue(s, a.id));
    expect(await sys((s) => svc.use(s, a.id, codes[1]!))).toBe(false);
    expect(await sys((s) => svc.use(s, a.id, fresh[1]!))).toBe(true);
  });

  it('regenerate needs a fresh aal3, voids the old set, is audited without the codes and tells the account', async () => {
    const user = await admin.fixtures.staff('platform_community_reviewer');
    const stale = staffApi(admin, await admin.fixtures.token(user, { staff: true, authTime: Math.floor(Date.now() / 1000) - 400 }));
    const refused = await stale.post('/v1/admin/me/recovery-codes');
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('STEP_UP_REQUIRED');
    expect(refused.headers['www-authenticate']).toContain('max_age=300');

    const c = staffApi(admin, await admin.fixtures.token(user, { staff: true }));
    const first = await c.post('/v1/admin/me/recovery-codes');
    expect(first.status, first.text).toBe(200);
    const second = await c.post('/v1/admin/me/recovery-codes');
    expect(second.status, second.text).toBe(200);
    const codes = second.body.recovery_codes as string[];
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(CODE);
    expect(codes).not.toEqual(first.body.recovery_codes);
    expect((await c.get('/v1/admin/me')).body.recovery_codes_remaining).toBe(10);
    const revoked = await sys((s) =>
      s.db
        .selectFrom('identity.staff_recovery_codes')
        .select('id')
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is not', null)
        .execute(),
    );
    expect(revoked).toHaveLength(10);
    const audit = await sys((s) =>
      s.db
        .selectFrom('analytics.audit_logs')
        .selectAll()
        .where('entity_id', '=', user.id)
        .where('action', '=', 'staff.recovery_codes_regenerated')
        .execute(),
    );
    expect(audit).toHaveLength(2);
    const text = JSON.stringify(audit);
    for (const code of [...codes, ...(first.body.recovery_codes as string[])]) expect(text).not.toContain(code);
    expect(admin.mail(user.email, 'identity.staff_recovery_codes_created')).toHaveLength(2);
  });
});

describe('S16a own keys on the admin plane (BR-19, OQ-14)', () => {
  it('adds a backup key after a fresh aal3, lists both, ends the other sessions and tells the account', async () => {
    const { user, c } = await staffWithKey();
    const other = staffApi(admin, await admin.fixtures.token(user, { staff: true }));
    const backup = new SoftAuthenticator('carpals.ir', ORIGIN);
    const options = await c.post('/v1/admin/me/passkeys/options', { label: 'Backup key (safe)' });
    expect(options.status, options.text).toBe(200);
    expect(options.body).toMatchObject({ rp: { id: 'carpals.ir' }, attestation: 'none' });
    // The first key is excluded, so the same authenticator cannot be registered twice.
    expect((options.body.excludeCredentials as unknown[]).length).toBe(1);
    const added = await c.post('/v1/admin/me/passkeys', { attestation: backup.register(options.body) });
    expect(added.status, added.text).toBe(201);
    expect(added.body).toMatchObject({ label: 'Backup key (safe)', device_bound: true, aaguid: null, last_used_at: null });
    expect(added.headers.location).toBe(`/v1/admin/me/passkeys/${added.body.id as string}`);

    const list = await c.get('/v1/admin/me/passkeys');
    expect(list.status, list.text).toBe(200);
    expect((list.body.passkeys as Json[]).map((k) => k.label)).toEqual(['Office key', 'Backup key (safe)']);
    expect(JSON.stringify(list.body)).not.toContain(backup.id);
    expect((await other.get('/v1/admin/me')).status).toBe(401);
    expect(admin.mail(user.email, 'identity.staff_passkey_added')).toHaveLength(2);
  });

  it('refuses a synced passkey without storing it, and a stale sign-in', async () => {
    const { user, c } = await staffWithKey();
    const options = await c.post('/v1/admin/me/passkeys/options', { label: 'Phone' });
    const refused = await c.post('/v1/admin/me/passkeys', {
      attestation: new SoftAuthenticator('carpals.ir', ORIGIN, true).register(options.body),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('PASSKEY_NOT_DEVICE_BOUND');
    expect((await c.get('/v1/admin/me/passkeys')).body.passkeys).toHaveLength(1);

    const stale = staffApi(admin, await admin.fixtures.token(user, { staff: true, authTime: Math.floor(Date.now() / 1000) - 400 }));
    for (const res of [
      await stale.post('/v1/admin/me/passkeys/options', { label: 'Late' }),
      await stale.del(`/v1/admin/me/passkeys/${uuidv7()}`),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('STEP_UP_REQUIRED');
    }
    // Reading the own list needs no step-up.
    expect((await stale.get('/v1/admin/me/passkeys')).status).toBe(200);
  });

  it('removes a key but never the last device-bound one, and only the caller’s own', async () => {
    const { user, c } = await staffWithKey();
    const intruder = await staffWithKey();
    const options = await c.post('/v1/admin/me/passkeys/options', { label: 'Second' });
    await c.post('/v1/admin/me/passkeys', { attestation: new SoftAuthenticator('carpals.ir', ORIGIN).register(options.body) });
    const [first, second] = (await c.get('/v1/admin/me/passkeys')).body.passkeys as Json[];

    expect((await intruder.c.del(`/v1/admin/me/passkeys/${first!.id as string}`)).status).toBe(404);
    const removed = await c.del(`/v1/admin/me/passkeys/${first!.id as string}`);
    expect(removed.status, removed.text).toBe(200);
    expect(admin.mail(user.email, 'identity.staff_passkey_removed')).toHaveLength(1);
    const last = await c.del(`/v1/admin/me/passkeys/${second!.id as string}`);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_PASSKEY');
    expect((await c.get('/v1/admin/me/passkeys')).body.passkeys).toHaveLength(1);
  });
});

describe('S16a disable ends the member’s pending four-eyes requests (DQ-11)', () => {
  it('rejects them with the reason "requester disabled" in the same transaction', async () => {
    const a = await staff(admin, 'platform_admin');
    const b = await staff(admin, 'platform_admin');
    const member = await staff(admin, 'platform_moderator');
    expect((await b.c.post(`/v1/admin/staff/${member.user.id}/disable`, { reason: REASON })).status).toBe(200);
    const pending = await a.c.post(`/v1/admin/staff/${member.user.id}/enable`, { reason: REASON });
    expect(pending.status, pending.text).toBe(202);

    const disabled = await b.c.post(`/v1/admin/staff/${a.user.id}/disable`, { reason: REASON });
    expect(disabled.status, disabled.text).toBe(200);
    const change = await sys((s) =>
      s.db
        .selectFrom('admin.pending_admin_changes')
        .selectAll()
        .where('id', '=', pending.body.change_id as string)
        .executeTakeFirstOrThrow(),
    );
    expect(change).toMatchObject({ status: 'rejected', decided_by: b.user.id, decision_reason: 'requester disabled' });
    // Nothing is left to approve.
    const approve = await b.c.post(`/v1/admin/four-eyes/${pending.body.change_id as string}/decision`, {
      decision: 'approve',
      reason: REASON,
    });
    expect(approve.status).toBe(409);
  });
});

describe('S16a break glass from the server shell (BR-19, R-08)', () => {
  it('disables keys and codes, audits as system, and the backend ends the sessions and tells every ADM', async () => {
    const target = await auth.fixtures.staff('platform_admin');
    await auth.fixtures.withPassword(target, PASSWORD);
    const enrolled = await enrol(target, new SoftAuthenticator('carpals.ir', ORIGIN));
    expect(enrolled.status, enrolled.text).toBe(200);
    const other = await staff(admin, 'platform_admin');
    const session = staffApi(admin, await admin.fixtures.token(target, { staff: true }));
    expect((await session.get('/v1/admin/me')).status).toBe(200);

    await expect(breakGlassStaff({ tx: admin.fixtures.worker, crypto }, 'nobody@test.carpal.app', 'lost key')).rejects.toThrow(
      /no account/,
    );
    const plain = await admin.fixtures.user();
    await expect(breakGlassStaff({ tx: admin.fixtures.worker, crypto }, plain.email, 'lost key')).rejects.toThrow(
      /no active platform role/,
    );

    // The consumer mails the account, then every other ADM. The shared test database holds more than a thousand
    // fixture ADMs and the lite mail sink keeps the last 1000 messages: count the sends at the port instead.
    let accountMails = 0;
    let otherMails = 0;
    let wrongMails = 0;
    const send = infra.mailer.send.bind(infra.mailer);
    infra.mailer.send = async (m) => {
      if (m.to === target.email && m.template === 'identity.staff_break_glass_account') accountMails++;
      if (m.to === other.user.email && m.template === 'identity.staff_break_glass_admins') otherMails++;
      if (m.to === target.email && m.template === 'identity.staff_break_glass_admins') wrongMails++;
      return send(m);
    };
    const r = await breakGlassStaff(
      { tx: admin.fixtures.worker, crypto },
      target.email.toUpperCase(),
      'Lost key on 2026-11-13, one other ADM',
    );
    expect(r).toMatchObject({ keys: 1, codes: 10, roles: ['ADM'] });
    expect(await openCodes(target.id)).toHaveLength(0);
    const audit = await sys((s) =>
      s.db
        .selectFrom('analytics.audit_logs')
        .selectAll()
        .where('entity_id', '=', target.id)
        .where('action', '=', 'staff.break_glass')
        .executeTakeFirstOrThrow(),
    );
    expect(audit).toMatchObject({ actor_type: 'system', reason: 'Lost key on 2026-11-13, one other ADM' });
    const event = await sys((s) =>
      s.db
        .selectFrom('core.domain_event_outbox')
        .selectAll()
        .where('event_type', '=', BREAK_GLASS_EVENT)
        .where('aggregate_id', '=', target.id)
        .executeTakeFirstOrThrow(),
    );

    // The worker's outbox relay delivers staff.break_glass to the consumer of the running backend.
    // S17: staff_name for the administrators' in-app staff notice.
    expect(event.payload).toEqual({ user_id: target.id, staff_name: expect.any(String) });
    expect(worker.get(StaffBreakGlassConsumer).subjects).toEqual([BREAK_GLASS_EVENT]);
    for (let i = 0; i < 300 && (accountMails === 0 || otherMails === 0); i++) await new Promise((r) => setTimeout(r, 100));
    infra.mailer.send = send;
    expect((await session.get('/v1/admin/me')).status).toBe(401);
    expect(accountMails).toBe(1);
    expect(otherMails).toBe(1);
    expect(wrongMails).toBe(0);

    // The next console sign-in enrols a key again, with a new set of codes.
    const again = await enrol(target, new SoftAuthenticator('carpals.ir', ORIGIN));
    expect(again.status, again.text).toBe(200);
    expect(again.body.recovery_codes).toHaveLength(10);
    expect(await openCodes(target.id)).toHaveLength(10);
  });
});
