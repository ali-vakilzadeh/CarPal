// S2 acceptance: "An outbox event written in a tx reaches a test consumer exactly once."
// The event is published by the API role inside its transaction; the worker
// deployable (W1 relay + consumer registry) delivers it through the event bus.
import { Injectable, Module, type INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { Database } from '#libs/db/index.js';
import { createInfra, type EventEnvelope, type Infra } from '#libs/infra/index.js';
import { EventConsumer, publishEvent } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { OutboxRelayService } from '#workers/outbox-relay/outbox-relay.module.js';
import { createTestWorker, testConfig } from './test-app.js';

const received: EventEnvelope[] = [];
const failures: number[] = [];

@Injectable()
class ProbeConsumer extends EventConsumer {
  readonly name = 'test.probe-consumer';
  readonly subjects = ['test_probe.*'];
  async handle(event: EventEnvelope): Promise<void> {
    received.push(event);
  }
}

@Injectable()
class FailingConsumer extends EventConsumer {
  readonly name = 'test.failing-consumer';
  readonly subjects = ['test_probe.failing'];
  override readonly maxDeliver = 3;
  override readonly backoffMs = [5];
  async handle(): Promise<void> {
    failures.push(Date.now());
    throw new Error('consumer broken');
  }
}

@Module({ providers: [ProbeConsumer, FailingConsumer] })
class ProbeModule {}

const config = testConfig();
let infra: Infra;
let worker: INestApplicationContext;
let apiDb: Database;
let api: TxRunner;
let workerDb: Database;
let system: TxRunner;

beforeAll(async () => {
  infra = createInfra(config, { dataDir: null });
  worker = await createTestWorker({ infra, imports: [ProbeModule] });
  apiDb = new Database(config, 'carpal_api', { max: 2 });
  api = new TxRunner(apiDb);
  workerDb = new Database(config, 'carpal_worker', { max: 2 });
  system = new TxRunner(workerDb);
});

afterAll(async () => {
  await worker.close();
  await apiDb.close();
  await workerDb.close();
  await infra.close();
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const relay = () => worker.get(OutboxRelayService).relay;

describe('outbox → relay → consumer', () => {
  it('delivers an event written in a transaction exactly once', async () => {
    const userId = uuidv7();
    const aggregateId = uuidv7();
    const eventId = await api.run({ actorType: 'user', userId, requestId: uuidv7() }, (scope) =>
      publishEvent(scope, { type: 'test_probe.created', aggregateType: 'probe', aggregateId, payload: { n: 1 } }),
    );
    await until(() => received.some((e) => e.eventId === eventId));
    // Run the relay again and replay the same message on the bus: still one delivery.
    await relay().drainOnce();
    const envelope = received.find((e) => e.eventId === eventId)!;
    await infra.bus.publish(envelope);
    await infra.bus.publish(envelope);
    await relay().settle();
    await infra.bus.idle();
    expect(received.filter((e) => e.eventId === eventId)).toHaveLength(1);
    expect(envelope).toMatchObject({
      type: 'test_probe.created',
      aggregateType: 'probe',
      aggregateId,
      payload: { n: 1 },
      schemaVersion: 1,
    });

    const row = await system.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('core.domain_event_outbox')
        .select(['status', 'published_at', 'attempts'])
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('published');
    expect(row.published_at).not.toBeNull();
  });

  it('never delivers the event of a rolled-back transaction', async () => {
    const aggregateId = uuidv7();
    await expect(
      api.run({ actorType: 'user', userId: uuidv7() }, async (scope) => {
        await publishEvent(scope, { type: 'test_probe.rolled_back', aggregateType: 'probe', aggregateId });
        throw new ApiError('INVALID_TRANSITION');
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await relay().drainOnce();
    await infra.bus.idle();
    expect(received.some((e) => e.aggregateId === aggregateId)).toBe(false);
  });

  it('retries a failing consumer with backoff, then dead-letters the event', async () => {
    const eventId = await api.run({ actorType: 'user', userId: uuidv7() }, (scope) =>
      publishEvent(scope, { type: 'test_probe.failing', aggregateType: 'probe', aggregateId: uuidv7() }),
    );
    await until(() => failures.length >= 3);
    await infra.bus.idle();
    const dead = await infra.deadLetters.list('test.failing-consumer');
    expect(dead.find((d) => d.event.eventId === eventId)).toMatchObject({ attempts: 3, error: 'consumer broken' });
    // The healthy consumer subscribed to the same subject pattern got it once.
    expect(received.filter((e) => e.eventId === eventId)).toHaveLength(1);
  });

  it('lets every application role publish events and write audit entries in its transaction', async () => {
    const id = uuidv7();
    const marks = await api.run({ actorType: 'user', userId: id, requestId: id }, async (scope) => {
      await writeAudit(scope, { action: 'test.probe_audited', entityType: 'probe', entityId: id, reason: 'integration test' });
      await publishEvent(scope, { type: 'test_probe.audited', aggregateType: 'probe', aggregateId: id });
      return [...scope.marks];
    });
    expect(marks).toEqual(['audit', 'event:test_probe.audited']);
    const audit = await system.run(
      { actorType: 'system' },
      async ({ db }) =>
        (
          await sql<{ actor_type: string; actor_id: string; request_id: string }>`
        SELECT actor_type, actor_id::text, request_id FROM analytics.audit_logs WHERE entity_id = ${id}::uuid`.execute(db)
        ).rows,
    );
    expect(audit).toEqual([{ actor_type: 'user', actor_id: id, request_id: id }]);
  });
});
