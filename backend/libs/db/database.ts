// One connection pool per database login role (41 §3.3): the api deployable
// connects as carpal_api, admin-api as carpal_admin_api, the auth server as
// carpal_auth and workers as carpal_worker. Pools are never handed to
// business code; queries run only through TxRunner (libs/tenancy), which sets
// the RLS context first.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AnalyticsDbRole, AppDbRole, CarpalConfig } from '#libs/config/index.js';
import type { DB as AnalyticsDB } from './generated/analytics-db.js';
import type { DB } from './generated/db.js';

// Match the generated types (pnpm db:codegen): numeric, int8 and date stay
// strings; timestamptz becomes Date (pg default).
const TYPES = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === 1082 /* date */ || oid === 1700 /* numeric */ || oid === 20 /* int8 */) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as typeof pg.types.getTypeParser,
};

export interface PoolOptions {
  max?: number;
  /** Shows in pg_stat_activity (e.g. carpal-api). */
  applicationName?: string;
}

export class Database {
  readonly role: AppDbRole;
  readonly pool: pg.Pool;
  readonly #kysely: Kysely<DB>;

  constructor(config: CarpalConfig, role: AppDbRole, options: PoolOptions = {}) {
    this.role = role;
    this.pool = new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.name,
      user: role,
      password: config.db.passwords[role],
      max: options.max ?? config.db.poolMax,
      application_name: options.applicationName ?? role,
      types: TYPES,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  /** For TxRunner only: the Kysely instance whose transactions set the RLS context. */
  get kyselyForTenancy(): Kysely<DB> {
    return this.#kysely;
  }

  async close(): Promise<void> {
    await this.#kysely.destroy();
  }
}

/**
 * The analytics database (43 §23, Plan §2): pseudonymous product events and
 * daily aggregates, no personal data and no row-level security. The W12
 * pipeline writes as carpal_analytics_writer (insert events, upsert
 * aggregates); aggregation and dashboards read as carpal_analytics_reader.
 * Lazy: processes that never touch analytics open no connection.
 */
export class AnalyticsDatabase {
  readonly #config: CarpalConfig;
  readonly #role: AnalyticsDbRole;
  readonly #max: number;
  #pool?: pg.Pool;
  #kysely?: Kysely<AnalyticsDB>;

  constructor(config: CarpalConfig, role: AnalyticsDbRole, options: PoolOptions = {}) {
    this.#config = config;
    this.#role = role;
    this.#max = options.max ?? 4;
  }

  get db(): Kysely<AnalyticsDB> {
    if (!this.#kysely) {
      this.#pool = new pg.Pool({
        host: this.#config.db.host,
        port: this.#config.db.port,
        database: this.#config.db.analyticsName,
        user: this.#role,
        password: this.#config.db.passwords[this.#role],
        max: this.#max,
        application_name: this.#role,
        types: TYPES,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      this.#kysely = new Kysely<AnalyticsDB>({ dialect: new PostgresDialect({ pool: this.#pool }) });
    }
    return this.#kysely;
  }

  async close(): Promise<void> {
    await this.#kysely?.destroy();
    this.#kysely = undefined;
  }
}
