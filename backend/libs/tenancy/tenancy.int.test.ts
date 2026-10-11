import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { Database, registerConstraintErrors } from '#libs/db/index.js';
import { TxRunner } from './index.js';

const config = loadConfig();
const apiDb = new Database(config, 'carpal_api', { max: 3 });
const workerDb = new Database(config, 'carpal_worker', { max: 2 });
const api = new TxRunner(apiDb);
const worker = new TxRunner(workerDb);

afterAll(async () => {
  await apiDb.close();
  await workerDb.close();
});

const ctxValues = sql<{ actor: string; me: string | null; org: string | null; rid: string | null }>`
  SELECT core.actor_type() AS actor, core.me()::text AS me, core.my_org()::text AS org, core.request_id() AS rid`;

describe('TxRunner (L5 tenancy)', () => {
  it('sets the RLS context first in every transaction, transaction-local', async () => {
    const userId = uuidv7();
    const requestId = uuidv7();
    const row = await api.run({ actorType: 'user', userId, requestId }, async ({ db }) => (await ctxValues.execute(db)).rows[0]);
    expect(row).toEqual({ actor: 'user', me: userId, org: null, rid: requestId });
    // A new transaction on the same pool starts without the previous context.
    const anon = await api.run({ actorType: 'anonymous' }, async ({ db }) => (await ctxValues.execute(db)).rows[0]);
    expect(anon).toMatchObject({ actor: 'anonymous', me: null });
  });

  it('switches the organization inside a transaction', async () => {
    const orgId = uuidv7();
    const row = await api.run({ actorType: 'user', userId: uuidv7() }, async (scope) => {
      await scope.setOrganization(orgId, 'fleet_owner');
      return (await ctxValues.execute(scope.db)).rows[0];
    });
    expect(row?.org).toBe(orgId);
  });

  it('refuses the system and staff contexts for carpal_api, and malformed ids', async () => {
    await expect(api.run({ actorType: 'system' }, async () => 1)).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(api.run({ actorType: 'staff', userId: uuidv7() }, async () => 1)).rejects.toBeInstanceOf(ApiError);
    await expect(api.run({ actorType: 'user', userId: 'not-an-id' }, async () => 1)).rejects.toThrow(/userId must be an Id/);
    await expect(api.run({ actorType: 'user' }, async () => 1)).rejects.toThrow(/userId is required/);
    expect(await worker.run({ actorType: 'system' }, async ({ db }) => (await ctxValues.execute(db)).rows[0]?.actor)).toBe('system');
  });

  it('reports an RLS write violation as NOT_FOUND (no oracle) and maps registered constraints', async () => {
    // background_jobs owner policy: a user cannot insert a job owned by someone else.
    const insertForeign = api.run({ actorType: 'user', userId: uuidv7() }, ({ db }) =>
      db.insertInto('core.background_jobs').values({ kind: 'data_export', owner_user_id: uuidv7(), owning_module: 'identity' }).execute(),
    );
    await expect(insertForeign).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    registerConstraintErrors({ background_jobs_pkey: { code: 'DUPLICATE', pointer: '/id' } });
    const userId = uuidv7();
    const id = uuidv7();
    const insertTwice = api.run({ actorType: 'user', userId }, async ({ db }) => {
      const row = { id, kind: 'data_export', owner_user_id: userId, owning_module: 'identity' };
      await db.insertInto('core.background_jobs').values(row).execute();
      await db.insertInto('core.background_jobs').values(row).execute();
    });
    await expect(insertTwice).rejects.toMatchObject({ code: 'DUPLICATE', errors: [{ pointer: '/id', code: 'not_unique' }] });
  });

  it('maps link-token SQLSTATEs and transition messages', async () => {
    const raise = (state: string, msg: string) =>
      api.run({ actorType: 'anonymous' }, ({ db }) =>
        sql`DO $$ BEGIN RAISE EXCEPTION '${sql.raw(msg)}' USING ERRCODE = '${sql.raw(state)}'; END $$`.execute(db),
      );
    await expect(raise('P0410', 'LINK_EXPIRED')).rejects.toMatchObject({ code: 'LINK_EXPIRED', status: 410 });
    await expect(raise('P0411', 'LINK_USED')).rejects.toMatchObject({ code: 'LINK_USED' });
    await expect(raise('P0403', 'LINK_RECIPIENT_MISMATCH')).rejects.toMatchObject({ code: 'LINK_RECIPIENT_MISMATCH' });
    await expect(raise('23514', 'INVALID_TRANSITION: appointment a -> b')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      status: 409,
    });
    await expect(raise('57014', 'canceling statement due to statement timeout')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryAfterMs: 1000,
    });
  });

  it('retries serialization failures and runs after-commit hooks only once, after success', async () => {
    let attempts = 0;
    const hooks: number[] = [];
    const result = await api.run({ actorType: 'anonymous' }, async (scope) => {
      attempts++;
      scope.afterCommit(() => void hooks.push(attempts));
      if (attempts < 3) await sql`DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`.execute(scope.db);
      return 'done';
    });
    expect(result).toBe('done');
    expect(attempts).toBe(3);
    expect(hooks).toEqual([3]);

    const rolledBack: string[] = [];
    await expect(
      api.run({ actorType: 'anonymous' }, async (scope) => {
        scope.afterCommit(() => void rolledBack.push('x'));
        throw new ApiError('INVALID_TRANSITION');
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(rolledBack).toEqual([]);
  });
});
