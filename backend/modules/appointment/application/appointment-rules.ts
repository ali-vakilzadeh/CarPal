// W15 rule of the appointment module (41 §6.3), system context:
//   appointment.reminders (hourly) publishes appointment.reminder.due once for
//   every confirmed appointment that starts within the next 24 hours (W5
//   sends appointment_reminder to the requester). Each appointment is
//   reminded once (a KV mark lives 2 days).
import { Injectable } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

const AHEAD_MS = 24 * 3_600_000;

@Injectable()
export class AppointmentReminderRule extends ScheduledRule {
  readonly name = 'appointment.reminders';
  readonly everyMs = 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    @InjectInfra() private readonly infra: Infra,
  ) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    const due = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('appointment.appointments')
        .select(['id', 'provider_organization_id', 'requester_user_id', 'requester_organization_id', 'confirmed_start_at'])
        .where('status', '=', 'confirmed')
        .where('confirmed_start_at', '>', now)
        .where('confirmed_start_at', '<=', new Date(now.getTime() + AHEAD_MS))
        .where('deleted_at', 'is', null)
        .orderBy('confirmed_start_at')
        .limit(1000)
        .execute(),
    );
    let n = 0;
    for (const a of due) {
      if (!(await this.infra.kv.set(`appointment:reminded:${a.id}`, '1', { ttlMs: 2 * 86_400_000, mode: 'NX' }))) continue;
      await this.tx.run({ actorType: 'system' }, (scope) =>
        publishEvent(scope, {
          type: 'appointment.reminder.due',
          aggregateType: 'appointment',
          aggregateId: a.id,
          payload: {
            provider_organization_id: a.provider_organization_id,
            requester_user_id: a.requester_user_id,
            requester_organization_id: a.requester_organization_id,
            confirmed_start_at: new Date(a.confirmed_start_at!).toISOString(),
          },
        }),
      );
      n++;
    }
    return n;
  }
}
