// S25b (backend/BR-update-plan.json, refinement closure): R-15, pnpm dev:staff prune retires the staff accounts the
// console's tests leave in the dev database (e2e-…, bff-int-…@staff.carpals.test) without touching any other account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { bootstrapStaff, listStaff, parseSpec, pruneStaff } from '#tools/db/staff.js';
import { createTestApp, testConfig, testLogger, type TestApp } from './test-app.js';

let infra: Infra;
let admin: TestApp;
let crypto: CryptoServices;

type SysScope = Parameters<Parameters<TestApp['fixtures']['worker']['run']>[1]>[0];
const sys = <T>(fn: (scope: SysScope) => Promise<T>): Promise<T> => admin.fixtures.worker.run({ actorType: 'system' }, fn);

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  admin = await createTestApp({ host: 'admin-api', infra });
  crypto = new CryptoServices(config.secrets.master);
}, 60_000);

afterAll(async () => {
  await admin?.close();
  await infra?.close();
});

describe('S25b dev:staff prune (R-15)', () => {
  it('retires only <prefix>…@<domain> staff accounts: roles removed, keys disabled, requests expired, audited', async () => {
    // The fixture domain (excluded from the baseline's seed count); the run's tag in the prefixes keeps other runs out.
    const tag = uuidv7().slice(-12);
    const domain = 'test.carpal.app';
    const prefixes = [`e2e-${tag}-`, `bff-int-${tag}-`];
    const deps = { tx: admin.fixtures.worker, crypto, env: 'dev' as const };
    const specs = parseSpec(
      [
        { email: `e2e-${tag}-adm@${domain}`, name: 'E2E Admin', roles: ['ADM'] },
        { email: `bff-int-${tag}-adm@${domain}`, name: 'BFF Int Admin', roles: ['ADM', 'MOD'] },
        { email: `adm1-${tag}@${domain}`, name: 'Kept Admin', roles: ['ADM'] },
      ],
      'dev',
    );
    await bootstrapStaff(deps, specs);
    const [e2e, bff, kept] = await sys((s) =>
      Promise.all(
        specs.map((sp) =>
          s.db.selectFrom('identity.user_accounts').select(['id', 'email']).where('email', '=', sp.email).executeTakeFirstOrThrow(),
        ),
      ),
    );
    // A plain user with a matching address is not staff and stays.
    const plain = await admin.fixtures.user();
    await sys((s) =>
      s.db
        .updateTable('identity.user_accounts')
        .set({ email: `e2e-${tag}-user@${domain}` })
        .where('id', '=', plain.id)
        .execute(),
    );
    // A pending four-eyes request of a pruned account ends with it.
    const changeId = uuidv7();
    await sys((s) =>
      s.db
        .insertInto('admin.pending_admin_changes')
        .values({
          id: changeId,
          op_id: 'admin.flag_update',
          target_entity_type: 'feature_flag',
          target_entity_id: uuidv7(),
          request_payload: JSON.stringify({ enabled: true }),
          summary: 'test request',
          reason: 'prune test request',
          required_role: 'platform_admin',
          requested_by: e2e!.id,
        })
        .execute(),
    );

    await expect(pruneStaff({ ...deps, env: 'staging' }, domain, prefixes)).rejects.toThrow(/only runs with CARPAL_ENV=dev/);
    const pruned = await pruneStaff(deps, domain, prefixes);
    expect(pruned).toEqual([
      { email: bff!.email, roles: ['ADM', 'MOD'] },
      { email: e2e!.email, roles: ['ADM'] },
    ]);

    const listed = (await listStaff(deps)).map((s) => s.email);
    expect(listed).toContain(kept!.email);
    expect(listed).not.toContain(e2e!.email);
    expect(listed).not.toContain(bff!.email);

    const state = await sys(async (s) => ({
      accounts: await s.db
        .selectFrom('identity.user_accounts')
        .select(['id', 'status', 'deleted_at'])
        .where('id', 'in', [e2e!.id, bff!.id, kept!.id, plain.id])
        .execute(),
      roles: await s.db
        .selectFrom('identity.role_memberships')
        .select(['user_id', 'role', 'status', 'deleted_at'])
        .where('user_id', 'in', [e2e!.id, bff!.id])
        .execute(),
      methods: await s.db
        .selectFrom('identity.authentication_methods')
        .select(['user_id', 'status'])
        .where('user_id', 'in', [e2e!.id, bff!.id])
        .execute(),
      change: await s.db.selectFrom('admin.pending_admin_changes').select('status').where('id', '=', changeId).executeTakeFirstOrThrow(),
      audit: await s.db
        .selectFrom('analytics.audit_logs')
        .select(['entity_id', 'actor_type', 'previous_state_summary'])
        .where('action', '=', 'staff.dev_pruned')
        .where('entity_id', 'in', [e2e!.id, bff!.id])
        .execute(),
    }));
    const status = Object.fromEntries(state.accounts.map((a) => [a.id, a.status]));
    expect(status).toEqual({ [e2e!.id]: 'deleted', [bff!.id]: 'deleted', [kept!.id]: 'active', [plain.id]: 'active' });
    // Platform roles are removed; the account's own consumer membership (individual) goes with the deleted account.
    expect(
      state.roles
        .filter((r) => r.role.startsWith('platform_'))
        .map((r) => [r.role, r.status, r.deleted_at !== null])
        .sort(),
    ).toEqual([
      ['platform_admin', 'removed', true],
      ['platform_admin', 'removed', true],
      ['platform_moderator', 'removed', true],
    ]);
    expect(state.methods.length).toBeGreaterThan(0);
    expect(state.methods.every((m) => m.status === 'disabled')).toBe(true);
    expect(state.change.status).toBe('expired');
    expect(state.audit.map((a) => [a.actor_type, a.previous_state_summary]).sort()).toEqual([
      ['system', 'ADM'],
      ['system', 'ADM,MOD'],
    ]);

    // Running it again finds nothing (test addresses are unique per run, so they are never reused).
    expect(await pruneStaff(deps, domain, prefixes)).toEqual([]);
  });
});
