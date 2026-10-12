// S6 notifications (40 §20; W5): in-app notifications from routed events
// (personal, and portal notifications only with organization_id for
// members), read marks, preferences (marketing consent, digests, defaults),
// push tokens (encrypted, refreshed, revoked; business pushes reach portal
// web tokens only) and EN/FA rendering of emails.
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilePushSender } from '#libs/infra/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { NotificationDispatcher } from '#modules/notification/application/dispatcher.js';
import type { Json } from './s4-support.js';
import { client, newId } from './s5-support.js';
import { flush } from './s6-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  worker = await createTestWorker({ infra: app.infra });
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

async function emit(type: string, aggregateType: string, aggregateId: string, payload: Json): Promise<void> {
  await app.fixtures.worker.run({ actorType: 'system' }, (scope) => publishEvent(scope, { type, aggregateType, aggregateId, payload }));
  await flush(app, worker);
}

async function newUser(locale: 'en' | 'fa' = 'en') {
  const user = await app.fixtures.user({ locale });
  const token = await app.fixtures.token(user);
  return { user, token, c: client(app, token) };
}

const reminder = (userId: string, o: Json = {}) => ({
  vehicle_id: newId(),
  status: 'due',
  reminder_type: 'oil_change',
  owner_type: 'user',
  owner_id: userId,
  ...o,
});

describe('in-app notifications (40 §20.2)', () => {
  it('turns a due reminder into a notification and an email; counts, lists and marks read', async () => {
    const u = await newUser();
    const reminderId = newId();
    await emit('vehicle.reminder.due', 'maintenance_reminder', reminderId, reminder(u.user.id));
    const list = await u.c.get('/v1/me/notifications');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      event_type: 'service_reminder',
      category: 'service_reminders',
      priority: 'normal',
      template_key: 'vehicle.reminder_due',
      template_params: { reminder_type: 'oil_change', status: 'due' },
      locale: 'en',
      organization_context_id: null,
      reference: { type: 'maintenance_reminder', id: reminderId },
      read_at: null,
    });
    const mail = app.mail(u.user.email, 'vehicle.reminder_due');
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ subject: 'Your car needs attention', text: expect.stringContaining('oil_change') });
    expect((await u.c.get('/v1/me/notifications/unread-count')).body).toEqual({ count: 1 });
    expect((await u.c.post('/v1/me/notifications/read', { ids: [list.body.items[0].id], up_to: new Date().toISOString() })).status).toBe(
      422,
    );
    expect((await u.c.post('/v1/me/notifications/read', {})).status).toBe(422);
    expect((await u.c.post('/v1/me/notifications/read', { ids: [list.body.items[0].id] })).body).toEqual({ ok: true });
    expect((await u.c.get('/v1/me/notifications/unread-count')).body).toEqual({ count: 0 });
    expect((await u.c.get('/v1/me/notifications?unread_only=true')).body.items).toEqual([]);
    // Another user sees none of it (RLS recipient_all).
    expect((await (await newUser()).c.get('/v1/me/notifications')).body.items).toEqual([]);
  });

  it("renders the email in the recipient's language and keeps the welcome and security notices in the app", async () => {
    const fa = await newUser('fa');
    await emit('vehicle.reminder.due', 'maintenance_reminder', newId(), reminder(fa.user.id));
    expect(app.mail(fa.user.email, 'vehicle.reminder_due')[0]!.subject).toBe('خودروی شما نیاز به رسیدگی دارد');
    await emit('user.registered', 'user', fa.user.id, {});
    await emit('user.security_alert', 'user', fa.user.id, { user_id: fa.user.id, kind: 'refresh_token_reuse' });
    const items = (await fa.c.get('/v1/me/notifications')).body.items as Json[];
    expect(items.map((i) => i.template_key)).toEqual(expect.arrayContaining(['system.welcome', 'system.security_alert']));
    expect(items.find((i) => i.template_key === 'system.security_alert')).toMatchObject({ priority: 'critical', category: 'system' });
    expect(app.mail(fa.user.email, 'system.welcome')).toEqual([]);
  });

  it('shows portal notifications only with organization_id, to members, and pushes them to web tokens only', async () => {
    const { user, org, token } = await app.fixtures.memberOf('vendor', 'vendor_owner');
    const c = client(app, token);
    const web = await c.post('/v1/me/push-tokens', { platform: 'web', token: `web-${newId()}-token`, app_version: '1.0.0' });
    const ios = await c.post('/v1/me/push-tokens', { platform: 'ios', token: `ios-${newId()}-token` });
    expect(web.status).toBe(201);
    const inquiryId = newId();
    await emit('inquiry.sent', 'stock_inquiry', inquiryId, {
      vendor_organization_id: org.id,
      inventory_item_id: newId(),
      requester_type: 'user',
    });
    expect((await c.get('/v1/me/notifications')).body.items).toEqual([]);
    const portal = await c.get(`/v1/me/notifications?organization_id=${org.id}`);
    expect(portal.body.items).toHaveLength(1);
    expect(portal.body.items[0]).toMatchObject({
      event_type: 'inquiry_received',
      organization_context_id: org.id,
      reference: { type: 'stock_inquiry', id: inquiryId },
    });
    expect((await c.get(`/v1/me/notifications/unread-count?organization_id=${org.id}`)).body).toEqual({ count: 1 });
    const pushed = (app.infra.push as FilePushSender).sent.filter((p) => p.data?.notification_id === portal.body.items[0].id);
    expect(pushed.map((p) => p.deviceTokenId)).toEqual([web.body.push_token_id]);
    expect(pushed.map((p) => p.deviceTokenId)).not.toContain(ios.body.push_token_id);
    expect(JSON.stringify(pushed)).not.toContain('-token');
    // Not a member: the organization filter is refused.
    const outsider = await newUser();
    expect((await outsider.c.get(`/v1/me/notifications?organization_id=${org.id}`)).status).toBe(404);
    expect(user.id).toBeTruthy();
  });
});

describe('preferences (40 §20.2)', () => {
  it('lists defaults, refuses marketing without consent, and applies opt-outs and daily digests', async () => {
    const u = await newUser();
    const defaults = await u.c.get('/v1/me/notification-preferences');
    expect(defaults.body.items).toHaveLength(44);
    expect(defaults.body.items).toContainEqual({ channel: 'email', category: 'marketing', enabled: false, frequency: 'immediate' });
    const marketing = await u.c.put('/v1/me/notification-preferences', {
      items: [{ channel: 'email', category: 'marketing', enabled: true, frequency: 'immediate' }],
    });
    expect(marketing.status).toBe(403);
    expect(marketing.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'marketing' });
    const dup = { channel: 'email', category: 'service_reminders', enabled: false, frequency: 'immediate' };
    expect((await u.c.put('/v1/me/notification-preferences', { items: [dup, dup] })).status).toBe(422);
    expect(
      (
        await u.c.put('/v1/me/notification-preferences', {
          items: [{ channel: 'push', category: 'inquiries', enabled: true, frequency: 'daily_digest' }],
        })
      ).status,
    ).toBe(422);

    const digest = await u.c.put('/v1/me/notification-preferences', {
      items: [{ channel: 'email', category: 'service_reminders', enabled: true, frequency: 'daily_digest' }],
    });
    expect(digest.status).toBe(200);
    expect(digest.body.items).toContainEqual({ channel: 'email', category: 'service_reminders', enabled: true, frequency: 'daily_digest' });
    await emit('vehicle.reminder.due', 'maintenance_reminder', newId(), reminder(u.user.id));
    expect(app.mail(u.user.email, 'vehicle.reminder_due')).toEqual([]);
    const dispatcher = worker.get(NotificationDispatcher, { strict: false });
    await dispatcher.sendDigests(new Date(Date.now() + 25 * 3_600_000));
    const sent = app.mail(u.user.email, 'notification.digest');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Your car needs attention');

    // Opt-out: no email, the in-app notification stays.
    await u.c.put('/v1/me/notification-preferences', {
      items: [{ channel: 'email', category: 'service_reminders', enabled: false, frequency: 'immediate' }],
    });
    await emit('vehicle.reminder.due', 'maintenance_reminder', newId(), reminder(u.user.id, { status: 'overdue' }));
    expect(app.mail(u.user.email, 'vehicle.reminder_due')).toEqual([]);
    expect((await u.c.get('/v1/me/notifications')).body.items).toHaveLength(2);
  });
});

describe('push tokens (40 §20.2)', () => {
  it("registers once per device (encrypted), refreshes, and revokes only the caller's own token", async () => {
    const u = await newUser();
    const raw = `fcm-${newId()}-device`;
    const first = await u.c.post('/v1/me/push-tokens', { platform: 'android', token: raw, locale: 'fa' });
    expect(first.status).toBe(201);
    const again = await u.c.post('/v1/me/push-tokens', { platform: 'android', token: raw, app_version: '2.0.0' });
    expect(again.body.push_token_id).toBe(first.body.push_token_id);
    const stored = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('notification.push_device_tokens')
        .select(['token_encrypted', 'app_version'])
        .where('id', '=', first.body.push_token_id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.app_version).toBe('2.0.0');
    expect(Buffer.from(stored.token_encrypted).toString('utf8')).not.toContain(raw);
    expect((await (await newUser()).c.del(`/v1/me/push-tokens/${first.body.push_token_id}`)).status).toBe(404);
    expect((await u.c.del(`/v1/me/push-tokens/${first.body.push_token_id}`)).body).toEqual({ ok: true });
    expect((await u.c.del(`/v1/me/push-tokens/${first.body.push_token_id}`)).status).toBe(404);
  });
});
