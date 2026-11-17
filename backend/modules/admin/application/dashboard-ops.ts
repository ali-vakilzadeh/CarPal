// Dashboard aggregates of the admin plane (backend S21; 40 §23.5 admin.system_health, admin.work_summary; Docs/23
// A-DASH-01 System and Queues, My work). Both are aggregates only: the owning modules count their own records through
// the SystemHealthSignals and WorkQueues registries, in the caller's read-only staff transaction.
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { Geocoder } from '#libs/geo/index.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectConfig, InjectInfra } from '#libs/runtime/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { staffOf, SystemHealthSignals, WORK_QUEUE_KEYS, WorkQueues, type FailureCounts, type SystemHealthKey } from '../interface/admin.js';
import { DEFAULT_WORK_TIME_ZONE, summarize } from './work-sla.js';

const HEALTH_KEYS: readonly SystemHealthKey[] = ['import_failures', 'notification_delivery_failures', 'media_scan_failures'];

/** Items read per queue for the SLA states (the open count is always exact). */
export const WORK_ITEMS_LIMIT = 5000;

@Injectable()
@Operation('admin.system_health')
export class SystemHealthHandler implements OperationHandler {
  constructor(
    private readonly signals: SystemHealthSignals,
    @InjectInfra() private readonly infra: Infra,
    @InjectConfig() private readonly config: CarpalConfig,
    private readonly geocoder: Geocoder,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const now = new Date();
    const signals = await ctx.tx(
      async (scope) => {
        const out = [];
        for (const key of HEALTH_KEYS) {
          const total: FailureCounts = { last24h: 0, last7d: 0, last30d: 0, lastFailureAt: null };
          for (const signal of this.signals.get(key)) {
            const c = await signal(scope, now);
            total.last24h += c.last24h;
            total.last7d += c.last7d;
            total.last30d += c.last30d;
            if (c.lastFailureAt && (!total.lastFailureAt || c.lastFailureAt > total.lastFailureAt)) total.lastFailureAt = c.lastFailureAt;
          }
          out.push({
            key,
            last_24h: total.last24h,
            last_7d: total.last7d,
            last_30d: total.last30d,
            last_failure_at: total.lastFailureAt ? total.lastFailureAt.toISOString() : null,
          });
        }
        return out;
      },
      { readOnly: true },
    );
    return {
      body: {
        generated_at: now.toISOString(),
        signals,
        // 1.5.0 (S26a, DQ-28): which providers carry messages, and whether SMS really leaves the server.
        sms_provider: this.infra.smsGateway.provider,
        sms_simulated: this.infra.smsGateway.simulated,
        mail_transport: this.config.mail.transport,
        // 1.5.0 (S26b, DQ-29): the geocoder and the provider requests of today and of 30 days (quota and cost).
        geocoder: await this.geocoder.usage(),
      },
    };
  }
}

@Injectable()
@Operation('admin.work_summary')
export class WorkSummaryHandler implements OperationHandler {
  constructor(private readonly queues: WorkQueues) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const timeZone = ctx.timezone ?? DEFAULT_WORK_TIME_ZONE;
    const now = new Date();
    const items = await ctx.tx(
      async (scope) => {
        const out = [];
        for (const key of WORK_QUEUE_KEYS) {
          const queue = this.queues.get(key);
          // Only the queues the caller's roles may list (the list operation's STF roles).
          if (!queue || !queue.roles.some((r) => s.roles.includes(r))) continue;
          const { open, items: read } = await queue.items(scope, s, WORK_ITEMS_LIMIT);
          out.push({
            queue: key,
            ...summarize(open, read, { now: now.getTime(), timeZone, assignable: queue.assignable, timed: queue.timed }),
          });
        }
        return out;
      },
      { readOnly: true },
    );
    return { body: { generated_at: now.toISOString(), time_zone: timeZone, items } };
  }
}
