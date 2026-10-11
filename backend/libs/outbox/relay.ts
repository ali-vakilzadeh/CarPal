// W1 outbox relay (41 §2.4, §6.1): woken by pg_notify('carpal_outbox') and a
// poll (default 1 s), it claims pending outbox rows with FOR UPDATE SKIP
// LOCKED (several relays can run), publishes them to the event bus (NATS
// JetStream in full mode; in-process in lite mode), and marks them published
// in the same transaction. A publish failure is retried with the row's
// attempt counter; after maxAttempts the row is marked failed for an alert.
import type pg from 'pg';
import { appMetrics } from '#libs/observability/index.js';
import type { Database } from '#libs/db/index.js';
import type { EventBus, EventEnvelope } from '#libs/infra/index.js';
import type { TxRunner } from '#libs/tenancy/index.js';

export interface OutboxRelayOptions {
  /** Worker pool (carpal_worker, system context). */
  tx: TxRunner;
  database: Database;
  bus: EventBus;
  pollMs: number;
  batchSize?: number;
  maxAttempts?: number;
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void };
}

export class OutboxRelay {
  #timer: NodeJS.Timeout | null = null;
  #listener: pg.PoolClient | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #stopped = true;

  constructor(private readonly o: OutboxRelayOptions) {}

  async start(): Promise<void> {
    this.#stopped = false;
    try {
      this.#listener = await this.o.database.pool.connect();
      this.#listener.on('notification', () => this.kick());
      this.#listener.on('error', (err) => this.o.log?.warn({ err }, 'outbox listener error; polling continues'));
      await this.#listener.query('LISTEN carpal_outbox');
    } catch (err) {
      this.o.log?.warn({ err }, 'outbox LISTEN unavailable; polling only');
    }
    this.#timer = setInterval(() => this.kick(), this.o.pollMs);
    this.#timer.unref();
    this.kick();
  }

  /** Requests a drain; concurrent requests coalesce into one more pass. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          while ((await this.drainOnce()) > 0 && !this.#stopped);
        } while (this.#again && !this.#stopped);
      } catch (err) {
        this.o.log?.error({ err }, 'outbox relay pass failed');
      } finally {
        this.#running = null;
      }
    })();
  }

  /** Resolves when the current pass (if any) has finished. */
  async settle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** Relays one batch; returns the number of rows handled. */
  async drainOnce(): Promise<number> {
    const batchSize = this.o.batchSize ?? 100;
    const maxAttempts = this.o.maxAttempts ?? 10;
    return this.o.tx.run({ actorType: 'system' }, async ({ db }) => {
      const rows = await db
        .selectFrom('core.domain_event_outbox')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('occurred_at')
        .orderBy('event_id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        const envelope: EventEnvelope = {
          eventId: row.event_id,
          type: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          organizationId: row.organization_id,
          payload: row.payload as Record<string, unknown>,
          schemaVersion: row.schema_version,
          occurredAt: new Date(row.occurred_at).toISOString(),
          requestId: row.request_id,
        };
        try {
          await this.o.bus.publish(envelope);
          await db
            .updateTable('core.domain_event_outbox')
            .set((eb) => ({ status: 'published', published_at: new Date(), attempts: eb('attempts', '+', 1), last_error: null }))
            .where('event_id', '=', row.event_id)
            .execute();
          appMetrics.outboxLag.record(Date.now() - new Date(row.occurred_at).getTime(), { event_type: row.event_type });
        } catch (err) {
          const attempts = row.attempts + 1;
          await db
            .updateTable('core.domain_event_outbox')
            .set({
              attempts,
              last_error: String((err as Error).message ?? err).slice(0, 1000),
              status: attempts >= maxAttempts ? 'failed' : 'pending',
            })
            .where('event_id', '=', row.event_id)
            .execute();
          this.o.log?.error(
            { err, event_id: row.event_id, attempts },
            attempts >= maxAttempts ? 'outbox event failed permanently' : 'outbox publish failed',
          );
        }
      }
      return rows.length;
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.settle();
    if (this.#listener) {
      try {
        await this.#listener.query('UNLISTEN carpal_outbox');
      } catch {
        // connection already gone
      }
      this.#listener.release();
      this.#listener = null;
    }
  }
}
