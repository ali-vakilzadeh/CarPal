// S3 account operations (40 §6.3): me.get/update, email and phone change,
// password change, preferences, memberships, sessions and second factors.
// The api and auth hosts share adapters (sessions, mail sink) as in pnpm dev.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { base32Decode, hotp, totpStep } from '#modules/identity/domain/credentials.js';
import { createTestApp, testConfig, testLogger, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
type Json = Record<string, any>;

let infra: Infra;
let api: TestApp;
let auth: TestApp;
const idem = () => ({ 'idempotency-key': uuidv7() });
const fresh = () => ({ acr: 'aal2' as const, authTime: Math.floor(Date.now() / 1000) });

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  api = await createTestApp({ host: 'api', infra });
  auth = await createTestApp({ host: 'auth', infra });
});
afterAll(async () => {
  await auth.close();
  await api.close();
  await infra.close();
});

describe('me.get / me.update', () => {
  it('updates name, locale and timezone with If-Match; stale versions are 412, bad timezones 422', async () => {
    const user = await api.fixtures.user();
    const token = await api.fixtures.token(user);
    const me = await api.request<Json>({ path: '/v1/me', token });
    expect(me.status).toBe(200);
    expect(me.headers.etag).toBe(`"v${me.body.version}"`);
    const patch = (body: Json, ifMatch: string) =>
      api.request<Json>({ method: 'PATCH', path: '/v1/me', token, body, headers: { 'if-match': ifMatch } });
    expect((await patch({ full_name: 'No Match' }, '')).status).toBe(428);
    const ok = await patch({ full_name: 'Reza Example', display_name: 'Reza', locale: 'fa', timezone: 'Asia/Tehran' }, me.headers.etag!);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      full_name: 'Reza Example',
      display_name: 'Reza',
      locale: 'fa',
      timezone: 'Asia/Tehran',
      version: me.body.version + 1,
    });
    expect((await patch({ display_name: null }, me.headers.etag!)).status).toBe(412);
    const tz = await patch({ timezone: 'Mars/Olympus' }, ok.headers.etag!);
    expect(tz.status).toBe(422);
    expect(tz.body.errors).toEqual([{ pointer: '/timezone', code: 'enum' }]);
    // System fields cannot be written (SEC-AZ-5).
    expect((await patch({ email: 'x@test.carpal.app' }, ok.headers.etag!)).body.code).toBe('READ_ONLY_FIELD');
  });
});

describe('me.email_change', () => {
  it('needs AAL2, mails a link to the new address and a notice to the old one; applies on verification', async () => {
    const user = await api.fixtures.user();
    const newEmail = `new-${uuidv7()}@test.carpal.app`;
    const change = (token: string) =>
      api.request<Json>({ method: 'POST', path: '/v1/me/email-change', token, body: { new_email: newEmail }, headers: idem() });
    const stale = await change(await api.fixtures.token(user));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('STEP_UP_REQUIRED');
    expect(stale.headers['www-authenticate']).toContain('acr_values="aal2"');
    const token = await api.fixtures.token(user, fresh());
    expect((await change(token)).status).toBe(202);
    expect(api.mail(user.email, 'identity.email_change_notice')).toHaveLength(1);
    const link = api.mail(newEmail, 'identity.email_verification').at(-1)!.variables.link!;
    // Nothing changes before verification.
    expect((await api.request<Json>({ path: '/v1/me', token })).body.email).toBe(user.email);
    const verify = await auth.request({ method: 'POST', path: '/v1/auth/email/verify', body: { token: link.split('#')[1] } });
    expect(verify.status).toBe(200);
    expect((await api.request<Json>({ path: '/v1/me', token })).body.email).toBe(newEmail);
  });

  it('an address taken meanwhile is refused at verification (409)', async () => {
    const user = await api.fixtures.user();
    const other = await api.fixtures.user();
    const token = await api.fixtures.token(user, fresh());
    await api.request({ method: 'POST', path: '/v1/me/email-change', token, body: { new_email: other.email }, headers: idem() });
    const link = api.mail(other.email, 'identity.email_verification').at(-1)!.variables.link!;
    const res = await auth.request<Json>({ method: 'POST', path: '/v1/auth/email/verify', body: { token: link.split('#')[1] } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });
});

describe('me.phone_change_start / verify', () => {
  it('texts a code to an allowlisted number and replaces the phone; wrong codes are CODE_INVALID', async () => {
    const user = await api.fixtures.user();
    const token = await api.fixtures.token(user, fresh());
    const phone = `+98912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    expect((await api.request({ method: 'POST', path: '/v1/me/phone-change', token, body: { phone: '+15551234567' } })).status).toBe(422);
    expect((await api.request({ method: 'POST', path: '/v1/me/phone-change', token, body: { phone } })).status).toBe(202);
    const code = api.sms(phone).at(-1)!.variables.code!;
    const bad = await api.request<Json>({
      method: 'POST',
      path: '/v1/me/phone-change/verify',
      token,
      body: { code: code === '000000' ? '999999' : '000000' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CODE_INVALID');
    const ok = await api.request<Json>({ method: 'POST', path: '/v1/me/phone-change/verify', token, body: { code } });
    expect(ok.status).toBe(200);
    expect(ok.body.phone).toBe(phone);
    expect(ok.body.phone_verified_at).not.toBeNull();
  });
});

describe('me.password_change', () => {
  it('checks the current password, refuses breached ones and ends the other sessions', async () => {
    const user = await api.fixtures.user();
    await api.fixtures.withPassword(user, 'the current passphrase');
    const other = await api.fixtures.token(user);
    const token = await api.fixtures.token(user, fresh());
    const change = (current: string, next: string) =>
      api.request<Json>({ method: 'POST', path: '/v1/me/password', token, body: { current_password: current, new_password: next } });
    expect((await change('wrong passphrase', 'a new long passphrase')).body.code).toBe('INVALID_CREDENTIALS');
    expect((await change('the current passphrase', 'qwertyuiop12')).status).toBe(422);
    expect((await change('the current passphrase', 'a new long passphrase')).status).toBe(200);
    expect((await api.request({ path: '/v1/me', token: other })).status).toBe(401);
    expect((await api.request({ path: '/v1/me', token })).status).toBe(200);
    expect(api.mail(user.email, 'identity.password_changed')).toHaveLength(1);
  });
});

describe('me.preferences_get / update', () => {
  it('needs If-Match; AI personalization and marketing need their consent; navigation app from the region list', async () => {
    const user = await api.fixtures.user({ locale: 'fa' });
    const token = await api.fixtures.token(user);
    const get = await api.request<Json>({ path: '/v1/me/preferences', token });
    expect(get.body).toMatchObject({
      calendar_system: 'jalali',
      digit_style: 'persian',
      profile_visibility: 'members_only',
      marketing_opt_in: false,
    });
    const put = (body: Json, etag = get.headers.etag!) =>
      api.request<Json>({ method: 'PATCH', path: '/v1/me/preferences', token, body, headers: { 'if-match': etag } });
    const consent = await put({ marketing_opt_in: true });
    expect(consent.status).toBe(403);
    expect(consent.body.code).toBe('CONSENT_REQUIRED');
    expect((await put({ navigation_app_key: 'mapquest' })).body.errors).toEqual([{ pointer: '/navigation_app_key', code: 'enum' }]);
    const membership = await put({ default_role_membership_id: uuidv7() });
    expect(membership.body.code).toBe('REFERENCE_NOT_FOUND');
    await api.request({
      method: 'POST',
      path: '/v1/me/consents',
      token,
      body: { consent_type: 'marketing', policy_version: '2026-10' },
      headers: idem(),
    });
    const ok = await put({ marketing_opt_in: true, navigation_app_key: 'neshan', distance_unit: 'km' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ marketing_opt_in: true, navigation_app_key: 'neshan', version: get.body.version + 1 });
  });
});

describe('me.memberships_list / membership_leave', () => {
  it('lists every role incl. individual with organization summaries; filters by status; pages', async () => {
    const { user, org, token } = await api.fixtures.memberOf('provider', 'provider_manager');
    const other = await api.fixtures.org('vendor');
    await api.fixtures.member(user, other, 'vendor_staff', 'suspended');
    const all = await api.request<Json>({ path: '/v1/me/memberships?limit=2', token });
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0]).toMatchObject({ role: 'individual', organization: null, status: 'active' });
    expect(all.body.items[1].organization).toMatchObject({ id: org.id, organization_type: 'provider', logo_url: null });
    const next = await api.request<Json>({ path: `/v1/me/memberships?limit=2&cursor=${all.body.next_cursor}`, token });
    expect(next.body.items.map((m: Json) => m.role)).toEqual(['vendor_staff']);
    expect(next.body.next_cursor).toBeNull();
    const suspended = await api.request<Json>({ path: '/v1/me/memberships?status=suspended', token });
    expect(suspended.body.items.map((m: Json) => m.role)).toEqual(['vendor_staff']);
  });

  it('the last active owner cannot leave; a member can, and loses access at once', async () => {
    const { user: owner, org } = await api.fixtures.memberOf('fleet', 'fleet_owner');
    const ownerToken = await api.fixtures.token(owner, fresh());
    const list = await api.request<Json>({ path: '/v1/me/memberships', token: ownerToken });
    const ownership = list.body.items.find((m: Json) => m.role === 'fleet_owner');
    const leave = (token: string, id: string) => api.request<Json>({ method: 'DELETE', path: `/v1/me/memberships/${id}`, token });
    const last = await leave(ownerToken, ownership.id);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('INVALID_TRANSITION');
    const individual = list.body.items.find((m: Json) => m.role === 'individual');
    expect((await leave(ownerToken, individual.id)).status).toBe(409);

    const viewer = await api.fixtures.user();
    await api.fixtures.member(viewer, org, 'fleet_viewer');
    const viewerToken = await api.fixtures.token(viewer, fresh());
    expect((await api.request({ path: `/v1/orgs/${org.id}/consents`, token: viewerToken })).status).toBe(200);
    const mine = (await api.request<Json>({ path: '/v1/me/memberships', token: viewerToken })).body.items.find(
      (m: Json) => m.role === 'fleet_viewer',
    );
    expect((await leave(ownerToken, mine.id)).status).toBe(404); // someone else's membership
    expect((await leave(viewerToken, mine.id)).status).toBe(200);
    expect((await api.request({ path: `/v1/orgs/${org.id}/consents`, token: viewerToken })).status).toBe(404);
  });
});

describe('me.sessions_list / session_revoke / sessions_revoke_all', () => {
  it('lists sessions with the current one marked; revokes one; revoke-all can keep the current session', async () => {
    const user = await api.fixtures.user();
    const a = await api.fixtures.token(user, fresh());
    const b = await api.fixtures.token(user);
    const c = await api.fixtures.token(user);
    const list = await api.request<Json>({ path: '/v1/me/sessions', token: a });
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.filter((s: Json) => s.current)).toHaveLength(1);
    const victim = list.body.items.find((s: Json) => !s.current);
    expect((await api.request({ method: 'DELETE', path: `/v1/me/sessions/${victim.id}`, token: a })).status).toBe(200);
    // Another user's session id is not found.
    const stranger = await api.fixtures.token(await api.fixtures.user());
    expect((await api.request({ method: 'DELETE', path: `/v1/me/sessions/${list.body.items[0].id}`, token: stranger })).status).toBe(404);
    const all = await api.request({ method: 'POST', path: '/v1/me/sessions/revoke-all', token: a, body: { keep_current: true } });
    expect(all.status).toBe(200);
    expect((await api.request({ path: '/v1/me', token: a })).status).toBe(200);
    expect((await api.request({ path: '/v1/me', token: b })).status).toBe(401);
    expect((await api.request({ path: '/v1/me', token: c })).status).toBe(401);
  });
});

describe('second factors (me.mfa_*)', () => {
  it('an account without a second factor enrols with a fresh sign-in (AAL2 deviation DI-11); a stale one must re-authenticate', async () => {
    const user = await api.fixtures.user();
    const stale = await api.fixtures.token(user, { mfaEnrolled: false, authTime: Math.floor(Date.now() / 1000) - 3600 });
    const enrol = (token: string) =>
      api.request<Json>({ method: 'POST', path: '/v1/me/mfa-methods/totp', token, body: { label: 'Authy' }, headers: idem() });
    expect((await enrol(stale)).status).toBe(401);
    const token = await api.fixtures.token(user, { mfaEnrolled: false });
    const res = await enrol(token);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/me/mfa-methods/${res.body.method.id}`);
    expect(res.body.method).toMatchObject({ method_type: 'totp_mfa', label: 'Authy', status: 'pending' });
    expect(res.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/CarPal:/);
    // An aal1 session of an account that has a second factor is not enough.
    expect((await enrol(await api.fixtures.token(await api.fixtures.user()))).status).toBe(401);
  });

  it('confirm → recovery codes once; regenerate; remove the last factor turns MFA off', async () => {
    const user = await api.fixtures.user();
    const token = await api.fixtures.token(user, { mfaEnrolled: false });
    const other = await api.fixtures.token(user);
    const enrol = await api.request<Json>({
      method: 'POST',
      path: '/v1/me/mfa-methods/totp',
      token,
      body: { label: 'Phone' },
      headers: idem(),
    });
    const id = enrol.body.method.id;
    const secret = base32Decode(new URL(enrol.body.otpauth_uri).searchParams.get('secret')!);
    const confirm = (body: Json) => api.request<Json>({ method: 'POST', path: `/v1/me/mfa-methods/${id}/confirm`, token, body });
    expect((await confirm({})).body.errors).toEqual([{ pointer: '/code', code: 'conditional_required' }]);
    const wrong = hotp(secret, totpStep() + 5);
    expect((await confirm({ code: wrong })).body.code).toBe('CODE_INVALID');
    const ok = await confirm({ code: hotp(secret, totpStep()) });
    expect(ok.status).toBe(200);
    expect(ok.body.method.status).toBe('active');
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect((await confirm({ code: hotp(secret, totpStep()) })).status).toBe(409);
    // MFA change: other sessions end; this one is now aal2.
    expect((await api.request({ path: '/v1/me', token: other })).status).toBe(401);
    const me = await api.request<Json>({ path: '/v1/me', token });
    expect(me.body.mfa_enabled).toBe(true);
    const list = await api.request<Json>({ path: '/v1/me/mfa-methods', token });
    expect(list.body.items.map((m: Json) => m.status)).toEqual(['active']);

    const regen = await api.request<Json>({ method: 'POST', path: '/v1/me/mfa-recovery-codes', token, headers: idem() });
    expect(regen.status).toBe(200);
    expect(regen.body.recovery_codes).toHaveLength(10);
    expect(regen.body.recovery_codes).not.toEqual(ok.body.recovery_codes);

    expect((await api.request({ method: 'DELETE', path: `/v1/me/mfa-methods/${id}`, token })).status).toBe(200);
    expect((await api.request<Json>({ path: '/v1/me', token })).body.mfa_enabled).toBe(false);
    expect((await api.request({ method: 'POST', path: '/v1/me/mfa-recovery-codes', token, headers: idem() })).status).toBe(409);
  });
});
