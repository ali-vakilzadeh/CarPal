// W12 analytics pipeline (41 §2.4; 52 AnalyticsEvent, ActorPseudonym; 43 §23).
// Client batches accepted by events.ingest arrive on the analytics.ingest
// queue; business events arrive from the outbox (FORWARDED_EVENTS). Actors
// are pseudonymized here, in the worker, with the per-user key of
// analytics.actor_pseudonyms (the API roles cannot read keys): the stored id
// is HMAC(key, user id), so deleting the key on user deletion makes every
// past event unlinkable. Events are written to the separate analytics
// database (carpal_analytics_writer); daily aggregates are read back with the
// reader role and upserted into events.daily_metrics with the gauges other
// modules register; monthly partitions are kept three months ahead.
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import { AnalyticsDatabase } from '#libs/db/index.js';
import type { EventEnvelope, QueuedJob } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { InjectConfig, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { ACTOR_KEYS, countMetric, FORWARDED_EVENTS, forwardedProperties, pseudonym } from '../domain/events.js';
import { MetricGauges } from '../interface/analytics.js';

export const ANALYTICS_INGEST_QUEUE = 'analytics.ingest';

/** The analytics database pools of this process (closed on shutdown). */
@Injectable()
export class AnalyticsPools implements OnApplicationShutdown {
  readonly writer: AnalyticsDatabase;
  readonly reader: AnalyticsDatabase;

  constructor(@InjectConfig() config: CarpalConfig) {
    this.writer = new AnalyticsDatabase(config, 'carpal_analytics_writer', { max: 4 });
    this.reader = new AnalyticsDatabase(config, 'carpal_analytics_reader', { max: 4 });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.writer.close();
    await this.reader.close();
  }
}

/** A client batch on the ingest queue (events.ingest → W12); validated already, no personal data besides the user id. */
export interface IngestBatch {
  user_id: string | null;
  platform: string;
  app_version: string;
  locale: string | null;
  events: { event_name: string; schema_version: number; occurred_at: string; session_id?: string; properties: Record<string, unknown> }[];
}

export interface AnalyticsRow {
  event_name: string;
  schema_version: number;
  occurred_at: Date;
  actor_pseudonymous_id: string | null;
  organization_id: string | null;
  session_id: string | null;
  platform: string;
  app_version: string | null;
  locale: string | null;
  country: string | null;
  properties: string | null;
}

@Injectable()
export class AnalyticsSink {
  constructor(
    private readonly tx: TxRunner,
    private readonly pools: AnalyticsPools,
    private readonly users: UserCards,
  ) {}

  /** The pseudonym of a user (key created on first use; none for deleted accounts, so a late event cannot re-link them). */
  async pseudonymOf(scope: TxScope, userId: string | null): Promise<string | null> {
    if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) return null;
    const card = (await this.users.cards(scope, [userId])).get(userId);
    if (!card || card.status === 'deleted') return null;
    await sql`INSERT INTO analytics.actor_pseudonyms (user_id) VALUES (${userId}::uuid) ON CONFLICT (user_id) DO NOTHING`.execute(scope.db);
    const { rows } = await sql<{
      pseudonym_key: Buffer;
    }>`SELECT pseudonym_key FROM analytics.actor_pseudonyms WHERE user_id = ${userId}::uuid`.execute(scope.db);
    return rows[0] ? pseudonym(rows[0].pseudonym_key, userId) : null;
  }

  async write(rows: AnalyticsRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.pools.writer.db.insertInto('events.analytics_events').values(rows).execute();
  }

  async ingest(batch: IngestBatch): Promise<number> {
    const actor = await this.tx.run({ actorType: 'system' }, (scope) => this.pseudonymOf(scope, batch.user_id));
    await this.write(
      batch.events.map((e) => ({
        event_name: e.event_name,
        schema_version: e.schema_version,
        occurred_at: new Date(e.occurred_at),
        actor_pseudonymous_id: actor,
        organization_id: null,
        session_id: e.session_id ?? null,
        platform: batch.platform,
        app_version: batch.app_version,
        locale: batch.locale,
        country: null,
        properties: Object.keys(e.properties).length ? JSON.stringify(e.properties) : null,
      })),
    );
    return batch.events.length;
  }

  /** Deletes a user's pseudonym key (DSR deletion, user.deletion.completed): their events become unlinkable. */
  async forget(scope: TxScope, userId: string): Promise<number> {
    const r = await sql`DELETE FROM analytics.actor_pseudonyms WHERE user_id = ${userId}::uuid`.execute(scope.db);
    return Number(r.numAffectedRows ?? 0);
  }
}

/** W12 ingest queue processor (hosted by workers/analytics-pipeline). */
@Injectable()
export class AnalyticsIngestProcessor {
  constructor(
    private readonly sink: AnalyticsSink,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async run(job: QueuedJob): Promise<void> {
    const batch = job.data as unknown as IngestBatch | undefined;
    if (!batch || !Array.isArray(batch.events)) return;
    try {
      await this.sink.ingest(batch);
    } catch (err) {
      // Analytics never blocks the product: a failed batch is logged and dropped (pseudonymous counts only).
      this.logger.error({ err, events: batch.events.length }, 'analytics ingest failed');
    }
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);

/** W12 consumer: business events copied to the analytics database, actor pseudonymized. */
@Injectable()
export class AnalyticsEventConsumer extends EventConsumer {
  readonly name = 'analytics.pipeline';
  readonly subjects = Object.keys(FORWARDED_EVENTS);

  constructor(
    private readonly tx: TxRunner,
    private readonly sink: AnalyticsSink,
  ) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const actorId =
      e.type === 'user.registered' && e.aggregateType === 'user'
        ? e.aggregateId
        : (ACTOR_KEYS.map((k) => str(e.payload[k])).find((x) => x) ?? null);
    const actor = await this.tx.run({ actorType: 'system' }, async (scope) => {
      if (e.type === 'user.deletion.completed') {
        await this.sink.forget(scope, e.aggregateId);
        return null;
      }
      return this.sink.pseudonymOf(scope, actorId);
    });
    await this.sink.write([
      {
        event_name: e.type,
        schema_version: e.schemaVersion,
        occurred_at: new Date(e.occurredAt),
        actor_pseudonymous_id: actor,
        organization_id: e.organizationId ?? str(e.payload.organization_id) ?? str(e.payload.subject_organization_id),
        session_id: null,
        platform: 'backend',
        app_version: null,
        locale: null,
        country: null,
        properties: JSON.stringify(forwardedProperties(e.type, e.payload)),
      },
    ]);
  }
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily aggregates behind admin.analytics_dashboard (hourly, recomputing
 * yesterday and today): event counts per name from the analytics database
 * and the registered gauges from the primary database.
 */
@Injectable()
export class DailyMetricsRule extends ScheduledRule {
  readonly name = 'analytics.daily_metrics';
  readonly everyMs = 3_600_000;

  constructor(
    private readonly pools: AnalyticsPools,
    private readonly tx: TxRunner,
    private readonly gauges: MetricGauges,
  ) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    let n = 0;
    for (const offset of [1, 0]) {
      const from = new Date(`${dayOf(new Date(now.getTime() - offset * 86_400_000))}T00:00:00Z`);
      const to = new Date(from.getTime() + 86_400_000);
      const counts = await this.pools.reader.db
        .selectFrom('events.analytics_events')
        .select(['event_name', (eb) => eb.fn.countAll<string>().as('n')])
        .where('occurred_at', '>=', from)
        .where('occurred_at', '<', to)
        .groupBy('event_name')
        .execute();
      const values: { metric_key: string; value: number }[] = counts.map((c) => ({
        metric_key: countMetric(c.event_name),
        value: Number(c.n),
      }));
      // Gauges are a state at aggregation time: written for today only.
      if (offset === 0)
        for (const [key, gauge] of this.gauges.entries())
          values.push({ metric_key: key, value: await this.tx.run({ actorType: 'system' }, (scope) => gauge(scope), { readOnly: true }) });
      for (const v of values) {
        await this.pools.writer.db
          .insertInto('events.daily_metrics')
          .values({ metric_date: dayOf(from), metric_key: v.metric_key, dimension_key: '', value: String(v.value) })
          .onConflict((oc) =>
            oc
              .columns(['metric_date', 'metric_key', 'dimension_key'])
              .doUpdateSet({ value: String(v.value), computed_at: sql<Date>`now()` }),
          )
          .execute();
        n++;
      }
    }
    return n;
  }
}

/** 41 §6.3 daily: next monthly partitions of the analytics events (analytics database). */
@Injectable()
export class AnalyticsPartitionsRule extends ScheduledRule {
  readonly name = 'analytics.monthly_partitions';
  readonly everyMs = 24 * 3_600_000;

  constructor(
    private readonly pools: AnalyticsPools,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async run(): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT events.ensure_monthly_partitions(3) AS n`.execute(this.pools.writer.db);
    const created = Number(rows[0]?.n ?? 0);
    if (created > 0) this.logger.info({ created }, 'analytics partitions created');
    return created;
  }
}
