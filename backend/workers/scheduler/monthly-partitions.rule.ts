// 41 §6.3 "daily: create next monthly partitions (audit, MCP log, analytics)"
// (libs): core.ensure_monthly_partitions keeps three months ahead (worker role
// only). The analytics database's partitions come with the analytics
// pipeline (S8).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class MonthlyPartitionsRule extends ScheduledRule {
  readonly name = 'libs.monthly_partitions';
  readonly everyMs = 24 * 3_600_000;

  constructor(
    private readonly tx: TxRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async run(): Promise<number> {
    const created = await this.tx.run({ actorType: 'system' }, async ({ db }) => {
      let n = 0;
      for (const table of ['analytics.audit_logs', 'ai_mcp.mcp_access_logs']) {
        const { rows } = await sql<{ n: number }>`SELECT core.ensure_monthly_partitions(${table}, 3) AS n`.execute(db);
        n += rows[0]!.n;
      }
      return n;
    });
    if (created > 0) this.logger.info({ created }, 'monthly partitions created');
    return created;
  }
}
