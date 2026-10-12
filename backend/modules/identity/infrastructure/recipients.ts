// Recipients (interface/identity.ts) for the notification dispatcher (W5,
// system context): verified destinations, locale and the critical-alerts-only
// preference of users, and active members of organizations by role.
import { Injectable } from '@nestjs/common';
import type { TxScope } from '#libs/tenancy/index.js';
import { Recipients, type RecipientContact } from '../interface/identity.js';

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
        'p.critical_alerts_only',
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
