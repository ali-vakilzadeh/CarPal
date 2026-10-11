// One connection pool per database login role (41 §3.3): the api deployable
// connects as carpal_api, admin-api as carpal_admin_api, the auth server as
// carpal_auth and workers as carpal_worker. Pools are never handed to
// business code; queries run only through TxRunner (libs/tenancy), which sets
// the RLS context first.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AppDbRole, CarpalConfig } from '#libs/config/index.js';
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
