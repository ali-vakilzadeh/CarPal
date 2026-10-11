// Installs the CarPal databases (GD-09):
//   1. baseline   = Docs/43.db_setup.sql, run by the psql-compatible runner as the
//                   superuser (it creates cluster roles and both databases);
//   2. migrations = database/migrations/NNNN_*.sql in name order, run as
//                   carpal_migrator with SET ROLE carpal_owner (42 §10).
// The baseline's SHA-256 and every applied migration are recorded in
// core.schema_info, so `db:status` can tell when Docs/43 changed after install.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pg from 'pg';
import { dbSetupScript, LOGIN_ROLES, migrationsDir, repoDir, type DbConfig, type LoginRole } from './config.js';
import { runPsqlScript } from './psql/runner.js';

export type Log = (message: string) => void;

export interface ConnectAs {
  database: string;
  user?: string;
  password?: string;
}

export async function connect(cfg: DbConfig, as: ConnectAs): Promise<pg.Client> {
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: as.database,
    user: as.user ?? cfg.superuser,
    password: as.password ?? cfg.superuserPassword,
    application_name: 'carpal-db-tools',
  });
  await client.connect();
  return client;
}

export function connectAsRole(cfg: DbConfig, role: LoginRole, database = cfg.dbName): Promise<pg.Client> {
  return connect(cfg, { database, user: role, password: cfg.rolePasswords[role] });
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function databaseExists(cfg: DbConfig, name: string): Promise<boolean> {
  const c = await connect(cfg, { database: 'postgres' });
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return r.rowCount === 1;
  } finally {
    await c.end();
  }
}

// ----------------------------------------------------------------- lite shims
/**
 * Statement rewrites for runtimes without pgvector (the embedded cluster).
 * `ext.vector` becomes a real[] domain with `ext.vector_dims()`, and the HNSW
 * index is skipped. Only ai_mcp.embeddings uses vectors (S9, AI stubs), so the
 * schema stays identical everywhere else. Full mode (pgvector) needs no shim.
 */
export function liteShims(vectorAvailable: boolean): { rewrite: (sql: string) => string | null; applied: string[] } {
  const applied: string[] = [];
  const rewrite = (sql: string): string | null => {
    if (vectorAvailable) return sql;
    const head = withoutLeadingComments(sql);
    if (/^CREATE EXTENSION IF NOT EXISTS vector SCHEMA ext;?$/i.test(head)) {
      applied.push('vector-domain');
      return [
        'CREATE DOMAIN ext.vector AS real[];',
        "COMMENT ON DOMAIN ext.vector IS 'CarPal lite-mode shim for pgvector (not installed on this runtime)';",
        'CREATE FUNCTION ext.vector_dims(real[]) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE',
        "  AS 'SELECT array_length($1, 1)';",
      ].join('\n');
    }
    if (/^CREATE INDEX embeddings_hnsw_/i.test(head)) {
      applied.push('skip-hnsw-index');
      return null;
    }
    return sql;
  };
  return { rewrite, applied };
}

/** Statement text without the comment lines the script puts above it. */
function withoutLeadingComments(sql: string): string {
  return sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, '').trim();
}

// ------------------------------------------------------------------- baseline
export async function installBaseline(cfg: DbConfig, log: Log): Promise<void> {
  const admin = await connect(cfg, { database: 'postgres' });
  let vectorAvailable: boolean;
  try {
    const r = await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    vectorAvailable = r.rowCount === 1;
  } finally {
    await admin.end();
  }
  if (!vectorAvailable) log('pgvector is not available: applying the lite-mode vector shim (see tools/db/install.ts).');

  const variables: Record<string, string> = {
    env: cfg.env,
    admin_email: cfg.adminEmail,
    db_name: cfg.dbName,
    analytics_db_name: cfg.analyticsDbName,
    db_locale: cfg.locale,
  };
  for (const [role, variable] of Object.entries(LOGIN_ROLES)) variables[variable] = cfg.rolePasswords[role as LoginRole];

  const shims = liteShims(vectorAvailable);
  const script = readFileSync(dbSetupScript, 'utf8');
  const started = Date.now();
  const result = await runPsqlScript(script, {
    initialDatabase: 'postgres',
    connect: (database) => connect(cfg, { database }),
    variables,
    rewrite: shims.rewrite,
    log: (m) => log(`  ${m}`),
  });
  log(`Baseline applied: ${result.statements} statements, ${result.skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)} s.`);

  const c = await connect(cfg, { database: cfg.dbName });
  try {
    await c.query('INSERT INTO core.schema_info (component, version, note) VALUES ($1, $2, $3)', [
      'baseline.sha256',
      sha256File(dbSetupScript),
      relative(repoDir, dbSetupScript).replace(/\\/g, '/'),
    ]);
    if (shims.applied.length > 0) {
      await c.query('INSERT INTO core.schema_info (component, version, note) VALUES ($1, $2, $3)', [
        'runtime.lite_shims',
        shims.applied.join(','),
        'pgvector missing: ext.vector is a real[] domain, HNSW index skipped',
      ]);
    }
  } finally {
    await c.end();
  }
}

// ----------------------------------------------------------------- migrations
export function migrationFiles(): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

export async function appliedMigrations(cfg: DbConfig): Promise<Set<string>> {
  const c = await connect(cfg, { database: cfg.dbName });
  try {
    const r = await c.query<{ component: string }>("SELECT component FROM core.schema_info WHERE component LIKE 'migration:%'");
    return new Set(r.rows.map((row) => row.component.slice('migration:'.length)));
  } finally {
    await c.end();
  }
}

export async function applyMigrations(cfg: DbConfig, log: Log): Promise<string[]> {
  const done = await appliedMigrations(cfg);
  const pending = migrationFiles().filter((f) => !done.has(f));
  for (const file of pending) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await runPsqlScript(
      `SET ROLE carpal_owner;\n${sql}\nINSERT INTO core.schema_info (component, version, note) VALUES (:'component', :'sha', 'database/migrations');\n`,
      {
        initialDatabase: cfg.dbName,
        connect: (database) => connectAsRole(cfg, 'carpal_migrator', database),
        variables: {
          component: `migration:${file}`,
          sha: createHash('sha256').update(sql).digest('hex'),
          env: cfg.env,
        },
        log: (m) => log(`  ${m}`),
      },
    );
    log(`Migration applied: ${file}`);
  }
  return pending;
}

// --------------------------------------------------------------- setup / reset
export async function setup(cfg: DbConfig, log: Log): Promise<void> {
  if (await databaseExists(cfg, cfg.dbName)) {
    log(`Database ${cfg.dbName} exists: applying pending migrations only.`);
  } else {
    if (await databaseExists(cfg, cfg.analyticsDbName)) {
      throw new Error(`${cfg.analyticsDbName} exists without ${cfg.dbName} (partial install). Run pnpm db:reset.`);
    }
    log(`Installing baseline from ${relative(repoDir, dbSetupScript)} ...`);
    await installBaseline(cfg, log);
  }
  const applied = await applyMigrations(cfg, log);
  if (applied.length === 0) log('No pending migrations.');
}

export async function dropDatabases(cfg: DbConfig, log: Log): Promise<void> {
  const c = await connect(cfg, { database: 'postgres' });
  try {
    for (const name of [cfg.dbName, cfg.analyticsDbName]) {
      await c.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}" WITH (FORCE)`);
      log(`Dropped database ${name} (if it existed).`);
    }
  } finally {
    await c.end();
  }
}

export interface DbStatus {
  databases: Record<string, boolean>;
  baseline?: { installed: string; current: string; upToDate: boolean };
  liteShims?: string;
  migrations: { applied: string[]; pending: string[] };
}

export async function status(cfg: DbConfig): Promise<DbStatus> {
  const databases = {
    [cfg.dbName]: await databaseExists(cfg, cfg.dbName),
    [cfg.analyticsDbName]: await databaseExists(cfg, cfg.analyticsDbName),
  };
  const out: DbStatus = { databases, migrations: { applied: [], pending: migrationFiles() } };
  if (!databases[cfg.dbName]) return out;
  const c = await connect(cfg, { database: cfg.dbName });
  try {
    const r = await c.query<{ component: string; version: string }>('SELECT component, version FROM core.schema_info');
    const info = new Map(r.rows.map((row) => [row.component, row.version]));
    const installed = info.get('baseline.sha256') ?? 'unknown';
    const current = sha256File(dbSetupScript);
    out.baseline = { installed, current, upToDate: installed === current };
    out.liteShims = info.get('runtime.lite_shims');
    const applied = [...info.keys()].filter((k) => k.startsWith('migration:')).map((k) => k.slice(10));
    out.migrations = { applied, pending: migrationFiles().filter((f) => !applied.includes(f)) };
  } finally {
    await c.end();
  }
  return out;
}
