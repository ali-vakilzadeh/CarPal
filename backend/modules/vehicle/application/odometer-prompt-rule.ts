// Monthly odometer prompt sweep (backend S26b.T1, DQ-24; Docs/21 C-GARAGE-08). From the notification rules' digest hour
// (region time) every active personal vehicle (DQ-27) whose cycle is `odometer_prompt_days` old is asked once for a
// reading (vehicle.odometer_prompt.due -> notice in the app and push, category service_reminders, so the person can
// switch it off; quiet hours apply). Answering is voluntary: a reading that is the newest by recorded_at or a skip ends
// the prompt (see domain/odometer-prompt.ts). System context.
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { DEFAULT_NOTIFICATION_RULES, NotificationRulesRead } from '#modules/notification/interface/notification-rules.js';
import { cycleStart, regionHour, shouldPrompt } from '../domain/odometer-prompt.js';

const BATCH = 500;

@Injectable()
export class VehicleOdometerPromptRule extends ScheduledRule {
  readonly name = 'vehicle.odometer_prompts';
  readonly everyMs = 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    @Optional() private readonly rules?: NotificationRulesRead,
  ) {
    super();
  }

  /** Returns the number of prompts published. */
  async run(now = new Date()): Promise<number> {
    const r = this.rules
      ? await this.tx.run({ actorType: 'system' }, (scope) => this.rules!.get(scope), { readOnly: true })
      : DEFAULT_NOTIFICATION_RULES;
    const days = r.odometerPromptDays;
    if (days <= 0 || regionHour(now) < r.digestHour) return 0;
    let sent = 0;
    let after: string | null = null;
    for (;;) {
      const batch: { sent: number; last: string | null } = await this.tx.run({ actorType: 'system' }, async (scope) => {
        let q = scope.db
          .selectFrom('vehicle.vehicles as v')
          .leftJoin('vehicle.odometer_prompt_state as s', 's.vehicle_id', 'v.id')
          .select([
            'v.id',
            'v.owner_id',
            'v.created_at',
            's.prompted_at',
            's.skipped_at',
            (eb) =>
              eb
                .selectFrom('vehicle.vehicle_mileage_logs as m')
                .select(sql<Date | null>`max(m.recorded_at)`.as('newest'))
                .whereRef('m.vehicle_id', '=', 'v.id')
                .where('m.deleted_at', 'is', null)
                .as('newest_reading_at'),
          ])
          .where('v.owner_type', '=', 'user')
          .where('v.status', '=', 'active')
          .where('v.deleted_at', 'is', null);
        if (after) q = q.where('v.id', '>', after);
        const rows = await q.orderBy('v.id').limit(BATCH).execute();
        let n = 0;
        for (const v of rows) {
          const facts = {
            newestReadingAt: v.newest_reading_at,
            createdAt: v.created_at,
            skippedAt: v.skipped_at,
            promptedAt: v.prompted_at,
          };
          if (!shouldPrompt(facts, days, now)) continue;
          await scope.db
            .insertInto('vehicle.odometer_prompt_state')
            .values({ vehicle_id: v.id, prompted_at: now })
            .onConflict((oc) => oc.column('vehicle_id').doUpdateSet({ prompted_at: now, updated_at: now }))
            .execute();
          await publishEvent(scope, {
            type: 'vehicle.odometer_prompt.due',
            aggregateType: 'vehicle',
            aggregateId: v.id,
            payload: { owner_id: v.owner_id, cycle_started_at: cycleStart(facts).toISOString(), days },
          });
          n++;
        }
        return { sent: n, last: rows.length === BATCH ? rows.at(-1)!.id : null };
      });
      sent += batch.sent;
      if (!batch.last) break;
      after = batch.last;
    }
    return sent;
  }
}
