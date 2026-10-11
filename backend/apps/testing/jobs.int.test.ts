// L10 jobs end to end: a use case creates the durable job row in its own
// transaction (API role, RLS) and the queue entry after commit; the worker's
// JobRunner moves it to running and succeeded. Plus the W15 platform rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { Database } from '#libs/db/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { acceptedJob, JobRunner, JobService } from '#libs/jobs/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { MonthlyPartitionsRule } from '#workers/scheduler/monthly-partitions.rule.js';
import { testConfig, testLogger } from './test-app.js';

const config = testConfig();
let infra: Infra;
let apiDb: Database;
let workerDb: Database;
let api: TxRunner;
let worker: TxRunner;

beforeAll(() => {
  infra = createInfra(config, { dataDir: null });
  apiDb = new Database(config, 'carpal_api', { max: 2 });
  workerDb = new Database(config, 'carpal_worker', { max: 2 });
  api = new TxRunner(apiDb);
  worker = new TxRunner(workerDb);
});
afterAll(async () => {
  await infra.close();
  await apiDb.close();
  await workerDb.close();
});

const status = (id: string) =>
  worker.run({ actorType: 'system' }, ({ db }) =>
    db.selectFrom('core.background_jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );

describe('background jobs', () => {
  it('creates the job in the use-case transaction, enqueues after commit, and the worker completes it', async () => {
    const jobs = new JobService(infra.jobs);
    const runner = new JobRunner(worker, infra.jobs);
    const seen: string[] = [];
    const resultId = uuidv7();
    runner.register('test-export', async ({ job, progress }) => {
      seen.push(job.id);
      await progress(50);
      return { result: { type: 'fleet_export', id: resultId } };
    });

    const userId = uuidv7();
    const response = await api.run({ actorType: 'user', userId }, async (scope) => {
      const row = await jobs.create(scope, {
        kind: 'fleet_export',
        ownerUserId: userId,
        owningModule: 'fleet',
        inputSummary: { rows: 3 },
        queue: 'test-export',
      });
      expect(seen).toEqual([]); // not enqueued before commit
      return acceptedJob(row);
    });
    expect(response).toMatchObject({
      status: 202,
      body: { kind: 'fleet_export', status: 'queued', version: 1 },
      headers: { location: `/v1/jobs/${response.body.id}` },
    });
    await infra.jobs.idle();
    expect(seen).toEqual([response.body.id]);
    expect(await status(response.body.id)).toMatchObject({
      status: 'succeeded',
      progress: 100,
      result_type: 'fleet_export',
      result_id: resultId,
    });
  });

  it('does not enqueue a job whose transaction rolled back, and never starts a cancelled job', async () => {
    const jobs = new JobService(infra.jobs);
    const runner = new JobRunner(worker, infra.jobs);
    const started: string[] = [];
    runner.register('test-cancel', async ({ job }) => {
      started.push(job.id);
      return { errorCode: 'INTERNAL' };
    });
    const userId = uuidv7();
    await expect(
      api.run({ actorType: 'user', userId }, async (scope) => {
        await jobs.create(scope, { kind: 'data_export', ownerUserId: userId, owningModule: 'identity', queue: 'test-cancel' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    // Cancel before the worker picks it up: the runner skips it.
    const row = await api.run({ actorType: 'user', userId }, (scope) =>
      jobs.create(scope, { kind: 'data_export', ownerUserId: userId, owningModule: 'identity', queue: 'test-cancel-later' }),
    );
    await api.run({ actorType: 'user', userId }, (scope) => jobs.cancel(scope, row));
    runner.register('test-cancel-later', async ({ job }) => {
      started.push(job.id);
      return { errorCode: 'INTERNAL' };
    });
    await infra.jobs.idle();
    expect(started).toEqual([]);
    expect((await status(row.id)).status).toBe('cancelled');
  });
});

describe('W15 platform rule', () => {
  it('keeps monthly partitions of the audit and MCP logs three months ahead (worker role)', async () => {
    const rule = new MonthlyPartitionsRule(worker, testLogger(config));
    await rule.run();
    expect(await rule.run()).toBe(0); // idempotent
  });
});
