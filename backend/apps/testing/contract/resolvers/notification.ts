// Contract sweep resolvers: notifications (40 §20).
import { expect } from 'vitest';
import { ok, type Actor, type Harness, type Resolvers } from '../harness.js';

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
};
