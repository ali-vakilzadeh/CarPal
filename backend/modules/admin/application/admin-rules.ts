// Admin W15 rules (41 §6.3): hourly expiry of pending four-eyes changes and
// assist sessions past their deadline, and the daily retention run that hands
// every active DataRetentionPolicy to the module owning its entity type
// (RetentionHandlers). Platform tables without a module (relayed outbox
// events, finished background jobs) are purged here.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import {
  ModerationTargets,
  retentionCutoff,
  RetentionHandlers,
  type ModerationTargetType,
  type RetentionPolicyRecord,
} from '../interface/admin.js';

@Injectable()
export class AdminExpiryRule extends ScheduledRule {
  readonly name = 'admin.expiry';
  readonly everyMs = 3_600_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(): Promise<{ changes: number; sessions: number }> {
    return this.tx.run({ actorType: 'system' }, async ({ db }) => {
      const changes = await db
        .updateTable('admin.pending_admin_changes')
        .set({ status: 'expired' })
        .where('status', '=', 'pending')
        .where('expires_at', '<=', new Date())
        .executeTakeFirst();
      const sessions = await db
        .updateTable('admin.assist_sessions')
        .set({ status: 'expired' })
        .where('status', '=', 'active')
        .where('expires_at', '<=', new Date())
        .executeTakeFirst();
      return { changes: Number(changes.numUpdatedRows), sessions: Number(sessions.numUpdatedRows) };
    });
  }
}

/** Target types whose held records enter the moderation queue (GD-22 community holds, W4 review holds, portfolio and public media). */
const INTAKE_TYPES: ModerationTargetType[] = [
  'review',
  'review_response',
  'post',
  'comment',
  'question',
  'answer',
  'portfolio_item',
  'media_asset',
];
const INTAKE_BATCH = 200;

/**
 * Moderation intake (every 5 min): content an owning module holds for a
 * moderator gets a system_rule case (one open case per target), so held
 * posts, answers, reviews, portfolio items and public media reach the queue.
 */
@Injectable()
export class ModerationIntakeRule extends ScheduledRule {
  readonly name = 'admin.moderation_intake';
  readonly everyMs = 5 * 60_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly targets: ModerationTargets,
  ) {
    super();
  }

  async run(): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      let opened = 0;
      for (const type of INTAKE_TYPES) {
        const ids = (await this.targets.get(type)?.pending?.(scope, INTAKE_BATCH)) ?? [];
        if (ids.length === 0) continue;
        const { rows } = await sql<{ id: string }>`
          INSERT INTO admin.moderation_cases (case_type, target_entity_type, target_entity_id, source, reason, severity)
          SELECT ${type}, ${type}, t.id, 'system_rule', 'other', 'low'
            FROM unnest(${sql.val(ids)}::uuid[]) AS t(id)
           WHERE NOT EXISTS (SELECT 1 FROM admin.moderation_cases c
                              WHERE c.target_entity_type = ${type} AND c.target_entity_id = t.id
                                AND c.status IN ('open','investigating','escalated') AND c.deleted_at IS NULL)
          RETURNING id`.execute(scope.db);
        opened += rows.length;
      }
      return opened;
    });
  }
}

@Injectable()
export class RetentionRule extends ScheduledRule {
  readonly name = 'admin.retention';
  readonly everyMs = 24 * 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly handlers: RetentionHandlers,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async run(): Promise<Record<string, number>> {
    const policies = await this.tx.run(
      { actorType: 'system' },
      ({ db }) =>
        db
          .selectFrom('admin.data_retention_policies')
          .select(['id', 'entity_type', 'applies_to_status', 'retention_days', 'action'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute(),
      { readOnly: true },
    );
    const done: Record<string, number> = {};
    for (const p of policies) {
      if (p.action === 'archive') continue; // archived records stay where they are (52: kept for proof)
      const policy: RetentionPolicyRecord = {
        id: p.id,
        entityType: p.entity_type,
        appliesToStatus: p.applies_to_status,
        retentionDays: p.retention_days,
        action: p.action as RetentionPolicyRecord['action'],
      };
      const handler = this.handlers.get(p.entity_type);
      if (!handler) {
        this.logger.warn({ entity_type: p.entity_type, policy: p.id }, 'retention: no handler for entity type');
        continue;
      }
      try {
        const n = await this.tx.run({ actorType: 'system' }, (scope) => handler(scope, policy));
        done[`${p.entity_type}${p.applies_to_status ? `:${p.applies_to_status}` : ''}`] = n;
      } catch (err) {
        this.logger.error({ err, entity_type: p.entity_type, policy: p.id }, 'retention policy failed');
      }
    }
    return done;
  }
}

/** Platform tables purged by the admin module (no owning domain module). */
export function registerPlatformRetention(handlers: RetentionHandlers): void {
  handlers.register('DomainEventOutbox', async (scope, p) => {
    const r = await sql`DELETE FROM core.domain_event_outbox WHERE status = ${p.appliesToStatus ?? 'published'}
                         AND occurred_at < ${retentionCutoff(p)}`.execute(scope.db);
    return Number(r.numAffectedRows ?? 0);
  });
  handlers.register('BackgroundJob', async (scope, p) => {
    const r = await sql`DELETE FROM core.background_jobs WHERE status IN ('succeeded','failed','cancelled')
                         AND created_at < ${retentionCutoff(p)}`.execute(scope.db);
    return Number(r.numAffectedRows ?? 0);
  });
}
