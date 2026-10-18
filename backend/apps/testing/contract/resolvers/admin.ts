// Contract sweep resolvers: reports and the admin plane's own operations
// (40 §22-§23): moderation cases (purpose-bound), feature flags, retention,
// four-eyes changes and assisted onboarding sessions. Four-eyes requests are
// rejected again by a second admin so no pending change outlives the sweep.
import { sql } from 'kysely';
import { expect } from 'vitest';
import { purpose, REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

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
  'admin.flags_list': async (h) => ({ as: await h.staff('platform_admin'), query: { flag_type: 'release', limit: 100 } }),
  'admin.flag_update': async (h) => {
    const as = await h.staff('platform_admin');
    // featured.enabled stays off (switching it on needs four eyes): an immediate, harmless change.
    const flag = (ok(await as.c.get('/v1/admin/flags?flag_type=release&limit=100'), 'flags').items as Json[]).find(
      (f) => f.key === 'featured.enabled',
    )!;
    return { as, params: { key: 'featured.enabled' }, version: flag.version as number, body: { enabled: false, reason: REASON } };
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
