// Shared steps of a staff account recovery (backend S16b, contract 1.4.0): used by apps/testing/s16b.int.test.ts and the
// identity and admin contract sweep resolvers. A recovery runs on the auth host (cp-web-admin interactions) and on the
// admin plane (two administrators approve); every helper drives the real routes.
import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import type { TestResponse, TestUser } from '#libs/testing/index.js';
import { StaffRecoveryCodes } from '#modules/identity/application/staff-security.js';
import type { Json } from './s4-support.js';
import { REASON, staffApi } from './s8-support.js';
import type { TestApp } from './test-app.js';

export const RECOVERY_PASSWORD = 'correct horse battery staple';
export const ADMIN_ORIGIN = 'https://admin.carpals.ir';
const ADMIN_REDIRECT = 'https://admin.carpals.ir/bff/oauth/callback';
const ADMIN_CLIENT = 'cp-web-admin/1.0.0 (web 1.0)';

export interface AdminInteraction {
  id: string;
  cookie: string;
  /** POST to the auth host inside this interaction (interaction_id added to the body). */
  post: (path: string, body: Json) => Promise<TestResponse<Json>>;
}

/** auth.authorize for cp-web-admin (lite mode: no PoW): the hosted sign-in interaction of the console. */
export async function adminInteraction(auth: TestApp, clientId = 'cp-web-admin'): Promise<AdminInteraction> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: clientId === 'cp-web-admin' ? ADMIN_REDIRECT : 'https://carpals.ir/oauth/callback',
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
  expect(start.status, start.text).toBe(302);
  const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
  const cookie = (start.headers['set-cookie'] ?? '').split(';')[0]!;
  return {
    id,
    cookie,
    post: (path, body) =>
      auth.request<Json>({
        method: 'POST',
        path,
        body: { interaction_id: id, ...body },
        headers: { cookie, 'idempotency-key': uuidv7() },
        client: clientId === 'cp-web-admin' ? ADMIN_CLIENT : 'cp-mobile/1.0.0 (ios 17.0)',
      }),
  };
}

/** A staff member with a password and a set of recovery codes (as if issued at the first enrolment). */
export async function recoverableStaff(app: TestApp, ...roles: string[]): Promise<{ user: TestUser; codes: string[] }> {
  const user = await app.fixtures.staff(...(roles.length ? roles : ['platform_moderator']));
  await app.fixtures.withPassword(user, RECOVERY_PASSWORD);
  const codes = await app.fixtures.worker.run({ actorType: 'system' }, (s) => app.app.get(StaffRecoveryCodes).issue(s, user.id));
  return { user, codes };
}

/** auth.staff_recovery_start: the handle (always), and the emailed code when a request was opened. */
export async function startRecovery(
  auth: TestApp,
  ia: AdminInteraction,
  user: TestUser,
  recoveryCode: string,
  o: { forgotten?: boolean; password?: string } = {},
): Promise<{ handle: string; code: string | undefined; status: number }> {
  const before = auth.mail(user.email, 'identity.staff_recovery_code').length;
  const res = await ia.post('/v1/auth/staff-recovery', {
    email: user.email,
    ...(o.forgotten ? { password_forgotten: true } : { password_forgotten: false, password: o.password ?? RECOVERY_PASSWORD }),
    recovery_code: recoveryCode,
  });
  const mails = auth.mail(user.email, 'identity.staff_recovery_code');
  return {
    handle: (res.body as Json).request_handle as string,
    code: mails.length > before ? mails.at(-1)!.variables.code : undefined,
    status: res.status,
  };
}

/** Start + emailed code: a request waiting for approvals; returns its handle and id. */
export async function openRecovery(
  auth: TestApp,
  user: TestUser,
  recoveryCode: string,
  o: { forgotten?: boolean } = {},
): Promise<{ handle: string; requestId: string }> {
  const ia = await adminInteraction(auth);
  const started = await startRecovery(auth, ia, user, recoveryCode, o);
  expect(started.status).toBe(202);
  expect(started.code, 'a recovery code email').toBeDefined();
  const verified = await ia.post('/v1/auth/staff-recovery/verify', { request_handle: started.handle, code: started.code! });
  expect(verified.status, verified.text).toBe(200);
  const row = await auth.fixtures.worker.run({ actorType: 'system' }, (s) =>
    s.db
      .selectFrom('identity.staff_recovery_requests')
      .select('id')
      .where('user_id', '=', user.id)
      .where('status', '=', 'awaiting_approvals')
      .executeTakeFirstOrThrow(),
  );
  return { handle: started.handle, requestId: row.id };
}

/** Two approvals by two new administrators with a fresh aal3 sign-in. */
export async function approveRecovery(admin: TestApp, requestId: string): Promise<Json> {
  let last: Json = {};
  for (let n = 0; n < 2; n++) {
    const adm = await admin.fixtures.staff('platform_admin');
    const c = staffApi(admin, await admin.fixtures.token(adm, { staff: true }));
    const res = await c.post(`/v1/admin/staff/recoveries/${requestId}/approve`, {
      reason: REASON,
      verification_method: 'phone_known_number',
    });
    expect(res.status, res.text).toBe(200);
    last = res.body;
  }
  return last;
}
