// W5 notification dispatch (41 §2.4; 52 Notification, NotificationDelivery).
// An event is routed to intents (domain/routing.ts); for every recipient one
// Notification row (the in-app notification, in the recipient's locale) and
// its deliveries are written in one transaction, then the queued deliveries
// are sent through the Mailer, PushSender and SmsSender ports and recorded
// (sent / failed with attempt_count and last_error). Preferences decide
// email, push and SMS; critical notifications skip them; email digests wait
// for the digest rule. Business notifications go to portal (web) push tokens
// only (52: the consumer app receives no business notifications). Runs in
// the worker's system context.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoServices } from '#libs/crypto/index.js';
import type { EventEnvelope, Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { CommunityRead } from '#modules/community/interface/community.js';
import { Recipients, type RecipientContact } from '#modules/identity/interface/identity.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { channelsFor, type Preference } from '../domain/preferences.js';
import { route, type Audience, type Intent } from '../domain/routing.js';
import { render } from '../domain/templates.js';

/** Envelope AAD of a stored push token. */
export const pushTokenAad = (id: string): string => `notification.push_token:${id}`;

const MAX_ATTEMPTS = 3;

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly tx: TxRunner,
    private readonly recipients: Recipients,
    private readonly orgCards: OrgCards,
    @Inject(CryptoServices) private readonly crypto: CryptoServices,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
    @Optional() private readonly community?: CommunityRead,
  ) {}

  async #audience(scope: TxScope, a: Audience): Promise<string[]> {
    if (a.kind === 'users') return a.ids;
    if (a.kind === 'members') return this.recipients.members(scope, a.orgId, a.roles);
    return this.community ? this.community.followers(scope, a.orgId, a.preferences) : [];
  }

  /** Routes one event; returns the ids of the notifications written. */
  async dispatch(event: EventEnvelope): Promise<string[]> {
    const intents = route(event);
    if (intents.length === 0) return [];
    const ids = await this.tx.run({ actorType: 'system', requestId: event.requestId }, async (scope) => {
      const out: string[] = [];
      for (const intent of intents) out.push(...(await this.#write(scope, intent)));
      return out;
    });
    await this.deliver(ids);
    return ids;
  }

  async #write(scope: TxScope, intent: Intent): Promise<string[]> {
    const users = [...new Set(await this.#audience(scope, intent.audience))];
    if (users.length === 0) return [];
    const params: Record<string, string | number | boolean> = { ...intent.params };
    const orgForName = intent.audience.kind === 'followers' ? intent.audience.orgId : null;
    if (orgForName) params.organization_name = (await this.orgCards.cards(scope, [orgForName])).get(orgForName)?.name ?? '';
    const contacts = await this.recipients.contacts(scope, users);
    const prefs = await scope.db
      .selectFrom('notification.notification_preferences')
      .select(['user_id', 'channel', 'category', 'enabled', 'frequency'])
      .where('user_id', 'in', users)
      .where('deleted_at', 'is', null)
      .execute();
    const business = intent.organization_context_id !== null;
    const tokens = intent.channels.includes('push')
      ? await scope.db
          .selectFrom('notification.push_device_tokens')
          .select(['id', 'user_id', 'platform'])
          .where('user_id', 'in', users)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute()
      : [];
    const out: string[] = [];
    for (const userId of users) {
      const c = contacts.get(userId);
      if (!c || c.status !== 'active') continue;
      const n = await scope.db
        .insertInto('notification.notifications')
        .values({
          recipient_user_id: userId,
          organization_context_id: intent.organization_context_id,
          event_type: intent.event_type,
          category: intent.category,
          priority: intent.priority,
          template_key: intent.template_key,
          template_params: JSON.stringify(params),
          locale: c.locale,
          reference_entity_type: intent.reference?.type ?? null,
          reference_entity_id: intent.reference?.id ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      out.push(n.id);
      const decisions = channelsFor({
        category: intent.category,
        priority: intent.priority,
        preferences: prefs.filter((p) => p.user_id === userId) as Preference[],
        criticalAlertsOnly: c.criticalAlertsOnly,
        allowed: intent.channels,
      });
      for (const d of decisions) await this.#delivery(scope, n.id, d.channel, d.outcome, c, tokens, business);
    }
    return out;
  }

  async #delivery(
    scope: TxScope,
    notificationId: string,
    channel: string,
    outcome: 'send' | 'digest' | 'suppressed',
    c: RecipientContact,
    tokens: { id: string; user_id: string; platform: string }[],
    business: boolean,
  ): Promise<void> {
    const insert = (values: { status: string; suppressed_reason?: string; push_device_token_id?: string }) =>
      scope.db
        .insertInto('notification.notification_deliveries')
        .values({ notification_id: notificationId, channel, ...values })
        .execute();
    if (channel === 'push') {
      // A push delivery names its device; without a token there is nothing to record.
      const own = tokens.filter((t) => t.user_id === c.userId && (!business || t.platform === 'web'));
      for (const t of own)
        await insert(
          outcome === 'send'
            ? { status: 'queued', push_device_token_id: t.id }
            : { status: 'suppressed', suppressed_reason: 'preference', push_device_token_id: t.id },
        );
      return;
    }
    const destination = channel === 'email' ? c.email : channel === 'sms' ? c.phone : null;
    if (outcome === 'suppressed') await insert({ status: 'suppressed', suppressed_reason: 'preference' });
    else if (!destination) await insert({ status: 'suppressed', suppressed_reason: 'no_destination' });
    else if (outcome === 'digest') await insert({ status: 'suppressed', suppressed_reason: 'digest' });
    else await insert({ status: 'queued' });
  }

  /**
   * Sends queued deliveries (of the given notifications, or every queued or
   * failed one due for a retry) and records the outcome; returns the number
   * sent. Never throws for a single failed delivery.
   */
  async deliver(notificationIds?: readonly string[]): Promise<number> {
    if (notificationIds && notificationIds.length === 0) return 0;
    const rows = await this.tx.run({ actorType: 'system' }, ({ db }) => {
      let q = db
        .selectFrom('notification.notification_deliveries as d')
        .innerJoin('notification.notifications as n', 'n.id', 'd.notification_id')
        .leftJoin('notification.push_device_tokens as t', 't.id', 'd.push_device_token_id')
        .select([
          'd.id',
          'd.channel',
          'd.attempt_count',
          'n.id as notification_id',
          'n.recipient_user_id',
          'n.template_key',
          'n.template_params',
          'n.locale',
          't.id as token_id',
          't.token_encrypted',
          't.platform',
          't.status as token_status',
        ])
        .where('d.deleted_at', 'is', null)
        .where('d.attempt_count', '<', MAX_ATTEMPTS);
      q = notificationIds
        ? q.where('d.notification_id', 'in', [...notificationIds]).where('d.status', '=', 'queued')
        : q.where('d.status', 'in', ['queued', 'failed']).where('d.updated_at', '<', sql<Date>`now() - interval '1 minute'`);
      return q.orderBy('d.id').limit(500).execute();
    });
    if (rows.length === 0) return 0;
    const contacts = await this.tx.run({ actorType: 'system' }, (scope) =>
      this.recipients.contacts(
        scope,
        rows.map((r) => r.recipient_user_id),
      ),
    );
    let sent = 0;
    for (const r of rows) {
      const params = (r.template_params ?? {}) as Record<string, unknown>;
      const text = render(r.template_key, r.locale, params);
      const c = contacts.get(r.recipient_user_id);
      let error: string | null = null;
      try {
        if (r.channel === 'email') {
          if (!c?.email) throw new Error('no destination');
          await this.infra.mailer.send({
            to: c.email,
            template: r.template_key,
            locale: r.locale,
            variables: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
            subject: text.subject,
            text: text.text,
          });
        } else if (r.channel === 'sms') {
          if (!c?.phone) throw new Error('no destination');
          await this.infra.sms.send({ to: c.phone, template: r.template_key, locale: r.locale, variables: {}, text: text.text });
        } else if (r.channel === 'push') {
          if (!r.token_id || !r.token_encrypted || r.token_status !== 'active') throw new Error('token revoked');
          const token = this.crypto.envelope.decryptString(r.token_encrypted, pushTokenAad(r.token_id));
          await this.infra.push.send({
            deviceTokenId: r.token_id,
            platform: r.platform as 'ios' | 'android' | 'web',
            token,
            title: text.title,
            body: text.body,
            data: { notification_id: r.notification_id, template_key: r.template_key },
          });
        }
      } catch (err) {
        error = (err as Error).message?.slice(0, 500) || 'send failed';
        this.logger.warn({ delivery_id: r.id, channel: r.channel, err: error }, 'notification delivery failed');
      }
      await this.tx.run({ actorType: 'system' }, async ({ db }) => {
        await db
          .updateTable('notification.notification_deliveries')
          .set(
            error
              ? { status: 'failed', attempt_count: r.attempt_count + 1, last_error: error }
              : { status: 'sent', attempt_count: r.attempt_count + 1, sent_at: sql<Date>`now()`, last_error: null },
          )
          .where('id', '=', r.id)
          .execute();
        await db
          .updateTable('notification.notifications')
          .set({ status: 'dispatched' })
          .where('id', '=', r.notification_id)
          .where('status', '=', 'created')
          .execute();
      });
      if (!error) sent++;
    }
    // Notifications whose every delivery was decided without sending are dispatched too.
    if (notificationIds)
      await this.tx.run({ actorType: 'system' }, ({ db }) =>
        db
          .updateTable('notification.notifications')
          .set({ status: 'dispatched' })
          .where('id', 'in', [...notificationIds])
          .where('status', '=', 'created')
          .execute(),
      );
    return sent;
  }

  /**
   * Email digests (52 NotificationPreference.frequency): a recipient's
   * deliveries kept for the digest go out together once the oldest is a day
   * (daily) or a week (weekly) old. Returns the number of digests sent.
   */
  async sendDigests(now = new Date()): Promise<number> {
    const pending = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('notification.notification_deliveries as d')
        .innerJoin('notification.notifications as n', 'n.id', 'd.notification_id')
        .leftJoin('notification.notification_preferences as p', (j) =>
          j.onRef('p.user_id', '=', 'n.recipient_user_id').onRef('p.category', '=', 'n.category').on('p.channel', '=', 'email'),
        )
        .select(['d.id', 'd.created_at', 'n.recipient_user_id', 'n.template_key', 'n.template_params', 'n.locale', 'p.frequency'])
        .where('d.channel', '=', 'email')
        .where('d.status', '=', 'suppressed')
        .where('d.suppressed_reason', '=', 'digest')
        .where('d.sent_at', 'is', null)
        .where('d.deleted_at', 'is', null)
        .orderBy('d.id')
        .limit(5000)
        .execute(),
    );
    const byUser = new Map<string, typeof pending>();
    for (const p of pending) byUser.set(p.recipient_user_id, [...(byUser.get(p.recipient_user_id) ?? []), p]);
    if (byUser.size === 0) return 0;
    const contacts = await this.tx.run({ actorType: 'system' }, (scope) => this.recipients.contacts(scope, [...byUser.keys()]));
    let digests = 0;
    for (const [userId, items] of byUser) {
      const weekly = items.every((i) => i.frequency === 'weekly_digest');
      const oldest = Math.min(...items.map((i) => new Date(i.created_at).getTime()));
      if (now.getTime() - oldest < (weekly ? 7 : 1) * 86_400_000) continue;
      const c = contacts.get(userId);
      if (c?.email && c.status === 'active') {
        const locale = items[0]!.locale;
        const lines = items.map((i) => `- ${render(i.template_key, locale, (i.template_params ?? {}) as Record<string, unknown>).subject}`);
        const params = { count: String(items.length), items: lines.join('\n') };
        const r = render('notification.digest', locale, params);
        await this.infra.mailer.send({
          to: c.email,
          template: 'notification.digest',
          locale,
          variables: params,
          subject: r.subject,
          text: r.text,
        });
        digests++;
      }
      // Sent in the digest (or dropped for a recipient without a destination): never again.
      await this.tx.run({ actorType: 'system' }, ({ db }) =>
        db
          .updateTable('notification.notification_deliveries')
          .set(c?.email ? { status: 'sent', sent_at: sql<Date>`now()` } : { suppressed_reason: 'no_destination' })
          .where(
            'id',
            'in',
            items.map((i) => i.id),
          )
          .execute(),
      );
    }
    return digests;
  }
}
