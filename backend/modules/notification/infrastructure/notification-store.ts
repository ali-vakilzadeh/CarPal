// Storage of the S17 notification settings: the rule row (NotificationRulesRead for the dispatcher and the trust
// module) and the live template overrides the dispatcher renders with.
import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { overrideMap, type OverrideMap } from '../domain/template-catalog.js';
import { DEFAULT_NOTIFICATION_RULES, NotificationRulesRead, type NotificationRulesValues } from '../interface/notification-rules.js';

export type RulesRow = Selectable<DB['notification.notification_rules']>;
export type OverrideRow = Selectable<DB['notification.notification_template_overrides']>;

export function rulesValues(row: RulesRow | undefined): NotificationRulesValues {
  if (!row) return DEFAULT_NOTIFICATION_RULES;
  return {
    invitationDelayMinutes: row.review_invitation_delay_minutes,
    reminderDays: [...row.review_invitation_reminder_days].map(Number),
    defaultQuietHours:
      row.default_quiet_hours_start && row.default_quiet_hours_end
        ? { start: row.default_quiet_hours_start, end: row.default_quiet_hours_end }
        : null,
    digestHour: row.digest_hour,
    weeklyDigestDay: row.weekly_digest_day,
  };
}

export async function rulesRow(scope: TxScope, forUpdate = false): Promise<RulesRow | undefined> {
  let q = scope.db
    .selectFrom('notification.notification_rules')
    .selectAll()
    .where('rule_set', '=', 'default')
    .where('deleted_at', 'is', null);
  if (forUpdate) q = q.forUpdate();
  return q.executeTakeFirst();
}

/** Live overrides (at most a few hundred rows: templates × 3 channels × 2 languages). */
export async function liveOverrides(scope: TxScope): Promise<OverrideRow[]> {
  return scope.db
    .selectFrom('notification.notification_template_overrides')
    .selectAll()
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .limit(2000)
    .execute();
}

export async function loadOverrides(scope: TxScope): Promise<OverrideMap> {
  return overrideMap(await liveOverrides(scope));
}

@Injectable()
export class DbNotificationRules extends NotificationRulesRead {
  async get(scope: TxScope): Promise<NotificationRulesValues> {
    return rulesValues(await rulesRow(scope));
  }
}
