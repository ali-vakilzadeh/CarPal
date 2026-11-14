// Notification operations of the admin plane (40 §23.5, backend S17; A-NOTIF-01, owner decision DQ-05):
//   templates   list every code template per channel and language with the text in use, its variables and the
//               translation flags; staff overrides (ETAG(if exists)), reset to the code text, preview with samples.
//               Transactional texts and critical alerts are locked.
//   rules       the one rule row (invitation delay and reminders, default quiet hours, digest schedule).
//   notices     the caller's staff notices (four-eyes outcome, staff security, kill switch, DSR deadlines).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
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
import type { TxScope } from '#libs/tenancy/index.js';
import { StaffNames, staffOf } from '#modules/admin/interface/admin.js';
import { STAFF_EVENT_TYPES } from '../domain/routing.js';
import {
  catalog,
  catalogEntry,
  codeText,
  overrideKey,
  overrideMap,
  renderWith,
  sampleParams,
  TEMPLATE_LOCALES,
  translationFlags,
  unknownPlaceholders,
  type CatalogTemplate,
  type OverrideMap,
  type TemplateChannel,
  type TemplateLocale,
} from '../domain/template-catalog.js';
import { liveOverrides, rulesRow, type OverrideRow, type RulesRow } from '../infrastructure/notification-store.js';

registerConstraintErrors({ notification_template_overrides_uq: 'VERSION_MISMATCH' });

// ------------------------------------------------------------------ templates

function templateView(
  entry: CatalogTemplate,
  channel: TemplateChannel,
  locale: TemplateLocale,
  overrides: OverrideMap,
  rows: ReadonlyMap<string, OverrideRow>,
  names: ReadonlyMap<string, string>,
) {
  const row = rows.get(overrideKey(entry.key, channel, locale));
  const text = row ? { subject: row.subject, body: row.body } : codeText(entry.key, channel, locale);
  const flags = translationFlags(entry.key, channel, locale, overrides);
  return {
    template_key: entry.key,
    channel,
    locale,
    kind: entry.kind,
    always_delivered: entry.alwaysDelivered,
    editable: entry.editable,
    source: row ? 'override' : 'code',
    subject: channel === 'sms' ? null : text.subject,
    body: text.body,
    variables: entry.variables,
    missing_translation: flags.missing,
    translation_outdated: flags.outdated,
    updated_by_display: row ? (names.get(row.updated_by ?? row.created_by ?? '') ?? 'CarPal') : null,
    updated_at: row ? iso(row.updated_at) : null,
    version: row ? row.version : null,
  };
}

async function overrideState(scope: TxScope, locale: string, names: StaffNames) {
  const live = await liveOverrides(scope);
  const rows = new Map(live.map((r) => [overrideKey(r.template_key, r.channel, r.locale), r]));
  const people = await names.names(
    scope,
    live.map((r) => r.updated_by ?? r.created_by).filter((x): x is string => !!x),
    locale,
  );
  return { overrides: overrideMap(live), rows, names: people };
}

/** The template of the path, with the channel checked against the channels the router can use. */
function editableEntry(key: string, channel: TemplateChannel, requireEditable: boolean): CatalogTemplate {
  const entry = catalogEntry(key);
  if (!entry) throw new ApiError('NOT_FOUND');
  if (!entry.channels.includes(channel)) throw ApiError.validation([{ pointer: '/channel', code: 'enum' }]);
  if (requireEditable && !entry.editable) throw new ApiError('INVALID_TRANSITION', { detail: 'locked' });
  return entry;
}

/** subject: required for email and push, forbidden for SMS; placeholders only from the template's variables. */
function checkText(entry: CatalogTemplate, channel: TemplateChannel, subject: string | undefined, body: string | undefined): void {
  const errors: FieldError[] = [];
  if (channel === 'sms' && subject !== undefined) errors.push({ pointer: '/subject', code: 'conditional_forbidden' });
  if (channel !== 'sms' && subject === undefined && body !== undefined) errors.push({ pointer: '/subject', code: 'conditional_required' });
  for (const [pointer, text] of [
    ['/subject', subject],
    ['/body', body],
  ] as const)
    for (const name of unknownPlaceholders(entry, text)) errors.push({ pointer, code: 'unknown_placeholder', limit: `{${name}}` });
  if (errors.length) throw ApiError.validation(errors);
}

type ListQuery = { template_key?: string; channel?: TemplateChannel; locale?: TemplateLocale; missing_only?: boolean };

@Injectable()
@Operation('admin.notif_templates_list')
export class NotifTemplatesListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        const st = await overrideState(scope, ctx.locale, this.names);
        const items = [];
        for (const entry of catalog()) {
          if (q.template_key && entry.key !== q.template_key) continue;
          for (const channel of entry.channels) {
            if (q.channel && channel !== q.channel) continue;
            for (const locale of TEMPLATE_LOCALES) {
              if (q.locale && locale !== q.locale) continue;
              const view = templateView(entry, channel, locale, st.overrides, st.rows, st.names);
              if (q.missing_only && !view.missing_translation && !view.translation_outdated) continue;
              items.push(view);
            }
          }
        }
        return { items: items.slice(0, 1000) };
      },
      { readOnly: true },
    );
    return { body };
  }
}

type TemplateWrite = { channel: TemplateChannel; locale: TemplateLocale; subject?: string; body: string; reason: string };

@Injectable()
@Operation('admin.notif_template_update')
export class NotifTemplateUpdateHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<TemplateWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const entry = editableEntry(ctx.params.template_key!, b.channel, true);
    checkText(entry, b.channel, b.subject, b.body);
    const body = await ctx.tx(async (scope) => {
      const existing = await scope.db
        .selectFrom('notification.notification_template_overrides')
        .selectAll()
        .where('template_key', '=', entry.key)
        .where('channel', '=', b.channel)
        .where('locale', '=', b.locale)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      // ETAG(if exists): an override needs its version; the code text takes no If-Match.
      if (existing && ctx.ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED', { detail: 'If-Match required' });
      if ((existing && ctx.ifMatch !== existing.version) || (!existing && ctx.ifMatch !== undefined))
        throw new ApiError('VERSION_MISMATCH');
      const previous = existing ?? { ...codeText(entry.key, b.channel, b.locale) };
      const values = { subject: b.subject ?? null, body: b.body, reason: b.reason };
      const row = existing
        ? await scope.db
            .updateTable('notification.notification_template_overrides')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await scope.db
            .insertInto('notification.notification_template_overrides')
            .values({ template_key: entry.key, channel: b.channel, locale: b.locale, ...values })
            .returningAll()
            .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'notification.template_overridden',
        entityType: 'notification_template_override',
        entityId: row.id,
        reason: b.reason,
        previous: JSON.stringify({
          template: `${entry.key} ${b.channel} ${b.locale}`,
          subject: previous.subject,
          body: previous.body,
        }).slice(0, 2000),
        next: JSON.stringify({ subject: row.subject, body: row.body }).slice(0, 2000),
      });
      const st = await overrideState(scope, ctx.locale, this.names);
      return templateView(entry, b.channel, b.locale, st.overrides, st.rows, st.names);
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.notif_template_reset')
export class NotifTemplateResetHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<{ channel: TemplateChannel; locale: TemplateLocale; reason: string }>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const entry = editableEntry(ctx.params.template_key!, b.channel, false);
    const body = await ctx.tx(async (scope) => {
      const existing = await scope.db
        .selectFrom('notification.notification_template_overrides')
        .selectAll()
        .where('template_key', '=', entry.key)
        .where('channel', '=', b.channel)
        .where('locale', '=', b.locale)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== existing.version) throw new ApiError('VERSION_MISMATCH');
      await scope.db
        .updateTable('notification.notification_template_overrides')
        .set({ deleted_at: sql<Date>`now()`, deletion_reason: b.reason })
        .where('id', '=', existing.id)
        .execute();
      await writeAudit(scope, {
        action: 'notification.template_reset',
        entityType: 'notification_template_override',
        entityId: existing.id,
        reason: b.reason,
        previous: JSON.stringify({
          template: `${entry.key} ${b.channel} ${b.locale}`,
          subject: existing.subject,
          body: existing.body,
        }).slice(0, 2000),
        next: 'code text',
      });
      const st = await overrideState(scope, ctx.locale, this.names);
      return templateView(entry, b.channel, b.locale, st.overrides, st.rows, st.names);
    });
    return { body };
  }
}

type PreviewInput = {
  channel: TemplateChannel;
  locale: TemplateLocale;
  subject?: string;
  body?: string;
  params?: Record<string, unknown>;
};

@Injectable()
@Operation('admin.notif_template_preview')
export class NotifTemplatePreviewHandler implements OperationHandler {
  async handle(ctx: OperationContext<PreviewInput>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const draft = b.subject !== undefined || b.body !== undefined;
    const entry = editableEntry(ctx.params.template_key!, b.channel, draft);
    if (draft) checkText(entry, b.channel, b.subject, b.body ?? '');
    const overrides = await ctx.tx(async (scope) => overrideMap(await liveOverrides(scope)), { readOnly: true });
    let used: OverrideMap = overrides;
    if (draft) {
      const current = overrides.get(overrideKey(entry.key, b.channel, b.locale)) ?? codeText(entry.key, b.channel, b.locale);
      const text = {
        template_key: entry.key,
        channel: b.channel,
        locale: b.locale,
        subject: b.channel === 'sms' ? null : (b.subject ?? current.subject),
        body: b.body ?? current.body,
      };
      used = new Map([...overrides, [overrideKey(entry.key, b.channel, b.locale), text]]);
    }
    const r = renderWith(entry.key, b.locale, b.channel, sampleParams(entry.variables, b.params ?? {}), used);
    const subject = b.channel === 'sms' ? null : b.channel === 'push' ? r.title : r.subject;
    const text = b.channel === 'push' ? r.body : r.text;
    return { body: { subject: subject ? subject.slice(0, 400) : null, body: (text || ' ').slice(0, 8000) } };
  }
}

// ------------------------------------------------------------------ rules

function toRules(row: RulesRow, updatedBy: string | null) {
  return {
    review_invitation_delay_minutes: row.review_invitation_delay_minutes,
    review_invitation_reminder_days: [...row.review_invitation_reminder_days].map(Number),
    default_quiet_hours:
      row.default_quiet_hours_start && row.default_quiet_hours_end
        ? { start: row.default_quiet_hours_start, end: row.default_quiet_hours_end }
        : null,
    digest_hour: row.digest_hour,
    weekly_digest_day: row.weekly_digest_day,
    updated_by_display: updatedBy,
    updated_at: iso(row.updated_at),
    version: row.version,
  };
}

async function rulesView(scope: TxScope, row: RulesRow, names: StaffNames, locale: string) {
  return toRules(row, row.updated_by ? await names.name(scope, row.updated_by, locale) : null);
}

@Injectable()
@Operation('admin.notif_rules_get')
export class NotifRulesGetHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const row = await rulesRow(scope);
        if (!row) throw new ApiError('NOT_FOUND');
        return rulesView(scope, row, this.names, ctx.locale);
      },
      { readOnly: true },
    );
    return { body };
  }
}

type RulesWrite = {
  review_invitation_delay_minutes: number;
  review_invitation_reminder_days: number[];
  default_quiet_hours: { start: string; end: string } | null;
  digest_hour: number;
  weekly_digest_day: number;
  reason: string;
};

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function rulesErrors(b: RulesWrite): FieldError[] {
  const errors: FieldError[] = [];
  b.review_invitation_reminder_days.forEach((d, i) => {
    if (i > 0 && d <= b.review_invitation_reminder_days[i - 1]!)
      errors.push({ pointer: `/review_invitation_reminder_days/${i}`, code: 'order' });
  });
  if (b.default_quiet_hours) {
    for (const k of ['start', 'end'] as const)
      if (!HH_MM.test(b.default_quiet_hours[k])) errors.push({ pointer: `/default_quiet_hours/${k}`, code: 'pattern' });
    if (b.default_quiet_hours.start === b.default_quiet_hours.end) errors.push({ pointer: '/default_quiet_hours/end', code: 'order' });
  }
  return errors;
}

@Injectable()
@Operation('admin.notif_rules_update')
export class NotifRulesUpdateHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<RulesWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const errors = rulesErrors(b);
    if (errors.length) throw ApiError.validation(errors);
    const body = await ctx.tx(async (scope) => {
      const row = await rulesRow(scope, true);
      if (!row) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== row.version) throw new ApiError('VERSION_MISMATCH');
      const updated = await scope.db
        .updateTable('notification.notification_rules')
        .set({
          review_invitation_delay_minutes: b.review_invitation_delay_minutes,
          review_invitation_reminder_days: b.review_invitation_reminder_days,
          default_quiet_hours_start: b.default_quiet_hours?.start ?? null,
          default_quiet_hours_end: b.default_quiet_hours?.end ?? null,
          digest_hour: b.digest_hour,
          weekly_digest_day: b.weekly_digest_day,
          reason: b.reason,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const summary = (r: RulesRow) =>
        JSON.stringify({ ...toRules(r, null), updated_by_display: undefined, updated_at: undefined, version: undefined });
      await writeAudit(scope, {
        action: 'notification.rules_updated',
        entityType: 'notification_rules',
        entityId: row.id,
        reason: b.reason,
        previous: summary(row).slice(0, 2000),
        next: summary(updated).slice(0, 2000),
      });
      return rulesView(scope, updated, this.names, ctx.locale);
    });
    return { body };
  }
}

// ------------------------------------------------------------------ the caller's staff notices

const STAFF_TYPES = [...STAFF_EVENT_TYPES];

const me = (ctx: OperationContext): string => staffOf(ctx).userId;

@Injectable()
@Operation('admin.notifications_list')
export class StaffNotificationsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { unread_only?: boolean; limit: number }>): Promise<OperationResult> {
    const user = me(ctx);
    const q = ctx.query;
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('notification.notifications')
          .selectAll()
          .where('recipient_user_id', '=', user)
          .where('event_type', 'in', STAFF_TYPES)
          .where('organization_context_id', 'is', null)
          .where('status', '<>', 'expired')
          .where('deleted_at', 'is', null);
        if (q.unread_only) s = s.where('read_at', 'is', null);
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
            organization_context_id: null,
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
@Operation('admin.notifications_unread_count')
export class StaffNotificationsUnreadCountHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const user = me(ctx);
    const count = await ctx.tx(
      async (scope) => {
        const r = await scope.db
          .selectFrom('notification.notifications')
          .select(sql<string>`count(*)`.as('n'))
          .where('recipient_user_id', '=', user)
          .where('event_type', 'in', STAFF_TYPES)
          .where('organization_context_id', 'is', null)
          .where('read_at', 'is', null)
          .where('status', '<>', 'expired')
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        return Math.min(Number(r.n), 100_000);
      },
      { readOnly: true },
    );
    return { body: { count } };
  }
}

@Injectable()
@Operation('admin.notifications_mark_read')
export class StaffNotificationsMarkReadHandler implements OperationHandler {
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
        .where('event_type', 'in', STAFF_TYPES)
        .where('read_at', 'is', null);
      s = b.ids
        ? s.where('id', 'in', b.ids.length ? b.ids : ['00000000-0000-7000-8000-000000000000'])
        : s.where('created_at', '<=', new Date(b.up_to!));
      await s.execute();
    });
    return { body: ACK };
  }
}
