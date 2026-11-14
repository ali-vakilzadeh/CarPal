// S17 (contract 1.4.0; backend/BR-update-plan.json S17): notification templates and rules on the admin plane
// (BR-11, A-NOTIF-01, DQ-05), and the staff notices: the four-eyes outcome to the requester (BR-21), the AI kill
// switch to administrators (BR-26), staff account recovery and break glass to administrators (S16a-D6, S16b-D2).
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { AdminExpiryRule } from '#modules/admin/application/admin-rules.js';
import { InvitationRule, ReviewWorkflow } from '#modules/trust/application/review-workflow.js';
import type { Json } from './s4-support.js';
import { client } from './s5-support.js';
import { flush } from './s6-support.js';
import { REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let adminA: TestUser;
let a: StaffApi;
let adminB: TestUser;
let b: StaffApi;
let support: StaffApi;
let supportUser: TestUser;

const TEMPLATE = 'inventory.import_finished';
const ifMatch = (v: number) => ({ 'if-match': `"v${v}"` });

const sys = <T>(fn: (scope: TxScope) => Promise<T>): Promise<T> => api.fixtures.worker.run({ actorType: 'system' }, fn);

async function emit(type: string, aggregateType: string, aggregateId: string, payload: Json): Promise<void> {
  await sys((scope) => publishEvent(scope, { type, aggregateType, aggregateId, payload }));
  await flush(api, worker);
}

async function notices(c: StaffApi, eventType: string): Promise<Json[]> {
  const res = await c.get('/v1/admin/me/notifications?limit=100');
  expect(res.status, res.text).toBe(200);
  return (res.body.items as Json[]).filter((n) => n.event_type === eventType);
}

async function resetOverrides(): Promise<void> {
  await sys(({ db }) =>
    db
      .updateTable('notification.notification_template_overrides')
      .set({ deleted_at: new Date(), deletion_reason: 'S17 test cleanup' })
      .where('template_key', '=', TEMPLATE)
      .where('deleted_at', 'is', null)
      .execute(),
  );
}

async function defaultRules(): Promise<void> {
  await sys(({ db }) =>
    db
      .updateTable('notification.notification_rules')
      .set({
        review_invitation_delay_minutes: 0,
        review_invitation_reminder_days: [2, 5],
        default_quiet_hours_start: null,
        default_quiet_hours_end: null,
        digest_hour: 9,
        weekly_digest_day: 6,
      })
      .where('rule_set', '=', 'default')
      .execute(),
  );
}

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  const sa = await staff(admin, 'platform_admin');
  adminA = sa.user;
  a = sa.c;
  const sb = await staff(admin, 'platform_admin');
  adminB = sb.user;
  b = sb.c;
  const ss = await staff(admin, 'platform_support');
  supportUser = ss.user;
  support = ss.c;
  await resetOverrides();
  await defaultRules();
}, 60_000);

afterAll(async () => {
  await resetOverrides();
  await defaultRules();
  // The kill switch stays off for every other suite.
  await sys(({ db }) =>
    db.updateTable('admin.feature_flags').set({ enabled: false }).where('key', '=', 'ai.automation.kill_switch').execute(),
  );
  await worker?.close();
  await admin?.close();
  await api?.close();
});

describe('notification templates (A-NOTIF-01, DQ-05)', () => {
  it('lists the templates with variables, locks and translation flags', async () => {
    const res = await a.get(`/v1/admin/notification-templates?template_key=${TEMPLATE}`);
    expect(res.status, res.text).toBe(200);
    const items = res.body.items as Json[];
    expect(items.map((i) => `${i.channel}:${i.locale}`)).toEqual(['email:en', 'email:fa', 'push:en', 'push:fa']);
    expect(items[0]).toMatchObject({
      kind: 'notification',
      editable: true,
      always_delivered: false,
      source: 'code',
      subject: 'Inventory import finished',
      variables: ['created_count', 'error_count', 'updated_count'],
      missing_translation: false,
      translation_outdated: false,
      version: null,
    });
    const listed = await a.get('/v1/admin/notification-templates');
    expect(listed.status, listed.text).toBe(200);
    const all = listed.body.items as Json[];
    expect(all.find((i) => i.template_key === 'identity.password_reset')).toMatchObject({ kind: 'transactional', editable: false });
    expect(all.find((i) => i.template_key === 'system.security_alert')).toMatchObject({ always_delivered: true, editable: false });
    expect(all.find((i) => i.template_key === 'identity.otp_code' && i.channel === 'sms')).toMatchObject({ subject: null });
    // ADM only (BFLA): the admin plane answers 404 for operations outside the caller's roles.
    expect((await support.get('/v1/admin/notification-templates')).status).toBe(404);
  });

  it('refuses unknown placeholders, locked templates, unused channels and a subject on SMS', async () => {
    const path = `/v1/admin/notification-templates/${TEMPLATE}`;
    const bad = await a.put(path, { channel: 'email', locale: 'en', subject: 'Import', body: 'Done for {vin}.', reason: REASON });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([{ pointer: '/body', code: 'unknown_placeholder', limit: '{vin}' }]);
    const locked = await a.put('/v1/admin/notification-templates/system.security_alert', {
      channel: 'push',
      locale: 'en',
      subject: 'Alert',
      body: 'Check your sessions.',
      reason: REASON,
    });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    const sms = await a.put(path, { channel: 'sms', locale: 'en', body: 'x', reason: REASON });
    expect(sms.body.errors).toEqual([{ pointer: '/channel', code: 'enum' }]);
    const smsSubject = await a.put('/v1/admin/notification-templates/appointment.reminder', {
      channel: 'sms',
      locale: 'en',
      subject: 'No',
      body: 'Appointment at {confirmed_start_at}.',
      reason: REASON,
    });
    expect(smsSubject.body.errors).toEqual([{ pointer: '/subject', code: 'conditional_forbidden' }]);
    expect(
      (
        await a.put('/v1/admin/notification-templates/no.such_template', {
          channel: 'email',
          locale: 'en',
          subject: 'x',
          body: 'x',
          reason: REASON,
        })
      ).status,
    ).toBe(404);
  });

  it('overrides a text (If-Match once it exists), flags the other language, previews and sends it; reset returns the code text', async () => {
    const path = `/v1/admin/notification-templates/${TEMPLATE}`;
    const body = {
      channel: 'email',
      locale: 'en',
      subject: 'Import done: {created_count} new',
      body: 'New items: {created_count}. Errors: {error_count}.',
      reason: REASON,
    };
    expect((await a.put(path, body, ifMatch(1))).status).toBe(412);
    const first = await a.put(path, body);
    expect(first.status, first.text).toBe(200);
    expect(first.headers.etag).toBe('"v1"');
    expect(first.body).toMatchObject({ source: 'override', version: 1, subject: body.subject, updated_by_display: expect.any(String) });
    expect((await a.put(path, body)).status).toBe(428);
    const second = await a.put(path, { ...body, body: 'Created: {created_count}. Errors: {error_count}.' }, ifMatch(1));
    expect(second.status, second.text).toBe(200);
    expect(second.body.version).toBe(2);
    expect((await a.put(path, body, ifMatch(1))).status).toBe(412);

    const fa = (await a.get(`/v1/admin/notification-templates?template_key=${TEMPLATE}&channel=email&locale=fa`)).body.items as Json[];
    expect(fa[0]).toMatchObject({ source: 'code', translation_outdated: true });
    const missing = (await a.get(`/v1/admin/notification-templates?template_key=${TEMPLATE}&missing_only=true`)).body.items as Json[];
    expect(missing.map((i) => `${i.channel}:${i.locale}`)).toEqual(['email:fa']);

    const preview = await a.post(`${path}/preview`, { channel: 'email', locale: 'en', params: { created_count: 7 } });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body).toEqual({ subject: 'Import done: 7 new', body: 'Created: 7. Errors: [error_count].' });
    const draft = await a.post(`${path}/preview`, { channel: 'push', locale: 'en', subject: 'Done', body: 'Errors {error_count}' });
    expect(draft.body).toEqual({ subject: 'Done', body: 'Errors [error_count]' });
    expect((await a.post(`${path}/preview`, { channel: 'email', locale: 'en', subject: 'x', body: '{plate}' })).status).toBe(422);

    // The dispatcher renders the override (business notification of the vendor's importer).
    const u = await api.fixtures.user({ locale: 'en' });
    await emit('vendor.inventory.imported', 'inventory_import_batch', uuidv7(), {
      vendor_organization_id: uuidv7(),
      requested_by_user_id: u.id,
      created_count: 4,
      updated_count: 0,
      error_count: 1,
    });
    const mail = api.mail(u.email, TEMPLATE);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ subject: 'Import done: 4 new', text: 'Created: 4. Errors: 1.' });

    const reset = await a.post(`${path}/reset`, { channel: 'email', locale: 'en', reason: REASON }, ifMatch(1));
    expect(reset.status).toBe(412);
    const done = await a.post(`${path}/reset`, { channel: 'email', locale: 'en', reason: REASON }, ifMatch(2));
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ source: 'code', version: null, subject: 'Inventory import finished' });
    expect((await a.post(`${path}/reset`, { channel: 'email', locale: 'en', reason: REASON }, ifMatch(2))).status).toBe(404);
    // Audited with the reason.
    const audit = await sys(({ db }) =>
      db
        .selectFrom('analytics.audit_logs')
        .select(['action', 'reason'])
        .where('entity_type', '=', 'notification_template_override')
        .where('actor_id', '=', adminA.id)
        .where('reason', '=', REASON)
        .execute(),
    );
    expect(audit.map((x) => x.action).sort()).toEqual([
      'notification.template_overridden',
      'notification.template_overridden',
      'notification.template_reset',
    ]);
  });
});

describe('notification rules (A-NOTIF-01 Rules)', () => {
  it('reads and replaces the rules with If-Match; refuses unordered reminder days and an empty quiet window', async () => {
    const got = await a.get('/v1/admin/notification-rules');
    expect(got.status, got.text).toBe(200);
    expect(got.body).toMatchObject({
      review_invitation_delay_minutes: 0,
      review_invitation_reminder_days: [2, 5],
      default_quiet_hours: null,
      digest_hour: 9,
      weekly_digest_day: 6,
    });
    const v = got.body.version as number;
    const write = {
      review_invitation_delay_minutes: 60,
      review_invitation_reminder_days: [1, 3, 6],
      default_quiet_hours: null,
      digest_hour: 8,
      weekly_digest_day: 1,
      reason: REASON,
    };
    expect(
      (await a.put('/v1/admin/notification-rules', { ...write, review_invitation_reminder_days: [3, 1] }, ifMatch(v))).body.errors,
    ).toEqual([{ pointer: '/review_invitation_reminder_days/1', code: 'order' }]);
    expect(
      (await a.put('/v1/admin/notification-rules', { ...write, default_quiet_hours: { start: '22:00', end: '22:00' } }, ifMatch(v))).body
        .errors,
    ).toEqual([{ pointer: '/default_quiet_hours/end', code: 'order' }]);
    expect(
      (await a.put('/v1/admin/notification-rules', { ...write, review_invitation_reminder_days: [1, 2, 3, 4] }, ifMatch(v))).status,
    ).toBe(422);
    expect((await a.put('/v1/admin/notification-rules', write)).status).toBe(428);
    const saved = await a.put('/v1/admin/notification-rules', write, ifMatch(v));
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toMatchObject({
      review_invitation_reminder_days: [1, 3, 6],
      version: v + 1,
      updated_by_display: expect.any(String),
    });
    expect((await a.put('/v1/admin/notification-rules', write, ifMatch(v))).status).toBe(412);
    expect((await support.get('/v1/admin/notification-rules')).status).toBe(404);
  });

  it('the invitation sweep uses the reminder days; the invitation waits for the delay', async () => {
    await sys(({ db }) =>
      db
        .updateTable('notification.notification_rules')
        .set({ review_invitation_reminder_days: [1], review_invitation_delay_minutes: 60 })
        .where('rule_set', '=', 'default')
        .execute(),
    );
    const u = await api.fixtures.user({ locale: 'en' });
    const sentAt = new Date(Date.now() - 36 * 3_600_000);
    const id = uuidv7();
    await sys(({ db }) =>
      db
        .insertInto('trust.review_requests')
        .values({
          id,
          subject_organization_id: uuidv7(),
          appointment_id: uuidv7(),
          invited_user_id: u.id,
          channel: 'in_app',
          status: 'sent',
          sent_at: sentAt,
          expires_at: new Date(sentAt.getTime() + 7 * 86_400_000),
        })
        .execute(),
    );
    await worker.get(InvitationRule, { strict: false }).run(new Date());
    const row = await sys(({ db }) =>
      db.selectFrom('trust.review_requests').select(['status', 'reminder_count']).where('id', '=', id).executeTakeFirstOrThrow(),
    );
    // Day 1 (the rules), not day 2 (the code default before S17); and only one reminder is configured.
    expect(row).toEqual({ status: 'reminded', reminder_count: 1 });
    await worker.get(InvitationRule, { strict: false }).run(new Date());
    expect(
      (
        await sys(({ db }) =>
          db.selectFrom('trust.review_requests').select('reminder_count').where('id', '=', id).executeTakeFirstOrThrow(),
        )
      ).reminder_count,
    ).toBe(1);

    // A visit completed 10 minutes ago waits for the 60-minute delay (no invitation, no write).
    const workflow = worker.get(ReviewWorkflow, { strict: false });
    const visit = {
      id: uuidv7(),
      providerOrgId: uuidv7(),
      providerLocationId: null,
      requesterType: 'user' as const,
      requesterUserId: u.id,
      requesterOrgId: null,
      vehicleId: uuidv7(),
      serviceSystemNodeId: null,
      serviceTaskNodeId: null,
      status: 'completed',
      confirmedStartAt: new Date(Date.now() - 2 * 3_600_000),
      confirmedEndAt: null,
      completedAt: new Date(Date.now() - 10 * 60_000),
    };
    expect(await sys((scope) => workflow.inviteForAppointment(scope, visit))).toBe(false);
    await defaultRules();
  });

  it('holds push for accounts without quiet hours inside the platform default window', async () => {
    const u = await api.fixtures.user({ locale: 'en' });
    const c = client(api, await api.fixtures.token(u));
    expect((await c.post('/v1/me/push-tokens', { platform: 'android', token: `s17-${uuidv7()}-token` })).status).toBe(201);
    const tz = (
      await sys(({ db }) => db.selectFrom('identity.user_accounts').select('timezone').where('id', '=', u.id).executeTakeFirstOrThrow())
    ).timezone;
    const hhmm = (d: Date) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    await sys(({ db }) =>
      db
        .updateTable('notification.notification_rules')
        .set({
          default_quiet_hours_start: hhmm(new Date(Date.now() - 3_600_000)),
          default_quiet_hours_end: hhmm(new Date(Date.now() + 3_600_000)),
        })
        .where('rule_set', '=', 'default')
        .execute(),
    );
    await emit('vehicle.reminder.due', 'maintenance_reminder', uuidv7(), {
      vehicle_id: uuidv7(),
      status: 'due',
      reminder_type: 'oil_change',
      owner_type: 'user',
      owner_id: u.id,
    });
    const push = await sys(({ db }) =>
      db
        .selectFrom('notification.notification_deliveries as d')
        .innerJoin('notification.notifications as n', 'n.id', 'd.notification_id')
        .select(['d.status', 'd.not_before'])
        .where('n.recipient_user_id', '=', u.id)
        .where('d.channel', '=', 'push')
        .execute(),
    );
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe('queued');
    expect(push[0]!.not_before).not.toBeNull();
    await defaultRules();
  });
});

describe('staff notices (BR-21, BR-26, S16a-D6, S16b-D2)', () => {
  it('tells the requester the four-eyes outcome (rejected, and expired); lists, counts and marks read', async () => {
    const target = await api.fixtures.user();
    const req = await a.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_support', reason: REASON });
    expect(req.status, req.text).toBe(202);
    const changeId = req.body.change_id as string;
    expect((await b.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'reject', reason: REASON })).status).toBe(200);
    await flush(api, worker);
    const rejected = (await notices(a, 'four_eyes_outcome')).find((n) => (n.reference as Json | null)?.id === changeId);
    expect(rejected).toMatchObject({
      template_key: 'staff.four_eyes_outcome',
      template_params: { op_id: 'admin.platform_role_grant', status: 'rejected' },
      reference: { type: 'pending_change', id: changeId },
      read_at: null,
    });
    // The decider gets nothing.
    expect((await notices(b, 'four_eyes_outcome')).some((n) => (n.reference as Json | null)?.id === changeId)).toBe(false);

    const other = await api.fixtures.user();
    const late = await a.post(`/v1/admin/users/${other.id}/platform-roles`, { role: 'platform_support', reason: REASON });
    const lateId = late.body.change_id as string;
    await sys(({ db }) =>
      db
        .updateTable('admin.pending_admin_changes')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', lateId)
        .execute(),
    );
    await worker.get(AdminExpiryRule, { strict: false }).run();
    await flush(api, worker);
    const expired = (await notices(a, 'four_eyes_outcome')).find((n) => (n.reference as Json | null)?.id === lateId);
    expect(expired).toMatchObject({ template_params: { status: 'expired' } });

    const count = (await a.get('/v1/admin/me/notifications/unread-count')).body.count as number;
    expect(count).toBeGreaterThanOrEqual(2);
    expect((await a.post('/v1/admin/me/notifications/read', { ids: [rejected!.id] })).status).toBe(200);
    // Another member's ids are ignored.
    expect((await b.post('/v1/admin/me/notifications/read', { ids: [expired!.id] })).status).toBe(200);
    expect((await a.get('/v1/admin/me/notifications/unread-count')).body.count).toBe(count - 1);
    const unread = (await a.get('/v1/admin/me/notifications?unread_only=true&limit=100')).body.items as Json[];
    expect(unread.some((n) => n.id === rejected!.id)).toBe(false);
    expect(unread.some((n) => n.id === expired!.id)).toBe(true);
  });

  it('tells administrators when the AI kill switch is turned on or off; other staff are not told', async () => {
    const flag = ((await a.get('/v1/admin/flags?flag_type=kill_switch&limit=10')).body.items as Json[])[0]!;
    const on = await a.patch('/v1/admin/flags/ai.automation.kill_switch', { enabled: true, reason: REASON }, flag.version as number);
    expect(on.status, on.text).toBe(200);
    await flush(api, worker);
    const seen = await notices(b, 'ai_kill_switch_changed');
    expect(seen[0]).toMatchObject({ priority: 'critical', template_key: 'staff.kill_switch_changed', template_params: { enabled: 'on' } });
    expect(await notices(support, 'ai_kill_switch_changed')).toEqual([]);
    // Turning it off needs a second administrator; the approved change notifies again.
    const off = await a.patch('/v1/admin/flags/ai.automation.kill_switch', { enabled: false, reason: REASON }, on.body.version as number);
    expect(off.status, off.text).toBe(202);
    expect(
      (await b.post(`/v1/admin/four-eyes/${off.body.change_id as string}/decision`, { decision: 'approve', reason: REASON })).status,
    ).toBe(200);
    await flush(api, worker);
    const latest = (await notices(a, 'ai_kill_switch_changed'))[0];
    expect(latest).toMatchObject({ template_params: { enabled: 'off' } });
    expect((await notices(a, 'four_eyes_outcome'))[0]).toMatchObject({
      template_params: { op_id: 'admin.flag_update', status: 'approved' },
    });
  });

  it('tells every other administrator about recoveries and break glass, never the member', async () => {
    const member = await staff(admin, 'platform_admin');
    await emit('staff.recovery_requested', 'staff_recovery_request', uuidv7(), { user_id: member.user.id, staff_name: 'Mina Example' });
    await emit('staff.break_glass', 'user_account', member.user.id, { user_id: member.user.id, staff_name: 'Mina Example' });
    const alerts = await notices(a, 'staff_security_alert');
    expect(alerts.map((n) => n.template_key)).toEqual(expect.arrayContaining(['staff.recovery_waiting', 'staff.break_glass_notice']));
    expect(alerts.find((n) => n.template_key === 'staff.break_glass_notice')).toMatchObject({
      priority: 'critical',
      template_params: { staff_name: 'Mina Example' },
      reference: { type: 'user_account', id: member.user.id },
    });
    // Break glass ended the member's sessions (S16a): the database shows they got no notice about themselves.
    const own = await sys(({ db }) =>
      db
        .selectFrom('notification.notifications')
        .select('id')
        .where('recipient_user_id', '=', member.user.id)
        .where('event_type', '=', 'staff_security_alert')
        .execute(),
    );
    expect(own).toEqual([]);
    expect(await notices(support, 'staff_security_alert')).toEqual([]);
    expect(supportUser.id).not.toBe(adminB.id);
  });

  it('keeps staff notices off the api host', async () => {
    const u = await api.fixtures.user();
    await sys(({ db }) =>
      db
        .insertInto('notification.notifications')
        .values({
          recipient_user_id: u.id,
          event_type: 'four_eyes_outcome',
          category: 'system',
          template_key: 'staff.four_eyes_outcome',
          template_params: JSON.stringify({ op_id: 'x', status: 'approved' }),
          locale: 'en',
        })
        .execute(),
    );
    const c = client(api, await api.fixtures.token(u));
    expect((await c.get('/v1/me/notifications')).body.items).toEqual([]);
    expect((await c.get('/v1/me/notifications/unread-count')).body).toEqual({ count: 0 });
    // A consumer token never reaches the admin plane.
    expect((await client(admin, await api.fixtures.token(u)).get('/v1/admin/me/notifications')).status).toBeGreaterThanOrEqual(401);
  });
});
