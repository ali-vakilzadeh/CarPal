// Database access (GD-02): Kysely over pg, one pool per login role, types
// generated from the installed schema (pnpm db:codegen). Table keys carry the
// module schema: db.selectFrom('vehicle.vehicles'). Queries run only inside
// TxRunner transactions (libs/tenancy), which set the RLS context first.
export type { DB } from './generated/db.js';
export type { DB as AnalyticsDB } from './generated/analytics-db.js';
export { Database, type PoolOptions } from './database.js';
export {
  mapDbError,
  isPgError,
  registerConstraintErrors,
  RETRYABLE_SQLSTATES,
  type ConstraintMapping,
  type PgErrorLike,
} from './errors.js';
