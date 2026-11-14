// S16b (contract 1.4.0; backend/BR-update-plan.json S16b, admin console BR-19, R-08; owner decisions DQ-04, DQ-15): staff
// account recovery with two administrator approvals. The full path for a lost key and for a forgotten password, no
// enumeration at the start, rate limits and the minimum answer time, expiry after 24 hours, one rejection ending a
// request, self and double approval refused, the 72-hour restriction, a synced key refused at completion, and every
// old session ended.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type EmailMessage, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import { StaffRecoveryExpiryRule } from '#modules/identity/application/staff-recovery.js';
import type { INestApplicationContext } from '@nestjs/common';
import type { Json } from './s4-support.js';
import { REASON, staff, staffApi } from './s8-support.js';
import {
  ADMIN_ORIGIN,
  adminInteraction,
  approveRecovery,
  openRecovery,
  RECOVERY_PASSWORD,
  recoverableStaff,
  startRecovery,
} from './s16b-support.js';
import { createTestApp, createTestWorker, testConfig, testLogger, type TestApp } from './test-app.js';

const NEW_PASSWORD = 'a brand new staff passphrase';
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

let infra: Infra;
let auth: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;

type SysScope = Parameters<Parameters<TestApp['fixtures']['worker']['run']>[1]>[0];
const sys = <T>(fn: (scope: SysScope) => Promise<T>): Promise<T> => admin.fixtures.worker.run({ actorType: 'system' }, fn);

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  auth = await createTestApp({ host: 'auth', infra });
  admin = await createTestApp({ host: 'admin-api', infra });
  worker = await createTestWorker({ infra });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await auth?.close();
  await infra?.close();
});

const request = (id: string) =>
  sys((s) => s.db.selectFrom('identity.staff_recovery_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const audits = (id: string) =>
  sys((s) => s.db.selectFrom('analytics.audit_logs').selectAll().where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute());
const activeKeys = (userId: string) =>
  sys((s) =>
    s.db
      .selectFrom('identity.authentication_methods')
      .select(['id', 'status'])
      .where('user_id', '=', userId)
      .where('method_type', '=', 'webauthn')
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .execute(),
  );
const status = (handle: string) =>
  auth.request<Json>({ method: 'POST', path: '/v1/auth/staff-recovery/status', body: { request_handle: handle } });
const adm = () => staff(admin, 'platform_admin');

/** A staff member with one device-bound key registered on the admin plane, a live session and a set of codes. */
async function staffWithKey(...roles: string[]) {
  const { user, codes } = await recoverableStaff(admin, ...roles);
  const session = staffApi(admin, await admin.fixtures.token(user, { staff: true }));
  const key = new SoftAuthenticator('carpals.ir', ADMIN_ORIGIN);
  const options = await session.post('/v1/admin/me/passkeys/options', { label: 'Office key' });
  expect(options.status, options.text).toBe(200);
  expect((await session.post('/v1/admin/me/passkeys', { attestation: key.register(options.body) })).status).toBe(201);
  // Registering ended the other sessions; this one is current.
  return { user, codes, session, key };
}

/** complete_options + complete on a new cp-web-admin interaction; then the new key signs in at once (aal3). */
async function complete(handle: string, o: { newPassword?: string; key?: SoftAuthenticator } = {}) {
  const ia = await adminInteraction(auth);
  const options = await ia.post('/v1/auth/staff-recovery/key/options', {
    request_handle: handle,
    ...(o.newPassword ? { new_password: o.newPassword } : {}),
  });
  expect(options.status, options.text).toBe(200);
  const key = o.key ?? new SoftAuthenticator('carpals.ir', ADMIN_ORIGIN);
  const done = await ia.post('/v1/auth/staff-recovery/key', { attestation: key.register(options.body) });
  return { ia, key, done };
}

describe('S16b recovery of a lost key (BR-19, DQ-04)', () => {
  it('runs start → emailed code → two ADM approvals → new key; old keys, codes and sessions end; every step audited', async () => {
    // The shared test database holds more than a thousand fixture ADMs and the lite mail sink keeps the last 1000
    // messages: this test reads the mails it checks at the Mailer port.
    const sent: EmailMessage[] = [];
    const send = infra.mailer.send.bind(infra.mailer);
    infra.mailer.send = async (m) => {
      sent.push(m);
      return send(m);
    };
    const mailed = (to: string, template: string) => sent.filter((m) => m.to === to && m.template === template);
    const { user, codes, session } = await staffWithKey('platform_admin');
    const other = await adm();
    expect((await session.get('/v1/admin/me')).status).toBe(200);

    const ia = await adminInteraction(auth);
    const started = await startRecovery(auth, ia, user, codes[3]!.toLowerCase());
    expect(started.status).toBe(202);
    expect(started.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.code).toMatch(/^\d{6}$/);
    // The code is spent when the request opens; a waiting request is not visible to the browser yet.
    expect(
      (
        await sys((s) =>
          s.db
            .selectFrom('identity.staff_recovery_codes')
            .select('id')
            .where('user_id', '=', user.id)
            .where('used_at', 'is not', null)
            .execute(),
        )
      ).length,
    ).toBe(1);
    expect((await status(started.handle)).status).toBe(404);
    // Nothing is told to the administrators before the emailed code is checked.
    expect(mailed(other.user.email, 'identity.staff_recovery_requested_admins')).toHaveLength(0);

    const verified = await ia.post('/v1/auth/staff-recovery/verify', { request_handle: started.handle, code: started.code! });
    expect(verified.status, verified.text).toBe(200);
    expect(verified.body).toMatchObject({ status: 'awaiting_approvals', approvals: 0, password_forgotten: false });
    const notice = mailed(other.user.email, 'identity.staff_recovery_requested_admins').at(-1)!;
    expect(notice.variables).toMatchObject({ console_url: ADMIN_ORIGIN });
    expect(mailed(user.email, 'identity.staff_recovery_requested_admins')).toHaveLength(0);
    const { id: requestId } = await sys((s) =>
      s.db.selectFrom('identity.staff_recovery_requests').select('id').where('user_id', '=', user.id).executeTakeFirstOrThrow(),
    );

    // The queue shows the request without codes, handles or contact data.
    const listed = await other.c.get('/v1/admin/staff/recoveries');
    expect(listed.status, listed.text).toBe(200);
    const row = (listed.body.items as Json[]).find((r) => r.id === requestId)!;
    expect(row).toMatchObject({
      user_id: user.id,
      platform_roles: ['platform_admin'],
      approvals: 0,
      approved_by_me: false,
      ip_country: null,
    });
    expect(JSON.stringify(row)).not.toContain(user.email);
    expect(JSON.stringify(row)).not.toContain(started.handle);

    const first = await other.c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, {
      reason: REASON,
      verification_method: 'phone_known_number',
    });
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ status: 'awaiting_approvals', approvals: 1, approved_by_me: true });
    expect((await status(started.handle)).body).toMatchObject({ status: 'awaiting_approvals', approvals: 1 });
    const second = await (
      await adm()
    ).c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, {
      reason: REASON,
      verification_method: 'in_person',
    });
    expect(second.status, second.text).toBe(200);
    expect(second.body).toMatchObject({ status: 'approved', approvals: 2 });
    expect((await status(started.handle)).body).toMatchObject({ status: 'approved', approvals: 2 });
    expect(mailed(user.email, 'identity.staff_recovery_approved')).toHaveLength(1);

    // Completion on a new interaction (the first one has long expired in real life).
    const { ia: ia2, key, done } = await complete(started.handle);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ next: 'mfa', mfa_methods: ['webauthn'] });
    const fresh = done.body.recovery_codes as string[];
    expect(fresh).toHaveLength(10);
    for (const c of fresh) expect(c).toMatch(CODE);

    // The new key signs in at once: aal3.
    const o = await ia2.post('/v1/auth/webauthn/options', { purpose: 'mfa' });
    const signed = await ia2.post('/v1/auth/mfa/verify', { method: 'webauthn', assertion: key.assert(o.body) });
    expect(signed.status, signed.text).toBe(200);
    expect(signed.body).toEqual({ next: 'complete' });

    // Old keys and codes gone, the old session ended, the request completed and the account restricted for 72 hours.
    const keys = await activeKeys(user.id);
    expect(keys).toHaveLength(1);
    expect((await session.get('/v1/admin/me')).status).toBe(401);
    const done2 = await request(requestId);
    expect(done2.status).toBe('completed');
    const hours = (done2.restricted_until!.getTime() - done2.completed_at!.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);
    const open = await sys((s) =>
      s.db
        .selectFrom('identity.staff_recovery_codes')
        .select('set_id')
        .where('user_id', '=', user.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute(),
    );
    expect(open).toHaveLength(10);
    expect(new Set(open.map((c) => c.set_id)).size).toBe(1);
    expect(mailed(user.email, 'identity.staff_recovery_completed_account')).toHaveLength(1);
    expect(mailed(other.user.email, 'identity.staff_recovery_completed_admins')).toHaveLength(1);
    expect((await status(started.handle)).body).toMatchObject({ status: 'completed' });

    const trail = (await audits(requestId)).map((a) => a.action);
    expect(trail).toEqual([
      'staff.recovery_requested',
      'staff.recovery_email_verified',
      'staff.recovery_approved',
      'staff.recovery_approved',
      'staff.recovery_completed',
    ]);
    const text = JSON.stringify(await audits(requestId));
    for (const c of [...fresh, ...codes]) expect(text).not.toContain(c);
    expect(text).not.toContain(started.handle);

    // StaffMe carries the restriction.
    const me = await staffApi(admin, await admin.fixtures.token(user, { staff: true })).get('/v1/admin/me');
    expect(me.body.restricted_until).toBe(done2.restricted_until!.toISOString());
    infra.mailer.send = send;
  });

  it('a forgotten password: the request skips the password and completion sets a new one', async () => {
    const { user, codes } = await staffWithKey('platform_moderator');
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!, { forgotten: true });
    expect((await status(handle)).body).toMatchObject({ password_forgotten: true });
    await approveRecovery(admin, requestId);

    const ia = await adminInteraction(auth);
    const missing = await ia.post('/v1/auth/staff-recovery/key/options', { request_handle: handle });
    expect(missing.status).toBe(422);
    const breached = await ia.post('/v1/auth/staff-recovery/key/options', { request_handle: handle, new_password: 'password1234' });
    expect(breached.status).toBe(422);
    const { done } = await complete(handle, { newPassword: NEW_PASSWORD });
    expect(done.status, done.text).toBe(200);

    // The new password signs in (then the new key), the old one no longer does.
    const s1 = await adminInteraction(auth);
    expect((await s1.post('/v1/auth/signin', { email: user.email, password: RECOVERY_PASSWORD })).status).toBe(401);
    const s2 = await adminInteraction(auth);
    expect((await s2.post('/v1/auth/signin', { email: user.email, password: NEW_PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    expect((await audits(requestId)).at(-1)!.new_state_summary).toContain('new password');
    // S17: both steps put an event on the outbox for the administrators' in-app staff notice.
    const events = await auth.fixtures.worker.run({ actorType: 'system' }, (sc) =>
      sc.db
        .selectFrom('core.domain_event_outbox')
        .select(['event_type', 'payload'])
        .where('aggregate_id', '=', requestId)
        .where('event_type', 'in', ['staff.recovery_requested', 'staff.recovery_completed'])
        .orderBy('event_id')
        .execute(),
    );
    expect(events.map((e) => e.event_type)).toEqual(['staff.recovery_requested', 'staff.recovery_completed']);
    expect(events[0]!.payload).toEqual({ user_id: user.id, staff_name: expect.any(String) });
  });

  it('keeps the password when it was not forgotten, and refuses a new one', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!);
    await approveRecovery(admin, requestId);
    const ia = await adminInteraction(auth);
    const res = await ia.post('/v1/auth/staff-recovery/key/options', { request_handle: handle, new_password: NEW_PASSWORD });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('conditional_forbidden');
  });
});

describe('S16b no enumeration at the start (SEC-AU-11)', () => {
  it('answers unknown, non-staff, disabled, wrong-password, wrong-code and already-open requests like a real one', async () => {
    const { user, codes } = await recoverableStaff(admin, 'platform_support');
    const plain = await admin.fixtures.user();
    await admin.fixtures.withPassword(plain, RECOVERY_PASSWORD);
    const disabled = await recoverableStaff(admin, 'platform_moderator');
    const a = await adm();
    expect((await a.c.post(`/v1/admin/staff/${disabled.user.id}/disable`, { reason: REASON })).status).toBe(200);

    const nobody = { email: `nobody-${uuidv7()}@staff.carpals.test` } as TestUser;
    const attempts: [TestUser, string, { password?: string }][] = [
      [nobody, codes[0]!, {}],
      [plain, codes[0]!, {}],
      [disabled.user, disabled.codes[0]!, {}],
      [user, codes[0]!, { password: 'not the password at all' }],
      [user, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', {}],
    ];
    const ia = await adminInteraction(auth);
    for (const [who, code, o] of attempts) {
      const r = await startRecovery(auth, ia, who, code, o);
      expect(r.status).toBe(202);
      expect(r.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.code, who.email).toBeUndefined();
      // The handle leads nowhere: the code check fails like a wrong code, and the status is unknown.
      const v = await ia.post('/v1/auth/staff-recovery/verify', { request_handle: r.handle, code: '123456' });
      expect(v.status).toBe(422);
      expect(v.body.code).toBe('CODE_INVALID');
      expect((await status(r.handle)).status).toBe(404);
    }
    // A wrong password or code never spends a recovery code.
    const used = await sys((s) =>
      s.db
        .selectFrom('identity.staff_recovery_codes')
        .select('id')
        .where('user_id', '=', user.id)
        .where('used_at', 'is not', null)
        .execute(),
    );
    expect(used).toHaveLength(0);

    // A real request, then a second one while it is open: the second answers the same and sends nothing.
    await openRecovery(auth, user, codes[1]!);
    const again = await startRecovery(auth, await adminInteraction(auth), user, codes[2]!);
    expect(again.status).toBe(202);
    expect(again.code).toBeUndefined();
  });

  it('refuses clients other than cp-web-admin and checks the password rule', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const mobile = await adminInteraction(auth, 'cp-mobile');
    const refused = await mobile.post('/v1/auth/staff-recovery', {
      email: user.email,
      password: RECOVERY_PASSWORD,
      password_forgotten: false,
      recovery_code: codes[0]!,
    });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('INVALID_CREDENTIALS');
    const ia = await adminInteraction(auth);
    const both = await ia.post('/v1/auth/staff-recovery', {
      email: user.email,
      password: RECOVERY_PASSWORD,
      password_forgotten: true,
      recovery_code: codes[0]!,
    });
    expect(both.status).toBe(422);
    const neither = await ia.post('/v1/auth/staff-recovery', { email: user.email, password_forgotten: false, recovery_code: codes[0]! });
    expect(neither.status).toBe(422);
  });

  it('five wrong emailed codes end the way forward', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const ia = await adminInteraction(auth);
    const r = await startRecovery(auth, ia, user, codes[0]!);
    const wrong = r.code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++)
      expect((await ia.post('/v1/auth/staff-recovery/verify', { request_handle: r.handle, code: wrong })).status).toBe(422);
    expect((await ia.post('/v1/auth/staff-recovery/verify', { request_handle: r.handle, code: r.code! })).status).toBe(422);
  });
});

describe('S16b rate limits and answer time (strict auth app)', () => {
  let strictInfra: Infra;
  let strict: TestApp;

  beforeAll(async () => {
    const env = { CARPAL_RATE_LIMIT_SCALE: '1', CARPAL_AUTH_MIN_LATENCY_MS: '300' };
    const config = testConfig(env);
    strictInfra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    strict = await createTestApp({ host: 'auth', infra: strictInfra, env });
  }, 60_000);

  afterAll(async () => {
    await strict?.close();
    await strictInfra?.close();
  });

  it('every answer takes the same minimum time; 3 per hour per account, 10 per hour per IP prefix', async () => {
    const { user, codes } = await recoverableStaff(strict);
    const ia = await adminInteraction(strict);
    const timed = async (who: TestUser, code: string) => {
      const t = performance.now();
      const r = await startRecovery(strict, ia, who, code);
      return { ...r, ms: performance.now() - t };
    };
    const live = await timed(user, codes[0]!);
    expect(live.code).toBeDefined();
    const unknown = await timed({ email: `nobody-${uuidv7()}@staff.carpals.test` } as TestUser, codes[1]!);
    expect(unknown.code).toBeUndefined();
    for (const r of [live, unknown]) {
      expect(r.status).toBe(202);
      expect(r.ms).toBeGreaterThanOrEqual(295);
    }
    // Two more for the same account fill its hour (an open request answers the same), the fourth is refused.
    expect((await startRecovery(strict, ia, user, codes[2]!)).status).toBe(202);
    expect((await startRecovery(strict, ia, user, codes[3]!)).status).toBe(202);
    expect((await startRecovery(strict, ia, user, codes[4]!)).status).toBe(429);

    // Other accounts from the same address: at most 10 per hour in all.
    let accepted = 4;
    let limited = false;
    for (let n = 0; n < 10 && !limited; n++) {
      const r = await startRecovery(
        strict,
        ia,
        { email: `ip-${n}-${randomBytes(4).toString('hex')}@staff.carpals.test` } as TestUser,
        'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      );
      if (r.status === 429) limited = true;
      else accepted++;
    }
    expect(limited).toBe(true);
    expect(accepted).toBeLessThanOrEqual(10);
  });
});

describe('S16b approvals on the admin plane (DQ-04, DQ-15)', () => {
  it('refuses the requester, a second approval by the same ADM and a stale sign-in; MOD cannot see the queue', async () => {
    const requester = await recoverableStaff(admin, 'platform_admin');
    const { requestId } = await openRecovery(auth, requester.user, requester.codes[0]!);
    const self = staffApi(admin, await admin.fixtures.token(requester.user, { staff: true }));
    const own = await self.post(`/v1/admin/staff/recoveries/${requestId}/approve`, { reason: REASON, verification_method: 'in_person' });
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const a = await adm();
    const body = { reason: REASON, verification_method: 'video_call' };
    expect((await a.c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, body)).status).toBe(200);
    const twice = await a.c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, body);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');

    const b = await admin.fixtures.staff('platform_admin');
    const stale = staffApi(admin, await admin.fixtures.token(b, { staff: true, authTime: Math.floor(Date.now() / 1000) - 400 }));
    const late = await stale.post(`/v1/admin/staff/recoveries/${requestId}/approve`, body);
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('STEP_UP_REQUIRED');
    expect(late.headers['www-authenticate']).toContain('max_age=300');

    const other = await staffApi(admin, await admin.fixtures.token(b, { staff: true })).post(
      `/v1/admin/staff/recoveries/${requestId}/approve`,
      {
        reason: REASON,
        verification_method: 'other',
      },
    );
    expect(other.status).toBe(422);

    const mod = await staff(admin, 'platform_moderator');
    expect([403, 404]).toContain((await mod.c.get('/v1/admin/staff/recoveries')).status);
    expect((await request(requestId)).status).toBe('awaiting_approvals');
  });

  it('one rejection ends the request, even after it was approved, and the requester is told', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!);
    const a = await adm();
    expect(
      (await a.c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, { reason: REASON, verification_method: 'in_person' })).status,
    ).toBe(200);
    const b = await adm();
    const rejected = await b.c.post(`/v1/admin/staff/recoveries/${requestId}/reject`, { reason: 'Not reachable on the known number' });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', approvals: 1 });
    expect((rejected.body.decisions as Json[]).map((d) => d.decision)).toEqual(['approve', 'reject']);
    expect(admin.mail(user.email, 'identity.staff_recovery_rejected')).toHaveLength(1);
    const after = await (
      await adm()
    ).c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, { reason: REASON, verification_method: 'in_person' });
    expect(after.status).toBe(409);
    expect((await status(handle)).body).toMatchObject({ status: 'rejected' });

    // An approved request can still be stopped before completion.
    const second = await recoverableStaff(admin);
    const r2 = await openRecovery(auth, second.user, second.codes[0]!);
    await approveRecovery(admin, r2.requestId);
    expect((await (await adm()).c.post(`/v1/admin/staff/recoveries/${r2.requestId}/reject`, { reason: REASON })).status).toBe(200);
    const ia = await adminInteraction(auth);
    const late = await ia.post('/v1/auth/staff-recovery/key/options', { request_handle: r2.handle });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // A closed request can no longer be rejected.
    expect((await (await adm()).c.post(`/v1/admin/staff/recoveries/${r2.requestId}/reject`, { reason: REASON })).status).toBe(409);
  });

  it('a member disabled while waiting cannot be approved', async () => {
    const { user, codes } = await recoverableStaff(admin, 'platform_support');
    const { requestId } = await openRecovery(auth, user, codes[0]!);
    const a = await adm();
    expect((await a.c.post(`/v1/admin/staff/${user.id}/disable`, { reason: REASON })).status).toBe(200);
    const res = await (
      await adm()
    ).c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, { reason: REASON, verification_method: 'in_person' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('S16b expiry after 24 hours', () => {
  it('an overdue request cannot be approved or completed, the rule marks it expired, and a new one can be opened', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!);
    await sys((s) =>
      s.db
        .updateTable('identity.staff_recovery_requests')
        // The touch trigger keeps created_at; the deadline moves just after the opening instead.
        .set({ expires_at: sql<Date>`created_at + interval '1 millisecond'` })
        .where('id', '=', requestId)
        .execute(),
    );
    expect((await status(handle)).body).toMatchObject({ status: 'expired' });
    const approve = await (
      await adm()
    ).c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, { reason: REASON, verification_method: 'in_person' });
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('INVALID_TRANSITION');
    const listed = await (await adm()).c.get('/v1/admin/staff/recoveries?status=expired&limit=100');
    expect((listed.body.items as Json[]).some((r) => r.id === requestId)).toBe(true);

    expect(await worker.get(StaffRecoveryExpiryRule).run()).toBeGreaterThanOrEqual(1);
    expect((await request(requestId)).status).toBe('expired');
    expect((await audits(requestId)).map((a) => a.action)).toContain('staff.recovery_expired');

    // The account may ask again.
    const again = await startRecovery(auth, await adminInteraction(auth), user, codes[1]!);
    expect(again.code).toBeDefined();
  });

  it('a request whose emailed code is not checked within 10 minutes stops blocking the account', async () => {
    const { user, codes } = await recoverableStaff(admin);
    const first = await startRecovery(auth, await adminInteraction(auth), user, codes[0]!);
    expect(first.code).toBeDefined();
    await sys((s) =>
      s.db
        .updateTable('identity.staff_recovery_requests')
        .set({ expires_at: sql<Date>`created_at + interval '1 millisecond'` })
        .where('user_id', '=', user.id)
        .execute(),
    );
    const second = await startRecovery(auth, await adminInteraction(auth), user, codes[1]!);
    expect(second.code).toBeDefined();
  });
});

describe('S16b completion rules and the 72-hour restriction', () => {
  it('refuses a synced key without changing anything, then accepts a device-bound one', async () => {
    const { user, codes, key: oldKey } = await staffWithKey();
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!);
    await approveRecovery(admin, requestId);
    const synced = await complete(handle, { key: new SoftAuthenticator('carpals.ir', ADMIN_ORIGIN, true) });
    expect(synced.done.status).toBe(422);
    expect(synced.done.body.code).toBe('PASSKEY_NOT_DEVICE_BOUND');
    expect((await request(requestId)).status).toBe('approved');
    const keys = await activeKeys(user.id);
    expect(keys).toHaveLength(1);
    expect(oldKey.id).toBeTruthy();

    const ok = await complete(handle);
    expect(ok.done.status, ok.done.text).toBe(200);
    expect((await request(requestId)).status).toBe('completed');
    // Completed: the handle cannot be used twice.
    const ia = await adminInteraction(auth);
    expect((await ia.post('/v1/auth/staff-recovery/key/options', { request_handle: handle })).status).toBe(409);
  });

  it('a recovered ADM cannot approve four-eyes changes, grant or revoke roles, enable staff or approve a recovery', async () => {
    const { user, codes } = await recoverableStaff(admin, 'platform_admin');
    const { handle, requestId } = await openRecovery(auth, user, codes[0]!);
    await approveRecovery(admin, requestId);
    expect((await complete(handle)).done.status).toBe(200);
    const restricted = staffApi(admin, await admin.fixtures.token(user, { staff: true }));
    expect((await restricted.get('/v1/admin/me')).body.restricted_until).toBeTruthy();

    const other = await adm();
    const target = await admin.fixtures.user();
    const change = await other.c.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_support', reason: REASON });
    expect(change.status).toBe(202);
    const disabled = await staff(admin, 'platform_support');
    expect((await other.c.post(`/v1/admin/staff/${disabled.user.id}/disable`, { reason: REASON })).status).toBe(200);
    const roleHolder = await admin.fixtures.staff('platform_support');
    const waiting = await recoverableStaff(admin);
    const pending = await openRecovery(auth, waiting.user, waiting.codes[0]!);

    for (const res of [
      await restricted.post(`/v1/admin/four-eyes/${change.body.change_id as string}/decision`, { decision: 'approve', reason: REASON }),
      await restricted.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_moderator', reason: REASON }),
      await restricted.del(`/v1/admin/users/${roleHolder.id}/platform-roles/platform_support`, { 'carpal-reason': REASON }),
      await restricted.post(`/v1/admin/staff/${disabled.user.id}/enable`, { reason: REASON }),
      await restricted.post(`/v1/admin/staff/recoveries/${pending.requestId}/approve`, {
        reason: REASON,
        verification_method: 'in_person',
      }),
    ]) {
      expect(res.status, res.text).toBe(403);
      expect(res.body.code).toBe('STAFF_RECOVERY_RESTRICTED');
    }
    // Rejecting stays possible.
    const reject = await restricted.post(`/v1/admin/four-eyes/${change.body.change_id as string}/decision`, {
      decision: 'reject',
      reason: REASON,
    });
    expect(reject.status, reject.text).toBe(200);

    // After 72 hours the restriction is over.
    await sys((s) =>
      s.db
        .updateTable('identity.staff_recovery_requests')
        .set({ restricted_until: new Date(Date.now() - 1000) })
        .where('id', '=', requestId)
        .execute(),
    );
    expect((await restricted.get('/v1/admin/me')).body.restricted_until).toBeNull();
    const now = await restricted.post(`/v1/admin/staff/recoveries/${pending.requestId}/approve`, {
      reason: REASON,
      verification_method: 'in_person',
    });
    expect(now.status, now.text).toBe(200);
  });
});
