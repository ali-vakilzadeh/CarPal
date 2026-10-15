// 41 §6.3 hourly "expired jobs" (libs): a queued or running background job
// past its expires_at (7 days) failed silently (a lost lite queue entry, a
// crashed worker); it is marked failed so jobs.get stops reporting progress.
import { Injectable } from '@nestjs/common';
import { ScheduledRule } from '#libs/jobs/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class JobsExpiryRule extends ScheduledRule {
  readonly name = 'libs.jobs_expiry';
  readonly everyMs = 3_600_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async ({ db }) => {
      const r = await db
        .updateTable('core.background_jobs')
        .set({ status: 'failed', error_code: 'UNAVAILABLE', finished_at: new Date() })
        .where('status', 'in', ['queued', 'running'])
        .where('expires_at', '<=', new Date())
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
  }
}
