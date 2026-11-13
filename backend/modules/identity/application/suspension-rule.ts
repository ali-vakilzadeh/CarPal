// W15 "suspension expiry" (backend S14, admin console BR-07, backend DI-66): a
// timed suspension (admin.user_status or the case action suspend_account with
// suspend_until) ends on its own. Every 5 minutes the rule reactivates the
// accounts whose suspended_until has passed, as the system actor: back to
// active, or to pending_verification when the account has no verified contact
// (52 UserAccount: an active account needs one). Each lift writes an audit
// entry and emits moderation.action.taken reactivate_account like a staff
// reactivation, so the user is told and the search index and trust scores
// follow. Sessions were revoked at suspension; nothing is restored here.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

/** At most this many accounts per run; the rest follow at the next run. */
const BATCH = 200;

@Injectable()
export class SuspensionExpiryRule extends ScheduledRule {
  readonly name = 'identity.suspension_expiry';
  readonly everyMs = 300_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly authorizer: Authorizer,
  ) {
    super();
  }

  /** Returns the number of suspensions lifted. */
  async run(now = new Date()): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const { rows } = await sql<{ id: string; status: string; suspended_until: Date }>`
        UPDATE identity.user_accounts u
           SET status = CASE WHEN u.email_verified_at IS NOT NULL OR u.phone_verified_at IS NOT NULL
                             THEN 'active' ELSE 'pending_verification' END::core.user_status,
               suspended_until = NULL
         WHERE u.id IN (SELECT id FROM identity.user_accounts
                         WHERE status = 'suspended' AND suspended_until <= ${now} AND deleted_at IS NULL
                         ORDER BY suspended_until, id
                         LIMIT ${BATCH}
                           FOR UPDATE SKIP LOCKED)
     RETURNING u.id, u.status, ${now}::timestamptz AS suspended_until`.execute(scope.db);
      for (const u of rows) {
        await writeAudit(scope, {
          action: 'user.status_changed',
          entityType: 'user',
          entityId: u.id,
          reason: 'Timed suspension ended',
          previous: 'suspended',
          next: u.status,
        });
        await publishEvent(scope, {
          type: 'moderation.action.taken',
          aggregateType: 'user_account',
          aggregateId: u.id,
          payload: {
            action_type: 'reactivate_account',
            target_type: 'user',
            target_id: u.id,
            user_id: u.id,
            status: u.status,
            actor: 'system',
          },
        });
      }
      scope.afterCommit(async () => {
        for (const u of rows) await this.authorizer.invalidateUser(u.id);
      });
      return rows.length;
    });
  }
}
