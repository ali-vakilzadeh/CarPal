// Contract sweep resolvers: the authorization server (40 §6.2, auth host),
// the account (§6.3), consents (§6.4), data subject requests (§6.5),
// onboarding (§6.6) and user administration (§23.2). Auth-host operations are
// PUB(no token): they run inside a hosted sign-in interaction (cookie).
import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { base32Decode, hotp, totpStep } from '#modules/identity/domain/credentials.js';
import { openCase, purpose, REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

const REDIRECT = 'https://carpal.app/oauth/callback';
const PASSWORD = 'correct horse battery staple';
const none = { kind: 'none' } as const;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
}

const authorizeQuery = (p: ReturnType<typeof pkce>) => ({
  response_type: 'code',
  client_id: 'cp-mobile',
  redirect_uri: REDIRECT,
  scope: 'openid offline_access',
  state: p.state,
  nonce: p.nonce,
  code_challenge: p.challenge,
  code_challenge_method: 'S256',
});

/** auth.authorize → the hosted sign-in interaction: its id and cookie. */
async function interaction(h: Harness): Promise<{ id: string; cookie: string }> {
  const res = await h.auth.request({ path: `/oauth/authorize?${new URLSearchParams(authorizeQuery(pkce())).toString()}`, client: null });
  if (res.status !== 302) throw new Error(`authorize ${res.status} ${res.text}`);
  return {
    id: new URL(res.headers.location!).searchParams.get('interaction_id')!,
    cookie: (res.headers['set-cookie'] ?? '').split(';')[0]!,
  };
}

const authPost = (h: Harness, path: string, cookie: string, body: Json) =>
  h.auth.request<Json>({ method: 'POST', path, body, headers: { cookie, 'idempotency-key': h.newId() } });

/** A user with a password and a confirmed TOTP second factor (secret returned for codes). */
async function totpUser(h: Harness): Promise<{ as: Actor; secret: Buffer; methodId: string }> {
  const as = await h.user();
  await h.fx.withPassword(as.user, PASSWORD);
  const enrol = ok(await as.c.post('/v1/me/mfa-methods/totp', { label: 'Phone' }), 'totp enrol');
  const secret = base32Decode(new URL(enrol.otpauth_uri as string).searchParams.get('secret')!);
  ok(await as.c.post(`/v1/me/mfa-methods/${enrol.method.id}/confirm`, { code: hotp(secret, totpStep()) }), 'totp confirm');
  return { as, secret, methodId: enrol.method.id as string };
}

/** A consent request (cn link) to a user from an organization, as a portfolio consent request stores it. */
async function consentRequest(h: Harness, subject: Actor): Promise<string> {
  const org = await h.fx.org('provider');
  const link = h.api.app.get(LinkTokens, { strict: false }).issue('cn');
  await h.sys((db) =>
    db
      .insertInto('identity.consent_requests')
      .values({
        id: h.newId(),
        requested_by_organization_id: org.id,
        requested_by_user_id: subject.user.id,
        subject_user_id: subject.user.id,
        consent_type: 'showcase_publishing',
        scope_entity_type: 'portfolio_item',
        scope_entity_id: h.newId(),
        source_visit_type: 'appointment',
        source_visit_id: h.newId(),
        purpose_i18n_key: 'consent.showcase.purpose',
        token_hash: link.hash,
        expires_at: link.expiresAt!,
      })
      .execute(),
  );
  return link.token;
}

/** A data subject request of a user, moved by support to `status` (purpose-bound admin calls). */
async function dsr(
  h: Harness,
  type: 'export' | 'deletion',
  status: 'received' | 'in_progress' | 'completed',
): Promise<{ as: Actor; id: string }> {
  const as = await h.user();
  const id = ok(await as.c.post('/v1/me/data-requests', { request_type: type }), 'dsr.create').id as string;
  if (status === 'received') return { as, id };
  const support = await h.staff('platform_support');
  for (const s of ['verifying_identity', 'in_progress'])
    ok(await support.c.post(`/v1/admin/data-requests/${id}/status`, { status: s, reason: REASON }, purpose('dsr', id)), `dsr ${s}`);
  if (status === 'completed') {
    ok(await support.c.post(`/v1/admin/data-requests/${id}/export`, { reason: REASON }, purpose('dsr', id)), 'dsr export');
    await h.infra.jobs.idle();
    ok(
      await support.c.post(`/v1/admin/data-requests/${id}/status`, { status: 'completed', reason: REASON }, purpose('dsr', id)),
      'dsr completed',
    );
  }
  return { as, id };
}

export const resolvers: Resolvers = {
  // ------------------------------------------------------------ §6.2 authorization server
  'auth.discovery': async () => ({ as: none, client: null }),
  'auth.jwks': async () => ({ as: none, client: null, check: (res) => expect(res.body.keys[0].d).toBeUndefined() }),
  'auth.authorize': async () => ({ as: none, client: null, query: authorizeQuery(pkce()) }),
  'auth.token': async () => ({ as: none, body: { grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-mobile' } }),
  'auth.revoke': async (h) => {
    const t = ok(
      await h.auth.request<Json>({
        method: 'POST',
        path: '/oauth/token',
        body: new URLSearchParams({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-mobile' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
      'anonymous token',
    );
    return { as: none, body: { token: t.access_token as string, token_type_hint: 'access_token' } };
  },
  'auth.pow_challenge': async () => ({ as: none, body: { purpose: 'signup' } }),
  'auth.signup': async (h) => {
    const ia = await interaction(h);
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: {
        interaction_id: ia.id,
        full_name: 'Sara Example',
        email: `sweep-${h.newId()}@test.carpal.app`,
        password: PASSWORD,
        locale: 'fa',
        terms_version: '1.0',
        privacy_policy_version: '1.0',
      },
      check: (res) => expect(res.body).toEqual({ next: 'verify_email' }),
    };
  },
  'auth.signin_password': async (h) => {
    const user = await h.fx.user();
    await h.fx.withPassword(user, PASSWORD);
    const ia = await interaction(h);
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: { interaction_id: ia.id, email: user.email, password: PASSWORD },
      check: (res) => expect(res.body).toEqual({ next: 'complete' }),
    };
  },
  'auth.otp_start': async (h) => {
    const user = await h.fx.user();
    const ia = await interaction(h);
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: { interaction_id: ia.id, channel: 'email', destination: user.email, purpose: 'signin' },
    };
  },
  'auth.otp_verify': async (h) => {
    const user = await h.fx.user();
    const ia = await interaction(h);
    ok(
      await authPost(h, '/v1/auth/otp/start', ia.cookie, {
        interaction_id: ia.id,
        channel: 'email',
        destination: user.email,
        purpose: 'signin',
      }),
      'otp start',
    );
    const code = h.auth.mail(user.email, 'identity.otp_code').at(-1)!.variables.code!;
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: { interaction_id: ia.id, code },
      check: (res) => expect(res.body).toEqual({ next: 'complete' }),
    };
  },
  'auth.webauthn_options': async (h) => {
    const ia = await interaction(h);
    return { as: none, headers: { cookie: ia.cookie }, body: { interaction_id: ia.id, purpose: 'signin' } };
  },
  'auth.mfa_verify': async (h) => {
    const t = await totpUser(h);
    const ia = await interaction(h);
    ok(await authPost(h, '/v1/auth/signin', ia.cookie, { interaction_id: ia.id, email: t.as.user.email, password: PASSWORD }), 'signin');
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: { interaction_id: ia.id, method: 'totp_mfa', code: hotp(t.secret, totpStep() + 1) },
      check: (res) => expect(res.body).toEqual({ next: 'complete' }),
    };
  },
  'auth.social_start': async (h) => {
    const ia = await interaction(h);
    // Deferred post-MVP (OQ-06, PM-01): the route answers 501 NOT_IMPLEMENTED before input validation (GD-05).
    return {
      as: none,
      headers: { cookie: ia.cookie },
      body: { interaction_id: ia.id, provider: 'google' },
      status: 501,
      negatives: 'deferred post-MVP (PM-01): 501 is answered before input validation (GD-05)',
    };
  },
  'auth.email_verify': async (h) => {
    const ia = await interaction(h);
    const email = `sweep-${h.newId()}@test.carpal.app`;
    ok(
      await authPost(h, '/v1/auth/signup', ia.cookie, {
        interaction_id: ia.id,
        full_name: 'Sara Example',
        email,
        password: PASSWORD,
        locale: 'en',
        terms_version: '1.0',
        privacy_policy_version: '1.0',
      }),
      'signup',
    );
    return { as: none, body: { token: h.auth.mail(email, 'identity.email_verification').at(-1)!.variables.link!.split('#')[1]! } };
  },
  'auth.password_reset_start': async (h) => ({ as: none, body: { email: (await h.fx.user()).email } }),
  'auth.password_reset_complete': async (h) => {
    const user = await h.fx.user();
    await h.fx.withPassword(user, PASSWORD);
    ok(await h.auth.request({ method: 'POST', path: '/v1/auth/password-reset', body: { email: user.email } }), 'reset start');
    const link = h.auth.mail(user.email, 'identity.password_reset').at(-1)!.variables.link!;
    return { as: none, body: { token: link.split('#')[1]!, new_password: 'a brand new passphrase' } };
  },

  // ------------------------------------------------------------ §6.3 account
  'me.get': async (h) => {
    const as = await h.user();
    return { as, check: (res) => expect(res.body).toMatchObject({ id: as.user.id, email: as.user.email }) };
  },
  'me.update': async (h) => {
    const as = await h.user();
    const me = ok(await as.c.get('/v1/me'), 'me');
    return { as, version: me.version as number, body: { full_name: 'Reza Example', display_name: 'Reza', timezone: 'Asia/Tehran' } };
  },
  'me.email_change': async (h) => ({ as: await h.user(), body: { new_email: `new-${h.newId()}@test.carpal.app` } }),
  'me.phone_change_start': async (h) => ({
    as: await h.user(),
    body: { phone: `+98912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` },
  }),
  'me.phone_change_verify': async (h) => {
    const as = await h.user();
    const phone = `+98912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    ok(await as.c.post('/v1/me/phone-change', { phone }), 'phone change');
    return { as, body: { code: h.api.sms(phone).at(-1)!.variables.code! } };
  },
  'me.password_change': async (h) => {
    const as = await h.user();
    await h.fx.withPassword(as.user, 'the current passphrase');
    return { as, body: { current_password: 'the current passphrase', new_password: 'a new long passphrase' } };
  },
  'me.preferences_get': async (h) => ({ as: await h.user() }),
  'me.preferences_update': async (h) => {
    const as = await h.user();
    const prefs = ok(await as.c.get('/v1/me/preferences'), 'preferences');
    return { as, version: prefs.version as number, body: { distance_unit: 'km', navigation_app_key: 'neshan' } };
  },
  'me.memberships_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'me.membership_leave': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const m = (ok(await as.c.get('/v1/me/memberships'), 'memberships').items as Json[]).find((x) => x.organization?.id === as.org!.id)!;
    return { as, params: { membership_id: m.id as string } };
  },
  'me.sessions_list': async (h) => ({ as: await h.user() }),
  'me.session_revoke': async (h) => {
    const as = await h.user();
    await h.fx.token(as.user);
    const other = (ok(await as.c.get('/v1/me/sessions'), 'sessions').items as Json[]).find((s) => !s.current)!;
    return { as, params: { session_id: other.id as string } };
  },
  'me.sessions_revoke_all': async (h) => {
    const as = await h.user();
    await h.fx.token(as.user);
    return { as, body: { keep_current: true } };
  },
  'me.mfa_list': async (h) => ({ as: (await totpUser(h)).as }),
  'me.mfa_totp_enroll': async (h) => ({
    as: await h.user(),
    body: { label: 'Authy' },
    check: (res) => expect(res.body.method.status).toBe('pending'),
  }),
  'me.webauthn_register_options': async (h) => ({ as: await h.user(), body: { label: 'My security key' } }),
  'me.mfa_confirm': async (h) => {
    const as = await h.user();
    const enrol = ok(await as.c.post('/v1/me/mfa-methods/totp', { label: 'Phone' }), 'totp enrol');
    const secret = base32Decode(new URL(enrol.otpauth_uri as string).searchParams.get('secret')!);
    return {
      as,
      params: { method_id: enrol.method.id as string },
      body: { code: hotp(secret, totpStep()) },
      check: (res) => expect(res.body.recovery_codes).toHaveLength(10),
    };
  },
  'me.mfa_remove': async (h) => {
    const t = await totpUser(h);
    return { as: t.as, params: { method_id: t.methodId } };
  },
  'me.recovery_codes_regenerate': async (h) => ({ as: (await totpUser(h)).as }),

  // ------------------------------------------------------------ §6.4 consents
  'consents.list': async (h) => {
    const as = await h.user();
    ok(await as.c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '2026-10' }), 'consent');
    return { as, query: { active: true } };
  },
  'consents.grant': async (h) => ({ as: await h.user(), body: { consent_type: 'marketing', policy_version: '2026-10' } }),
  'consents.withdraw': async (h) => {
    const as = await h.user();
    const g = ok(await as.c.post('/v1/me/consents', { consent_type: 'marketing', policy_version: '2026-10' }), 'consent');
    return { as, params: { consent_id: g.id as string } };
  },
  'consents.request_view': async (h) => {
    const as = await h.user();
    // A link sent to someone else: 403 LINK_RECIPIENT_MISMATCH for any other signed-in user.
    return { as, body: { token: await consentRequest(h, as) }, bola: { attackers: [await h.stranger()], expect: [403] } };
  },
  'consents.request_respond': async (h) => {
    const as = await h.user();
    return {
      as,
      body: { token: await consentRequest(h, as), decision: 'grant', policy_version: '2026-10' },
      bola: { attackers: [await h.stranger()], expect: [403] },
    };
  },
  'org.consents_list': async (h) => {
    const owner = await h.member('fleet');
    ok(await owner.c.post(`/v1/orgs/${owner.org!.id}/consents`, { consent_type: 'fleet_data_ai_use', policy_version: '1' }), 'org consent');
    return { as: await h.colleague(owner, 'fleet_viewer'), check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'org.consents_grant': async (h) => ({ as: await h.member('fleet'), body: { consent_type: 'fleet_data_ai_use', policy_version: '1' } }),
  'org.consents_withdraw': async (h) => {
    const owner = await h.member('fleet');
    const g = ok(
      await owner.c.post(`/v1/orgs/${owner.org!.id}/consents`, { consent_type: 'fleet_data_ai_use', policy_version: '1' }),
      'org consent',
    );
    return { as: owner, params: { consent_id: g.id as string } };
  },

  // ------------------------------------------------------------ §6.5 data subject requests
  'dsr.create': async (h) => ({ as: await h.user(), body: { request_type: 'export' } }),
  'dsr.list': async (h) => ({ as: (await dsr(h, 'export', 'received')).as }),
  'dsr.get': async (h) => {
    const d = await dsr(h, 'export', 'received');
    return { as: d.as, params: { request_id: d.id } };
  },
  'dsr.export_download': async (h) => {
    const d = await dsr(h, 'export', 'completed');
    return { as: d.as, params: { request_id: d.id } };
  },

  // ------------------------------------------------------------ §6.6 onboarding
  'onboarding.list': async (h) => {
    const as = await h.user();
    await h.api.request({
      method: 'PUT',
      path: '/v1/me/onboarding/individual',
      token: as.token,
      body: { current_step: 'add_vehicle' },
      headers: { 'if-match': '"v1"' },
    });
    return { as };
  },
  'onboarding.update': async (h) => ({
    as: await h.user(),
    params: { flow_type: 'individual' },
    version: 1,
    body: { current_step: 'add_vehicle', completed_step: 'profile' },
  }),
  'onboarding.accept_terms': async (h) => {
    const as = await h.user();
    const staff = await h.fx.staff('platform_support');
    await h.sys((db) =>
      db
        .insertInto('identity.onboarding_progress')
        .values({ user_id: as.user.id, flow_type: 'provider', current_step: 'services', assisted: true, assisted_by_user_id: staff.id })
        .execute(),
    );
    return { as, params: { flow_type: 'provider' }, body: { terms_version: 'b2b-1.0' } };
  },

  // ------------------------------------------------------------ §23.2 user administration
  'admin.users_search': async (h) => {
    const target = await h.fx.user();
    const caseId = await openCase(h.api, { targetId: target.id });
    return { as: await h.staff('platform_support'), headers: purpose('case', caseId), body: { email: target.email.toUpperCase() } };
  },
  'admin.user_get': async (h) => {
    const target = await h.fx.user();
    const caseId = await openCase(h.api, { targetId: target.id });
    // SEC-OUT-1: the staff view carries no credential references or hashes (projection scan).
    return { as: await h.staff('platform_moderator'), params: { user_id: target.id }, headers: purpose('case', caseId) };
  },
  'admin.user_status': async (h) => ({
    as: await h.staff('platform_moderator'),
    params: { user_id: (await h.fx.user()).id },
    body: { status: 'suspended', reason: REASON },
  }),
  'admin.user_sessions_revoke': async (h) => {
    const target = await h.user();
    return { as: await h.staff('platform_support'), params: { user_id: target.user.id }, body: { reason: REASON } };
  },
  'admin.platform_role_grant': async (h) => ({
    as: await h.staff('platform_admin'),
    params: { user_id: (await h.fx.user()).id },
    body: { role: 'platform_support', reason: REASON },
    check: (res) => h.rejectChange(res.body.change_id as string),
  }),
  'admin.platform_role_revoke': async (h) => {
    const target = await h.fx.staff('platform_support');
    return {
      as: await h.staff('platform_admin'),
      params: { user_id: target.id, role: 'platform_support' },
      headers: { 'carpal-reason': 'Role no longer needed' },
    };
  },
  'admin.onboarding_reset': async (h) => {
    const target = await h.user();
    ok(
      await h.api.request({
        method: 'PUT',
        path: '/v1/me/onboarding/individual',
        token: target.token,
        body: { current_step: 'add_vehicle', completed_step: 'profile' },
        headers: { 'if-match': '"v1"' },
      }),
      'onboarding',
    );
    return {
      as: await h.staff('platform_support'),
      params: { user_id: target.user.id, flow_type: 'individual' },
      body: { reason: REASON },
    };
  },
  'admin.dsr_queue': async (h) => {
    await dsr(h, 'export', 'received');
    return { as: await h.staff('platform_support'), query: { status: 'received', limit: 10 } };
  },
  'admin.dsr_update': async (h) => {
    const d = await dsr(h, 'export', 'received');
    return {
      as: await h.staff('platform_support'),
      params: { request_id: d.id },
      headers: purpose('dsr', d.id),
      body: { status: 'verifying_identity', reason: REASON },
    };
  },
  'admin.dsr_export': async (h) => {
    const d = await dsr(h, 'export', 'in_progress');
    return { as: await h.staff('platform_support'), params: { request_id: d.id }, headers: purpose('dsr', d.id), body: { reason: REASON } };
  },
  'admin.dsr_execute_deletion': async (h) => {
    const d = await dsr(h, 'deletion', 'in_progress');
    return {
      as: await h.staff('platform_admin'),
      params: { request_id: d.id },
      headers: purpose('dsr', d.id),
      body: { reason: REASON },
      check: (res) => h.rejectChange(res.body.change_id as string),
    };
  },
};
