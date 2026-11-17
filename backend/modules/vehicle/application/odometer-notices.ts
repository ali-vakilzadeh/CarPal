// The in-app notice of the monthly odometer prompt is "done" when the owner answers or skips (S26b.T1). The notice is a
// notification row of the notification module; the statement is the one of notifications.mark_read for that row.
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';

export async function closeOdometerNotices(scope: TxScope, userId: string, vehicleId: string): Promise<void> {
  await scope.db
    .updateTable('notification.notifications')
    .set({ read_at: sql<Date>`now()`, status: 'read' })
    .where('recipient_user_id', '=', userId)
    .where('event_type', '=', 'odometer_prompt')
    .where('reference_entity_id', '=', vehicleId)
    .where('read_at', 'is', null)
    .execute();
}
