// Smoke tests for the installed baseline (Docs/43.db_setup.sql) — S1.T5.
// They connect as the real login roles, never as superuser, except for catalog counts.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDbConfig, type LoginRole } from './config.js';
import { connect, connectAsRole, status } from './install.js';

const cfg = loadDbConfig();
const MODULE_SCHEMAS = [
  'core',
  'identity',
  'organization',
  'billing',
  'taxonomy',
  'vehicle',
  'inventory',
  'discovery',
  'trust',
  'appointment',
  'fleet',
  'community',
  'media',
  'notification',
  'admin',
  'analytics',
  'ai_mcp',
];
const SYSTEM_USER = '00000000-0000-7000-8000-000000000001';

let su: pg.Client;
const roles = new Map<LoginRole, pg.Client>();

async function as(role: LoginRole): Promise<pg.Client> {
  let c = roles.get(role);
  if (!c) {
    c = await connectAsRole(cfg, role);
    roles.set(role, c);
  }
  return c;
}

/** Runs fn in a transaction that is always rolled back (context settings are transaction-local). */
async function inTx<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

const count = async (c: pg.Client, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]!.n);

beforeAll(async () => {
  su = await connect(cfg, { database: cfg.dbName });
});

afterAll(async () => {
  await su.end();
  for (const c of roles.values()) await c.end();
});

describe('installation', () => {
  it('records the baseline hash and matches Docs/43', async () => {
    const s = await status(cfg);
    expect(s.databases).toEqual({ [cfg.dbName]: true, [cfg.analyticsDbName]: true });
    expect(s.baseline?.upToDate).toBe(true);
  });

  it('has 17 schemas and 103 tables (42 §2; S9 vehicle_transfers)', async () => {
    expect(await count(su, 'SELECT count(*) AS n FROM pg_namespace WHERE nspname = ANY($1)', [MODULE_SCHEMAS])).toBe(17);
    const tables = await count(
      su,
      `SELECT count(*) AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = ANY($1) AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
      [MODULE_SCHEMAS],
    );
    expect(tables).toBe(103);
  });

  it('enables row-level security on every module table', async () => {
    const r = await su.query<{ t: string }>(
      `SELECT s.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = ANY($1) AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity`,
      [MODULE_SCHEMAS],
    );
    expect(r.rows.map((x) => x.t)).toEqual(['core.schema_info']);
  });

  it('seeds the primary records (42 §8)', async () => {
    const expected: Record<string, number> = {
      'taxonomy.taxonomy_nodes': 694,
      'taxonomy.taxonomy_synonyms': 301,
      'taxonomy.taxonomy_mappings': 741,
      'billing.plans': 9,
      'billing.entitlements': 108,
      'admin.feature_flags': 22,
      'admin.data_retention_policies': 17,
      'ai_mcp.mcp_clients': 8,
      // Integration tests add fixture accounts (@test.carpal.app, libs/testing) to the shared database;
      // DSR deletion tests anonymize some of them (deleted-<id>@deleted.carpal.invalid).
      "identity.user_accounts WHERE email NOT LIKE '%@test.carpal.app' AND email NOT LIKE '%@deleted.carpal.invalid'": 2,
    };
    for (const [table, n] of Object.entries(expected)) {
      expect(await count(su, `SELECT count(*) AS n FROM ${table}`), table).toBe(n);
    }
  });

  it('creates the analytics database with its event tables', async () => {
    const c = await connectAsRole(cfg, 'carpal_analytics_writer', cfg.analyticsDbName);
    try {
      const r = await c.query("SELECT to_regclass('events.analytics_events') AS a, to_regclass('events.daily_metrics') AS b");
      expect(r.rows[0]).toEqual({ a: 'events.analytics_events', b: 'events.daily_metrics' });
    } finally {
      await c.end();
    }
  });
});

describe('request context (42 §5.1)', () => {
  it('refuses the system and staff contexts to carpal_api', async () => {
    const api = await as('carpal_api');
    for (const actor of ['system', 'staff']) {
      await expect(inTx(api, () => api.query('SELECT core.set_context($1, $2::uuid)', [actor, SYSTEM_USER]))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('allows the staff context only to carpal_admin_api and system to the worker', async () => {
    const adminApi = await as('carpal_admin_api');
    await inTx(adminApi, () => adminApi.query("SELECT core.set_context('staff', $1::uuid)", [SYSTEM_USER]));
    const worker = await as('carpal_worker');
    await inTx(worker, async () => {
      await worker.query("SELECT core.set_context('system')");
      expect((await worker.query('SELECT core.is_system() AS s')).rows[0]).toEqual({ s: true });
    });
    await expect(inTx(worker, () => worker.query("SELECT core.set_context('staff', $1::uuid)", [SYSTEM_USER]))).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('settings are transaction-local', async () => {
    const api = await as('carpal_api');
    await inTx(api, () => api.query("SELECT core.set_context('user', $1::uuid)", [SYSTEM_USER]));
    expect((await api.query('SELECT core.me() AS me, core.actor_type() AS t')).rows[0]).toEqual({ me: null, t: 'anonymous' });
  });
});

describe('row-level security (42 §5.2, §11)', () => {
  it('anonymous callers see public reference data but no accounts', async () => {
    const api = await as('carpal_api');
    await inTx(api, async () => {
      await api.query("SELECT core.set_context('anonymous')");
      expect(await count(api, 'SELECT count(*) AS n FROM billing.plans')).toBeGreaterThan(0);
      expect(await count(api, 'SELECT count(*) AS n FROM taxonomy.taxonomy_nodes')).toBe(694);
      expect(await count(api, 'SELECT count(*) AS n FROM identity.user_accounts')).toBe(0);
    });
  });

  it('the system context of the worker sees every account', async () => {
    const worker = await as('carpal_worker');
    await inTx(worker, async () => {
      await worker.query("SELECT core.set_context('system')");
      const all = await count(su, 'SELECT count(*) AS n FROM identity.user_accounts');
      expect(await count(worker, 'SELECT count(*) AS n FROM identity.user_accounts')).toBe(all);
      expect(all).toBeGreaterThanOrEqual(2);
    });
  });

  it('a user sees their own account only', async () => {
    const api = await as('carpal_api');
    const other = '01900000-0000-7000-8000-0000000000aa';
    await inTx(api, async () => {
      await api.query("SELECT core.set_context('user', $1::uuid)", [other]);
      expect(await count(api, 'SELECT count(*) AS n FROM identity.user_accounts')).toBe(0);
    });
  });

  it('the audit log is append-only for every application role', async () => {
    const worker = await as('carpal_worker');
    await expect(inTx(worker, () => worker.query('DELETE FROM analytics.audit_logs'))).rejects.toMatchObject({ code: '42501' });
  });

  it('application roles cannot create objects in public', async () => {
    const api = await as('carpal_api');
    await expect(inTx(api, () => api.query('CREATE TABLE public.x (id int)'))).rejects.toMatchObject({ code: '42501' });
  });
});
