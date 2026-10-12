// Notification operations (40 §20.2): the caller's in-app notifications
// (personal ones, or a portal organization's with organization_id, for its
// members only), read marks, preferences (critical alerts always reach the
// app; marketing needs the marketing consent) and push tokens (encrypted at
// rest, unique by keyed hash).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ConsentChecker, requireConsent } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import {
  ACK,
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { mergedPreferences, type Preference } from '../domain/preferences.js';
import { pushTokenAad } from './dispatcher.js';

registerConstraintErrors({ push_device_tokens_token_hash_key: { code: 'DUPLICATE', pointer: '/token', fieldCode: 'not_unique' } });

const me = (ctx: OperationContext): string => {
  if (ctx.principal.kind !== 'user') throw new ApiError('UNAUTHENTICATED');
  return ctx.principal.userId;
};

/** Personal notifications, or those of a portal organization the caller belongs to. */
async function contextOrg(ctx: OperationContext, orgId: string | undefined): Promise<string | null> {
  if (!orgId) return null;
  await ctx.authorizeOrg(orgId, ['ANY']);
  return orgId;
}

type ListQuery = { unread_only?: boolean; category?: string; organization_id?: string; limit: number };

@Injectable()
@Operation('notifications.list')
export class NotificationsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const user = me(ctx);
    const q = ctx.query;
    const org = await contextOrg(ctx, q.organization_id);
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('notification.notifications')
          .selectAll()
          .where('recipient_user_id', '=', user)
          .where('status', '<>', 'expired')
          .where('deleted_at', 'is', null);
        s = org ? s.where('organization_context_id', '=', org) : s.where('organization_context_id', 'is', null);
        if (q.unread_only) s = s.where('read_at', 'is', null);
        if (q.category) s = s.where('category', '=', q.category);
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        return ctx.page(
          page.map((n) => ({
            id: n.id,
            event_type: n.event_type,
            category: n.category,
            priority: n.priority,
            template_key: n.template_key,
            template_params: n.template_params ?? {},
            locale: n.locale,
            organization_context_id: n.organization_context_id,
            reference:
              n.reference_entity_type && n.reference_entity_id ? { type: n.reference_entity_type, id: n.reference_entity_id } : null,
            read_at: isoOrNull(n.read_at),
            created_at: iso(n.created_at),
          })),
          rows.length > q.limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('notifications.unread_count')
export class NotificationsUnreadCountHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { organization_id?: string }>): Promise<OperationResult> {
    const user = me(ctx);
    const org = await contextOrg(ctx, ctx.query.organization_id);
    const count = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('notification.notifications')
          .select(sql<string>`count(*)`.as('n'))
          .where('recipient_user_id', '=', user)
          .where('read_at', 'is', null)
          .where('status', '<>', 'expired')
          .where('deleted_at', 'is', null);
        s = org ? s.where('organization_context_id', '=', org) : s.where('organization_context_id', 'is', null);
        return Math.min(Number((await s.executeTakeFirstOrThrow()).n), 100_000);
      },
      { readOnly: true },
    );
    return { body: { count } };
  }
}

@Injectable()
@Operation('notifications.mark_read')
export class NotificationsMarkReadHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ ids?: string[]; up_to?: string }>): Promise<OperationResult> {
    const user = me(ctx);
    const b = ctx.body;
    // C: exactly one of ids and up_to.
    if (b.ids && b.up_to) throw ApiError.validation([{ pointer: '/up_to', code: 'conditional_forbidden' }]);
    if (!b.ids && !b.up_to) throw ApiError.validation([{ pointer: '/ids', code: 'conditional_required' }]);
    await ctx.tx(async (scope) => {
      let s = scope.db
        .updateTable('notification.notifications')
        .set({ read_at: sql<Date>`now()`, status: 'read' })
        .where('recipient_user_id', '=', user)
        .where('read_at', 'is', null);
      s = b.ids
        ? s.where('id', 'in', b.ids.length ? b.ids : ['00000000-0000-7000-8000-000000000000'])
        : s.where('created_at', '<=', new Date(b.up_to!));
      await s.execute();
    });
    return { body: ACK };
  }
}

async function storedPreferences(scope: Parameters<Parameters<OperationContext['tx']>[0]>[0], user: string): Promise<Preference[]> {
  return (await scope.db
    .selectFrom('notification.notification_preferences')
    .select(['channel', 'category', 'enabled', 'frequency'])
    .where('user_id', '=', user)
    .where('deleted_at', 'is', null)
    .execute()) as Preference[];
}

@Injectable()
@Operation('notification_prefs.get')
export class NotificationPrefsGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const user = me(ctx);
    const items = await ctx.tx(async (scope) => mergedPreferences(await storedPreferences(scope, user)), { readOnly: true });
    return { body: { items } };
  }
}

@Injectable()
@Operation('notification_prefs.put')
export class NotificationPrefsPutHandler implements OperationHandler {
  constructor(private readonly consents: ConsentChecker) {}

  async handle(ctx: OperationContext<{ items: Preference[] }>): Promise<OperationResult> {
    const user = me(ctx);
    const items = ctx.body.items;
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    items.forEach((p, i) => {
      const key = `${p.channel}:${p.category}`;
      if (seen.has(key)) errors.push({ pointer: `/items/${i}`, code: 'not_unique' });
      seen.add(key);
      // Digests are an email feature (52 NotificationPreference.frequency).
      if (p.channel !== 'email' && p.frequency !== 'immediate') errors.push({ pointer: `/items/${i}/frequency`, code: 'enum' });
    });
    if (errors.length) throw ApiError.validation(errors);
    const body = await ctx.tx(async (scope) => {
      // Marketing needs an active marketing consent (52 NotificationPreference).
      if (items.some((p) => p.category === 'marketing' && p.enabled))
        await requireConsent(this.consents, scope, { consentType: 'marketing', subject: { type: 'user', id: user } });
      // Replace: listed rows are written, rows not listed return to the defaults.
      const merged = mergedPreferences(items);
      for (const p of merged)
        await scope.db
          .insertInto('notification.notification_preferences')
          .values({ user_id: user, channel: p.channel, category: p.category, enabled: p.enabled, frequency: p.frequency })
          .onConflict((oc) =>
            oc.columns(['user_id', 'channel', 'category']).doUpdateSet({ enabled: p.enabled, frequency: p.frequency, deleted_at: null }),
          )
          .execute();
      return { items: mergedPreferences(await storedPreferences(scope, user)) };
    });
    return { body };
  }
}

type PushTokenRegister = { platform: 'ios' | 'android' | 'web'; token: string; app_version?: string; locale?: string };

@Injectable()
@Operation('push_tokens.register')
export class PushTokensRegisterHandler implements OperationHandler {
  constructor(private readonly crypto: CryptoServices) {}

  async handle(ctx: OperationContext<PushTokenRegister>): Promise<OperationResult> {
    const user = me(ctx);
    const b = ctx.body;
    const hash = this.crypto.hmac.digest('contact-hash', `push:${b.token}`);
    const id = await ctx.tx(async (scope) => {
      // A device registering again refreshes its row (RLS: only the caller's own tokens are visible).
      const existing = await scope.db
        .selectFrom('notification.push_device_tokens')
        .select('id')
        .where('user_id', '=', user)
        .where('token_hash', '=', hash)
        .executeTakeFirst();
      if (existing) {
        await scope.db
          .updateTable('notification.push_device_tokens')
          .set({
            status: 'active',
            platform: b.platform,
            app_version: b.app_version ?? null,
            locale: b.locale ?? null,
            last_seen_at: sql<Date>`now()`,
            deleted_at: null,
          })
          .where('id', '=', existing.id)
          .execute();
        return existing.id;
      }
      const newId = uuidv7();
      await scope.db
        .insertInto('notification.push_device_tokens')
        .values({
          id: newId,
          user_id: user,
          platform: b.platform,
          token_encrypted: this.crypto.envelope.encrypt(b.token, pushTokenAad(newId)),
          token_hash: hash,
          app_version: b.app_version ?? null,
          locale: b.locale ?? null,
          last_seen_at: sql<Date>`now()`,
        })
        .execute();
      return newId;
    });
    return { status: 201, body: { push_token_id: id }, headers: { location: `/v1/me/push-tokens/${id}` } };
  }
}

@Injectable()
@Operation('push_tokens.revoke')
export class PushTokensRevokeHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const user = me(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('notification.push_device_tokens')
        .set({ status: 'revoked' })
        .where('id', '=', ctx.params.push_token_id!)
        .where('user_id', '=', user)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}
