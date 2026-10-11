// L5 tenancy (41 §2.2, 42 §5.1, 40 SEC-AZ-3): every query runs in a
// transaction that first calls core.set_context(actor_type, user_id, org_id,
// role, request_id, anon_key). RLS is the second wall behind the API's owner
// predicates. There is no other way to reach the database: business code gets
// a TxScope, never a pool.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ApiError } from '#libs/contract/index.js';
import { ID_PATTERN } from '#libs/crypto/index.js';
import { mapDbError, RETRYABLE_SQLSTATES, isPgError, type Database, type DB } from '#libs/db/index.js';

export type ActorType = 'anonymous' | 'user' | 'staff' | 'system';

/** The RLS context of one transaction (42 §5.1). */
export interface TenancyContext {
  actorType: ActorType;
  /** Authenticated user (staff user on the admin plane). Required for user and staff. */
  userId?: string | null;
  /** Organization of the request path, already authorized by the API (SEC-AZ-2). */
  orgId?: string | null;
  /** Caller's role there (audit only). */
  role?: string | null;
  requestId?: string | null;
  /** Hash of an anonymous token's device key. */
  anonKey?: string | null;
}

export type Tx = Transaction<DB>;

export interface TxScope {
  readonly db: Tx;
  readonly context: Readonly<TenancyContext>;
  /** Runs after a successful COMMIT (enqueue jobs, invalidate caches). Not run on rollback. */
  afterCommit(fn: () => void | Promise<void>): void;
  /**
   * Switches the organization of the RLS context inside this transaction, for
   * operations whose organization is resolved from the target record after an
   * authorization check (ORG(by target), USR | ORG(ANY) on jobs and media).
   */
  setOrganization(orgId: string | null, role?: string | null): Promise<void>;
  /** Markers set by platform helpers (audit written, events published); read by the pipeline. */
  readonly marks: Set<string>;
}

export interface TxOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
  /** Attempts on serialization failure or deadlock (default 3). */
  maxAttempts?: number;
}

export interface TxLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

function checkContext(ctx: TenancyContext): void {
  if ((ctx.actorType === 'user' || ctx.actorType === 'staff') && !ctx.userId)
    throw new Error(`userId is required for actor ${ctx.actorType}`);
  for (const [k, v] of [
    ['userId', ctx.userId],
    ['orgId', ctx.orgId],
  ] as const) {
    if (v != null && !ID_PATTERN.test(v)) throw new Error(`${k} must be an Id`);
  }
}

const setContextSql = (ctx: TenancyContext) =>
  sql`SELECT core.set_context(${ctx.actorType}, ${ctx.userId ?? null}::uuid, ${ctx.orgId ?? null}::uuid, ${ctx.role ?? null}, ${ctx.requestId ?? null}, ${ctx.anonKey ?? null})`;

export class TxRunner {
  readonly #db: Kysely<DB>;

  constructor(
    readonly database: Database,
    private readonly log?: TxLogger,
  ) {
    this.#db = database.kyselyForTenancy;
  }

  /**
   * Runs `fn` in one transaction with the RLS context set. Database errors are
   * mapped to contract errors (ApiError); serialization failures and deadlocks
   * are retried with the whole function.
   */
  async run<T>(context: TenancyContext, fn: (scope: TxScope) => Promise<T>, options: TxOptions = {}): Promise<T> {
    checkContext(context);
    const maxAttempts = options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const hooks: (() => void | Promise<void>)[] = [];
      const marks = new Set<string>();
      try {
        let builder = this.#db.transaction();
        if (options.isolation) builder = builder.setIsolationLevel(options.isolation);
        if (options.readOnly) builder = builder.setAccessMode('read only');
        const result = await builder.execute(async (trx) => {
          const current: TenancyContext = { ...context };
          await setContextSql(current).execute(trx);
          const scope: TxScope = {
            db: trx,
            context: current,
            marks,
            afterCommit: (h) => void hooks.push(h),
            setOrganization: async (orgId, role) => {
              checkContext({ ...current, orgId });
              current.orgId = orgId;
              current.role = role ?? null;
              await setContextSql(current).execute(trx);
            },
          };
          return fn(scope);
        });
        for (const h of hooks) {
          try {
            await h();
          } catch (err) {
            this.log?.error({ err }, 'after-commit hook failed');
          }
        }
        return result;
      } catch (err) {
        if (isPgError(err) && RETRYABLE_SQLSTATES.has(err.code!) && attempt < maxAttempts) {
          this.log?.warn({ attempt, sqlstate: err.code }, 'transaction retried');
          await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
          continue;
        }
        throw mapDbError(err) satisfies ApiError;
      }
    }
  }
}
