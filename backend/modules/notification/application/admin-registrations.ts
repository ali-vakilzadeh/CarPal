// Notification's parts of S8 platform flows: retention of notifications and
// deliveries (52 DataRetentionPolicy Notification 180 d, NotificationDelivery
// 90 d) and data subject requests (a user's notifications are exported;
// notifications, preferences and push tokens are deleted with the account).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { countByStatus, failureCounts, retentionCutoff, RetentionHandlers, SystemHealthSignals } from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';

@Injectable()
export class NotificationAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly health?: SystemHealthSignals,
  ) {}

  onModuleInit(): void {
    // Backend S21 (BR-17): deliveries that failed on any channel, by the time they failed.
    this.health?.register('notification_delivery_failures', (scope, now) =>
      failureCounts(scope, sql`FROM notification.notification_deliveries WHERE status = 'failed'`, sql`updated_at`, now),
    );
    this.retention?.register(
      'NotificationDelivery',
      async (scope, p) => {
        const r = await sql`DELETE FROM notification.notification_deliveries WHERE created_at < ${retentionCutoff(p)}`.execute(scope.db);
        return Number(r.numAffectedRows ?? 0);
      },
      async (scope, p) =>
        countByStatus(
          (
            await sql<{ status: string; n: string }>`SELECT status, count(*) AS n FROM notification.notification_deliveries
                                                      WHERE created_at < ${retentionCutoff(p)} GROUP BY status`.execute(scope.db)
          ).rows,
        ),
    );
    this.retention?.register(
      'Notification',
      async (scope, p) => {
        const cutoff = retentionCutoff(p);
        await sql`DELETE FROM notification.notification_deliveries d USING notification.notifications n
                   WHERE d.notification_id = n.id AND n.created_at < ${cutoff}`.execute(scope.db);
        const r = await sql`DELETE FROM notification.notifications WHERE created_at < ${cutoff}`.execute(scope.db);
        return Number(r.numAffectedRows ?? 0);
      },
      async (scope, p) => ({
        affected: Number(
          (
            await sql<{ n: string }>`SELECT count(*) AS n FROM notification.notifications WHERE created_at < ${retentionCutoff(p)}`.execute(
              scope.db,
            )
          ).rows[0]?.n ?? 0,
        ),
      }),
    );
    this.personal?.register('notification', {
      async export(scope, userId) {
        const rows = await scope.db
          .selectFrom('notification.notifications')
          .select(['id', 'event_type', 'category', 'template_key', 'created_at', 'read_at'])
          .where('recipient_user_id', '=', userId)
          .orderBy('id', 'desc')
          .limit(5000)
          .execute();
        return [
          {
            section: 'notifications',
            records: rows.map((r) => ({
              id: r.id,
              fields: {
                event_type: r.event_type,
                category: r.category,
                template_key: r.template_key,
                created_at: r.created_at.toISOString(),
                read_at: r.read_at ? r.read_at.toISOString() : null,
              },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        let n = 0;
        const run = async (q: ReturnType<typeof sql>) => {
          n += Number((await q.execute(scope.db)).numAffectedRows ?? 0);
        };
        await run(sql`DELETE FROM notification.notification_deliveries d USING notification.notifications x
                       WHERE d.notification_id = x.id AND x.recipient_user_id = ${userId}::uuid`);
        await run(sql`DELETE FROM notification.notifications WHERE recipient_user_id = ${userId}::uuid`);
        await run(sql`DELETE FROM notification.notification_preferences WHERE user_id = ${userId}::uuid`);
        await run(sql`DELETE FROM notification.push_device_tokens WHERE user_id = ${userId}::uuid`);
        return n;
      },
    });
  }
}
