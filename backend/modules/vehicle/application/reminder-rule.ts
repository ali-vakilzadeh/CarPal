// W15 hourly rule of the vehicle module (41 §6.3): maintenance reminders move
// upcoming → due → overdue by date and mileage, and documents that expire
// within 30 days get a document_expiry reminder. Reminders that become due
// or overdue publish vehicle.reminder.due for the notification module (S6
// delivers them; not in 40 Appendix A yet, DI-36). System context. Since S25a the due windows (days before the due
// date, km before the due mileage) are the notification rules' (A-NOTIF-01, default 14 days and 500 km); the sweep
// never moves a due reminder back to upcoming when the window shrinks (snoozes and edits do that in the operations).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { NotificationRulesRead } from '#modules/notification/interface/notification-rules.js';
import {
  addDays,
  DEFAULT_DUE_WINDOW,
  DOCUMENT_EXPIRY_NOTICE_DAYS,
  reminderStatus,
  todayUtc,
  type DueWindow,
  type ReminderStatus,
} from '../domain/rules.js';

const BATCH = 500;
const IMPORTANT_DOCUMENTS = ['insurance', 'registration', 'inspection_report'];

@Injectable()
export class VehicleReminderRule extends ScheduledRule {
  readonly name = 'vehicle.reminders';
  readonly everyMs = 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    @Optional() private readonly rules?: NotificationRulesRead,
  ) {
    super();
  }

  /** The due windows of the notification rules (the defaults without the notification module). */
  async dueWindow(): Promise<DueWindow> {
    if (!this.rules) return DEFAULT_DUE_WINDOW;
    const r = await this.tx.run({ actorType: 'system' }, (scope) => this.rules!.get(scope), { readOnly: true });
    return { days: r.maintenanceDueWindowDays, km: r.mileageDueWindowKm };
  }

  async run(now = new Date()): Promise<{ created: number; changed: number }> {
    const today = todayUtc(now);
    const window = await this.dueWindow();
    const created = await this.#documentReminders(today);
    let changed = 0;
    let after: string | null = null;
    for (;;) {
      const batch: { changed: number; last: string | null } = await this.tx.run({ actorType: 'system' }, async (scope) => {
        let q = scope.db
          .selectFrom('vehicle.maintenance_reminders as r')
          .innerJoin('vehicle.vehicles as v', 'v.id', 'r.vehicle_id')
          .select([
            'r.id',
            'r.vehicle_id',
            'r.status',
            'r.reminder_type',
            'r.due_by_date',
            'r.due_by_mileage_km',
            'r.snoozed_until',
            'v.mileage_km',
            'v.owner_type',
            'v.owner_id',
          ])
          .where('r.status', 'in', ['upcoming', 'due', 'overdue'])
          .where('r.deleted_at', 'is', null)
          .where('v.deleted_at', 'is', null)
          .where('v.status', 'not in', ['sold', 'archived']);
        if (after) q = q.where('r.id', '>', after);
        const rows = await q.orderBy('r.id').limit(BATCH).execute();
        let n = 0;
        for (const r of rows) {
          const next = reminderStatus(
            {
              status: r.status as ReminderStatus,
              due_by_date: r.due_by_date,
              due_by_mileage_km: r.due_by_mileage_km,
              snoozed_until: r.snoozed_until,
            },
            r.mileage_km,
            today,
            window,
          );
          if (next === r.status) continue;
          // S25a: a narrower window never takes a due reminder back (it was announced already).
          if (r.status === 'due' && next === 'upcoming') continue;
          await scope.db.updateTable('vehicle.maintenance_reminders').set({ status: next }).where('id', '=', r.id).execute();
          n++;
          if (next === 'due' || next === 'overdue')
            await publishEvent(scope, {
              type: 'vehicle.reminder.due',
              aggregateType: 'maintenance_reminder',
              aggregateId: r.id,
              payload: {
                vehicle_id: r.vehicle_id,
                status: next,
                reminder_type: r.reminder_type,
                owner_type: r.owner_type,
                owner_id: r.owner_id,
              },
            });
        }
        return { changed: n, last: rows.length === BATCH ? rows.at(-1)!.id : null };
      });
      changed += batch.changed;
      if (!batch.last) break;
      after = batch.last;
    }
    return { created, changed };
  }

  /** Active documents expiring soon get one document_expiry reminder each (identified by vehicle, due date and title). */
  async #documentReminders(today: string): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const docs = await scope.db
        .selectFrom('vehicle.vehicle_documents as d')
        .innerJoin('vehicle.vehicles as v', 'v.id', 'd.vehicle_id')
        .select(['d.vehicle_id', 'd.title', 'd.document_type', 'd.expires_at'])
        .where('d.status', '=', 'active')
        .where('d.deleted_at', 'is', null)
        .where('d.expires_at', '>=', today)
        .where('d.expires_at', '<=', addDays(today, DOCUMENT_EXPIRY_NOTICE_DAYS))
        .where('v.deleted_at', 'is', null)
        .where('v.status', 'not in', ['sold', 'archived'])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('vehicle.maintenance_reminders as r')
                .select('r.id')
                .whereRef('r.vehicle_id', '=', 'd.vehicle_id')
                .where('r.reminder_type', '=', 'document_expiry')
                .where('r.source', '=', 'rule')
                .whereRef('r.due_by_date', '=', 'd.expires_at')
                .where('r.title', '=', sql<string>`left('Renew ' || d.title, 120)`),
            ),
          ),
        )
        .limit(BATCH)
        .execute();
      for (const d of docs)
        await scope.db
          .insertInto('vehicle.maintenance_reminders')
          .values({
            vehicle_id: d.vehicle_id,
            reminder_type: 'document_expiry',
            title: `Renew ${d.title}`.slice(0, 120),
            reason: `${d.document_type} expires on ${d.expires_at}`,
            source: 'rule',
            due_by_date: d.expires_at,
            priority: IMPORTANT_DOCUMENTS.includes(d.document_type) ? 'high' : 'medium',
            // The status rule below makes it due (it is within the due window).
            status: 'upcoming',
          })
          .execute();
      return docs.length;
    });
  }
}
