// Contract sweep resolvers: notifications (40 §20) and the admin plane's templates, rules and staff notices (§23.5, S17).
import { expect } from 'vitest';
import { REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

/** An unread in-app notification of the actor (as W5 writes it). */
async function notification(h: Harness, as: Actor): Promise<string> {
  const id = h.newId();
  await h.sys((db) =>
    db
      .insertInto('notification.notifications')
      .values({
        id,
        recipient_user_id: as.user.id,
        event_type: 'system_announcement',
        category: 'system',
        template_key: 'system.announcement',
        template_params: {},
        locale: 'en',
      })
      .execute(),
  );
  return id;
}

/** An unread staff notice of the actor (S17, as W5 writes it). */
async function staffNotice(h: Harness, as: Actor): Promise<string> {
  const id = h.newId();
  await h.sys((db) =>
    db
      .insertInto('notification.notifications')
      .values({
        id,
        recipient_user_id: as.user.id,
        event_type: 'four_eyes_outcome',
        category: 'system',
        template_key: 'staff.four_eyes_outcome',
        template_params: { op_id: 'admin.flag_update', status: 'approved' },
        locale: 'en',
      })
      .execute(),
  );
  return id;
}

/** A fresh staff override of a template channel (any earlier one is reset first); returns its version. */
async function freshOverride(h: Harness, key: string, channel: string, locale: string): Promise<number> {
  await h.sys(async (db) => {
    await db
      .updateTable('notification.notification_template_overrides')
      .set({ deleted_at: new Date(), deletion_reason: 'contract sweep' })
      .where('template_key', '=', key)
      .where('channel', '=', channel)
      .where('locale', '=', locale)
      .where('deleted_at', 'is', null)
      .execute();
    await db
      .insertInto('notification.notification_template_overrides')
      .values({
        template_key: key,
        channel,
        locale,
        subject: channel === 'sms' ? null : 'Sweep subject',
        body: 'Sweep body',
        reason: REASON,
      })
      .execute();
  });
  return 1;
}

export const resolvers: Resolvers = {
  'notifications.list': async (h) => {
    const as = await h.user();
    await notification(h, as);
    return { as, query: { unread_only: true }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'notifications.unread_count': async (h) => {
    const as = await h.user();
    await notification(h, as);
    return { as, check: (res) => expect(res.body).toEqual({ count: 1 }) };
  },
  'notifications.mark_read': async (h) => {
    const as = await h.user();
    const id = await notification(h, as);
    // SEC-AZ-3: another user's ids are ignored (RLS recipient_all) — the notification stays unread.
    const stranger = await h.stranger();
    ok(await stranger.c.post('/v1/me/notifications/read', { ids: [id] }), 'stranger mark_read');
    expect((await as.c.get('/v1/me/notifications/unread-count')).body).toEqual({ count: 1 });
    return {
      as,
      body: { ids: [id] },
      bola: "checked in the resolver: ids outside the caller's notifications are ignored and stay unread (RLS recipient_all)",
    };
  },
  'notification_prefs.get': async (h) => ({ as: await h.user() }),
  'notification_prefs.put': async (h) => ({
    as: await h.user(),
    body: { items: [{ channel: 'email', category: 'service_reminders', enabled: true, frequency: 'daily_digest' }] },
  }),
  'push_tokens.register': async (h) => ({
    as: await h.user(),
    body: { platform: 'android', token: `sweep-${h.newId()}-token`, app_version: '1.0.0' },
  }),
  'push_tokens.revoke': async (h) => {
    const as = await h.user();
    const t = ok(await as.c.post('/v1/me/push-tokens', { platform: 'ios', token: `sweep-${h.newId()}-token` }), 'push token');
    return { as, params: { push_token_id: t.push_token_id as string } };
  },
  // Backend S17 (contract 1.4.0): notification templates and rules, staff notices on the admin plane.
  'admin.notif_templates_list': async (h) => ({
    as: await h.staff('platform_admin'),
    query: { template_key: 'inquiry.received', locale: 'fa' },
    check: (res) => expect((res.body.items as Json[]).map((i) => i.channel)).toEqual(['email', 'push']),
  }),
  'admin.notif_template_update': async (h) => {
    const as = await h.staff('platform_admin');
    const version = await freshOverride(h, 'inquiry.received', 'email', 'en');
    return {
      as,
      params: { template_key: 'inquiry.received' },
      version,
      body: {
        channel: 'email',
        locale: 'en',
        subject: 'New stock inquiry',
        body: 'A customer asked about an item. Answer it in CarPal.',
        reason: REASON,
      },
      bola: 'platform-wide templates: no owner other than the platform (BFLA covers the roles)',
    };
  },
  'admin.notif_template_reset': async (h) => {
    const as = await h.staff('platform_admin');
    const version = await freshOverride(h, 'inquiry.received', 'push', 'en');
    return {
      as,
      params: { template_key: 'inquiry.received' },
      version,
      body: { channel: 'push', locale: 'en', reason: REASON },
      bola: 'platform-wide templates: no owner other than the platform (BFLA covers the roles)',
      check: (res) => expect(res.body).toMatchObject({ source: 'code', version: null }),
    };
  },
  'admin.notif_template_preview': async (h) => ({
    as: await h.staff('platform_admin'),
    params: { template_key: 'inventory.import_finished' },
    body: { channel: 'email', locale: 'en', params: { created_count: 3 } },
    bola: 'platform-wide templates: no owner other than the platform (BFLA covers the roles)',
    check: (res) => expect(res.body.body).toContain('3 created'),
  }),
  'admin.notif_rules_get': async (h) => ({ as: await h.staff('platform_admin') }),
  'admin.notif_rules_update': async (h) => {
    const as = await h.staff('platform_admin');
    const rules = ok(await as.c.get('/v1/admin/notification-rules'), 'rules');
    // The same values again: the shared database keeps its rules.
    const { updated_by_display: _by, updated_at: _at, version, ...values } = rules;
    return { as, version: version as number, body: { ...values, reason: REASON }, bola: 'one platform-wide rule set' };
  },
  'admin.notifications_list': async (h) => {
    const as = await h.staff('platform_moderator');
    await staffNotice(h, as);
    return { as, query: { unread_only: true }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'admin.notifications_unread_count': async (h) => {
    const as = await h.staff('platform_support');
    await staffNotice(h, as);
    return { as, check: (res) => expect(res.body).toEqual({ count: 1 }) };
  },
  'admin.notifications_mark_read': async (h) => {
    const as = await h.staff('platform_community_reviewer');
    const id = await staffNotice(h, as);
    return {
      as,
      body: { ids: [id] },
      bola: "ids outside the caller's notices are ignored (recipient filter); s17.int.test.ts checks it",
    };
  },
};
