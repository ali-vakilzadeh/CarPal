// Contract sweep resolvers: reports and the admin plane's own operations
// (40 §22-§23): moderation cases (purpose-bound), feature flags, retention,
// four-eyes changes and assisted onboarding sessions. Four-eyes requests are
// rejected again by a second admin so no pending change outlives the sweep.
import { sql } from 'kysely';
import { expect } from 'vitest';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import { purpose, REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

/** A device-bound key registered by the staff member themselves (backend S16a). */
async function addKey(as: Actor, label: string): Promise<Json> {
  const options = ok(await as.c.post('/v1/admin/me/passkeys/options', { label }), 'passkey options');
  return ok(
    await as.c.post('/v1/admin/me/passkeys', {
      attestation: new SoftAuthenticator('carpals.ir', 'https://admin.carpals.ir').register(options),
    }),
    'passkey register',
  );
}

/** A report about a new user and the moderation case opened from it. */
async function userCase(h: Harness, mod: Actor): Promise<{ target: Actor; reportId: string; caseId: string }> {
  const target = await h.user();
  const reporter = await h.user();
  const rep = ok(await reporter.c.post('/v1/reports', { target_type: 'user', target_id: target.user.id, reason: 'harassment' }), 'report');
  const triaged = ok(
    await mod.c.post(`/v1/admin/reports/${rep.report_id}/triage`, { open_case: { severity: 'medium' }, reason: REASON }),
    'triage',
  );
  return { target, reportId: rep.report_id as string, caseId: triaged.moderation_case_id as string };
}

async function openReport(h: Harness): Promise<string> {
  const target = await h.user();
  const reporter = await h.user();
  return ok(
    await reporter.c.post('/v1/reports', {
      target_type: 'user',
      target_id: target.user.id,
      reason: 'spam',
      details: 'Sends the same message to everyone',
    }),
    'report',
  ).report_id as string;
}

export const resolvers: Resolvers = {
  'reports.create': async (h) => {
    const target = await h.user();
    return {
      as: await h.user(),
      body: { target_type: 'user', target_id: target.user.id, reason: 'harassment', details: 'Insults in comments' },
    };
  },
  'admin.assist_session_start': async (h) => {
    const org = await h.fx.org('provider');
    return { as: await h.staff('platform_support'), params: { org_id: org.id }, body: { flow_type: 'provider', reason: REASON } };
  },
  'admin.assist_session_end': async (h) => {
    const as = await h.staff('platform_support');
    const org = await h.fx.org('provider');
    const s = ok(await as.c.post(`/v1/admin/orgs/${org.id}/assist-sessions`, { flow_type: 'provider', reason: REASON }), 'assist session');
    return { as, params: { assist_session_id: s.assist_session_id as string }, body: { reason: REASON } };
  },
  'admin.reports_list': async (h) => {
    await openReport(h);
    return { as: await h.staff('platform_moderator'), query: { status: 'open', limit: 10 } };
  },
  'admin.report_triage': async (h) => ({
    as: await h.staff('platform_moderator'),
    params: { report_id: await openReport(h) },
    body: { open_case: { severity: 'low' }, reason: REASON },
  }),
  'admin.cases_list': async (h) => ({ as: await h.staff('platform_moderator'), query: { status: 'open', limit: 10 } }),
  'admin.case_get': async (h) => {
    const mod = await h.staff('platform_moderator');
    const c = await userCase(h, mod);
    return {
      as: mod,
      params: { case_id: c.caseId },
      headers: purpose('case', c.caseId),
      check: (res) => expect(res.body.case.status).toBe('open'),
    };
  },
  'admin.case_assign': async (h) => {
    const mod = await h.staff('platform_moderator');
    const c = await userCase(h, mod);
    return { as: mod, params: { case_id: c.caseId }, body: { reason: REASON } };
  },
  'admin.case_action': async (h) => {
    const mod = await h.staff('platform_moderator');
    const c = await userCase(h, mod);
    return {
      as: mod,
      params: { case_id: c.caseId },
      headers: purpose('case', c.caseId),
      body: { action_type: 'suspend_account', reason: REASON },
      check: async () => {
        const [u] = await h.q<{ status: string }>(sql`SELECT status FROM identity.user_accounts WHERE id = ${c.target.user.id}::uuid`);
        expect(u!.status).toBe('suspended');
      },
    };
  },
  'admin.case_close': async (h) => {
    const mod = await h.staff('platform_moderator');
    const c = await userCase(h, mod);
    return { as: mod, params: { case_id: c.caseId }, body: { status: 'dismissed', resolution: 'No breach found', reason: REASON } };
  },
  'admin.staff_me': async (h) => ({ as: await h.staff('platform_community_reviewer') }),
  // Contract 1.4.0 (backend S13): staff directory, region settings, badges and admin jobs.
  'admin.staff_list': async (h) => {
    await h.fx.staff('platform_moderator');
    return {
      as: await h.staff('platform_admin'),
      query: { status: 'active', limit: 10 },
      check: (res) => expect((res.body.items as Json[])[0]).toHaveProperty('email_masked'),
    };
  },
  'admin.staff_disable': async (h) => {
    const target = await h.fx.staff('platform_support');
    return {
      as: await h.staff('platform_admin'),
      params: { user_id: target.id },
      body: { reason: REASON },
      check: (res) => expect(res.body).toMatchObject({ status: 'disabled', platform_roles: ['platform_support'] }),
    };
  },
  'admin.staff_enable': async (h) => {
    const target = await h.fx.staff('platform_support');
    const as = await h.staff('platform_admin');
    ok(await as.c.post(`/v1/admin/staff/${target.id}/disable`, { reason: REASON }), 'disable');
    return { as, params: { user_id: target.id }, body: { reason: REASON }, check: (res) => h.rejectChange(res.body.change_id as string) };
  },
  // Contract 1.4.0 (backend S16a): the caller's own keys and recovery codes.
  'admin.staff_passkeys_list': async (h) => {
    const as = await h.staff('platform_support');
    await addKey(as, 'Desk key');
    return { as, check: (res) => expect(res.body.passkeys).toHaveLength(1) };
  },
  'admin.staff_passkey_register_options': async (h) => ({ as: await h.staff('platform_moderator'), body: { label: 'Backup key' } }),
  'admin.staff_passkey_register': async (h) => {
    const as = await h.staff('platform_community_reviewer');
    const options = ok(await as.c.post('/v1/admin/me/passkeys/options', { label: 'Backup key' }), 'passkey options');
    return {
      as,
      body: { attestation: new SoftAuthenticator('carpals.ir', 'https://admin.carpals.ir').register(options) },
      check: (res) => expect(res.body).toMatchObject({ label: 'Backup key', device_bound: true }),
    };
  },
  'admin.staff_passkey_remove': async (h) => {
    const as = await h.staff('platform_moderator');
    const first = await addKey(as, 'Old key');
    await addKey(as, 'New key');
    return { as, params: { method_id: first.id as string } };
  },
  'admin.staff_recovery_codes_regenerate': async (h) => ({
    as: await h.staff('platform_admin'),
    check: (res) => expect(res.body.recovery_codes).toHaveLength(10),
  }),
  'admin.badges_list': async (h) => ({ as: await h.staff('platform_moderator'), query: { status: 'pending_approval', limit: 10 } }),
  'admin.region_settings': async (h) => ({
    as: await h.staff('platform_community_reviewer'),
    check: (res) => expect(res.body.location_check_threshold_m).toBeGreaterThan(0),
  }),
  'admin.job_get': async (h) => {
    const as = await h.staff('platform_support');
    const id = h.newId();
    await h.sys((db) =>
      db
        .insertInto('core.background_jobs')
        .values({ id, kind: 'data_export', owner_user_id: as.user.id, owning_module: 'identity', status: 'running', progress: 40 })
        .execute(),
    );
    return { as, params: { job_id: id }, check: (res) => expect(res.body).toMatchObject({ kind: 'data_export', progress: 40 }) };
  },
  'admin.flags_list': async (h) => ({ as: await h.staff('platform_admin'), query: { flag_type: 'release', limit: 100 } }),
  'admin.flag_update': async (h) => {
    const as = await h.staff('platform_admin');
    // featured.enabled stays off (switching it on needs four eyes): an immediate, harmless change.
    const flag = (ok(await as.c.get('/v1/admin/flags?flag_type=release&limit=100'), 'flags').items as Json[]).find(
      (f) => f.key === 'featured.enabled',
    )!;
    return { as, params: { key: 'featured.enabled' }, version: flag.version as number, body: { enabled: false, reason: REASON } };
  },
  'admin.exchange_rates_list': async (h) => ({ as: await h.staff('platform_admin') }),
  'admin.exchange_rate_update': async (h) => {
    const as = await h.staff('platform_admin');
    const rate = (ok(await as.c.get('/v1/admin/exchange-rates'), 'rates').items as Json[]).find((r) => r.currency === 'IRR')!;
    // The same rate again: an immediate change that leaves the shared database as it was.
    return { as, params: { currency: 'IRR' }, version: rate.version as number, body: { per_usd: rate.per_usd, reason: REASON } };
  },
  'admin.retention_list': async (h) => ({ as: await h.staff('platform_admin') }),
  'admin.retention_update': async (h) => {
    const as = await h.staff('platform_admin');
    const p = (ok(await as.c.get('/v1/admin/retention-policies?limit=100'), 'policies').items as Json[]).find(
      (r) => r.entity_type === 'Notification',
    )!;
    await h.expirePending(p.id as string);
    return {
      as,
      params: { policy_id: p.id as string },
      body: {
        entity_type: p.entity_type,
        applies_to_status: p.applies_to_status,
        retention_days: (p.retention_days as number) + 1,
        action: p.action,
        legal_basis: p.legal_basis,
        status: p.status,
        reason: REASON,
      },
      check: (res) => h.rejectChange(res.body.change_id as string),
    };
  },
  'admin.four_eyes_list': async (h) => ({ as: await h.staff('platform_admin'), query: { status: 'pending', limit: 10 } }),
  'admin.four_eyes_decide': async (h) => {
    const requester = await h.staff('platform_admin');
    const target = await h.user();
    const change = ok(
      await requester.c.post(`/v1/admin/users/${target.user.id}/platform-roles`, { role: 'platform_support', reason: REASON }),
      'role grant',
    );
    // The requester never decides their own change (403 SELF_APPROVAL_FORBIDDEN).
    const self = await requester.c.post(`/v1/admin/four-eyes/${change.change_id}/decision`, { decision: 'reject', reason: REASON });
    expect(self.status).toBe(403);
    return {
      as: await h.staff('platform_admin'),
      params: { change_id: change.change_id as string },
      body: { decision: 'reject', reason: 'Not needed after all' },
    };
  },
};
