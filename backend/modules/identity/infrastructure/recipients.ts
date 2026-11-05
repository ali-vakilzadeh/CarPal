// Recipients (interface/identity.ts) for the notification dispatcher (W5,
// system context): verified destinations, locale and the critical-alerts-only
// preference of users, and active members of organizations by role.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { Recipients, UserChoices, type RecipientContact } from '../interface/identity.js';

@Injectable()
export class DbRecipients extends Recipients {
  async contacts(scope: TxScope, userIds: readonly string[]): Promise<Map<string, RecipientContact>> {
    const ids = [...new Set(userIds)].slice(0, 1000);
    if (ids.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('identity.user_accounts as u')
      .leftJoin('identity.user_preferences as p', (j) => j.onRef('p.user_id', '=', 'u.id').on('p.deleted_at', 'is', null))
      .select([
        'u.id',
        'u.status',
        'u.locale',
        'u.email',
        'u.email_verified_at',
        'u.phone',
        'u.phone_verified_at',
        'u.timezone',
        'p.critical_alerts_only',
        'p.quiet_hours_start',
        'p.quiet_hours_end',
      ])
      .where('u.id', 'in', ids)
      .where('u.deleted_at', 'is', null)
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          userId: r.id,
          status: r.status,
          locale: r.locale,
          email: r.email_verified_at ? r.email : null,
          phone: r.phone && r.phone_verified_at ? r.phone : null,
          criticalAlertsOnly: r.critical_alerts_only ?? false,
          timezone: r.timezone,
          quietHours: r.quiet_hours_start && r.quiet_hours_end ? { start: r.quiet_hours_start, end: r.quiet_hours_end } : null,
        },
      ]),
    );
  }

  async members(scope: TxScope, orgId: string, roles: readonly string[]): Promise<string[]> {
    let q = scope.db
      .selectFrom('identity.role_memberships')
      .select('user_id')
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('user_id', 'is not', null)
      .where('deleted_at', 'is', null);
    if (roles.length) q = q.where('role', 'in', [...roles]);
    return [...new Set((await q.execute()).map((r) => r.user_id!))];
  }
}

@Injectable()
export class DbUserChoices extends UserChoices {
  async helpMePersonalised(scope: TxScope, userId: string): Promise<boolean> {
    const p = await scope.db
      .selectFrom('identity.user_preferences')
      .select('ai_help_me_personalised')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return p?.ai_help_me_personalised ?? false;
  }

  async reviewInvitationChannel(scope: TxScope, userId: string): Promise<'in_app' | 'email'> {
    const { rows } = await sql<{ channel: string | null }>`SELECT identity.review_invitation_channel(${userId}::uuid) AS channel`.execute(
      scope.db,
    );
    return rows[0]?.channel === 'email' ? 'email' : 'in_app';
  }
}
