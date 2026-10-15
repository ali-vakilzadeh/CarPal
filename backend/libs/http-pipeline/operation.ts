// Operation handlers (41 §4.2, conventions.naming): one class per operation,
// bound by op id with the @Operation decorator (op id from the contract). The pipeline has already
// routed, authenticated, rate-limited, authorized, checked flags, validated
// the input, and handled idempotency and If-Match when handle() runs.
import type { Principal } from '#libs/auth/index.js';
import type { AccessGrant } from '#libs/authz/index.js';
import type { Operation, OperationId, Route } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import type { Locale } from '#libs/i18n/index.js';
import type { Scope } from '#libs/rate-limit/index.js';
import type { TxOptions, TxScope } from '#libs/tenancy/index.js';
import type { ClientInfo } from './headers.js';

const OPERATION_IDS = Symbol.for('carpal.operation-ids');

type Ctor = abstract new (...args: never[]) => unknown;

/** Binds a handler class to one or more operation ids of the contract. */
export function Operation(...opIds: OperationId[]) {
  return <T extends Ctor>(target: T): T => {
    (target as unknown as Record<symbol, string[]>)[OPERATION_IDS] = opIds;
    return target;
  };
}

export const operationIdsOf = (cls: unknown): string[] | undefined =>
  typeof cls === 'function' ? (cls as unknown as Record<symbol, string[] | undefined>)[OPERATION_IDS] : undefined;

const OWN_FLAGS = Symbol.for('carpal.operation-own-flags');

/**
 * Safety-first degradation (40 triage.start, SEC-AI-7): the handler checks
 * the operation's FLAG tags itself, so it can still answer the server-side
 * safety block inside its 503 AI_UNAVAILABLE. Every other handler relies on
 * the pipeline's flag step.
 */
export function ChecksOwnFlags<T extends Ctor>(target: T): T {
  (target as unknown as Record<symbol, boolean>)[OWN_FLAGS] = true;
  return target;
}

export const checksOwnFlags = (handler: unknown): boolean =>
  typeof handler === 'object' &&
  handler !== null &&
  (handler.constructor as unknown as Record<symbol, boolean | undefined>)[OWN_FLAGS] === true;

const OVERRIDE = Symbol.for('carpal.operation-override');

/** Test harness only: a handler that replaces the module's real handler of the same operation. */
export function markOverride<T extends Ctor>(target: T): T {
  (target as unknown as Record<symbol, boolean>)[OVERRIDE] = true;
  return target;
}

export const isOverride = (cls: unknown): boolean =>
  typeof cls === 'function' && (cls as unknown as Record<symbol, boolean | undefined>)[OVERRIDE] === true;

export interface OperationContext<B = unknown, Q = Record<string, unknown>> {
  readonly op: Operation;
  readonly route: Route;
  readonly requestId: string;
  readonly principal: Principal;
  readonly access: AccessGrant;
  readonly params: Readonly<Record<string, string>>;
  /** Validated query, defaults applied (limit = 20 …). */
  readonly query: Q;
  /** Validated, normalized body (form fields for the OAuth form posts). */
  readonly body: B;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly locale: Locale;
  readonly timezone: string | undefined;
  readonly client: ClientInfo | undefined;
  readonly ipPrefix: string;
  /** Version from If-Match on ETAG operations (undefined for ETAG(if exists) without the header). */
  readonly ifMatch: number | undefined;
  /** Verified position of the `cursor` query parameter. */
  readonly cursor: unknown;
  /** Runs `fn` in one transaction with the caller's RLS context (L5). */
  tx<T>(fn: (scope: TxScope) => Promise<T>, options?: TxOptions): Promise<T>;
  /** ORG(by target) and USR | ORG(ANY): authorizes an organization resolved from the target record. */
  authorizeOrg(orgId: string, groups: string[]): Promise<{ id: string; type: OrgType; role: string; matchedGroups: string[] }>;
  /** Conditional AAL2/AAL3 (e.g. "AAL3(suspend_account, …)"). */
  requireAssurance(level: 'aal2' | 'aal3'): void;
  /** Feature flag for the caller (qualified FLAG tags such as "FLAG(x: email)"). */
  flagEnabled(key: string): Promise<boolean>;
  /** Request-dependent rate-limit windows (account, destination, author, subject, bytes). */
  rateLimit(bucket: string, scope: Scope, key: string, cost?: number): Promise<void>;
  /** Page<T> with a signed cursor bound to the caller and the query (40 §3.3); pass null as `next` on the last page. */
  page<T>(items: T[], next: unknown): { items: T[]; next_cursor: string | null };
  /**
   * A cursor for another operation of this host with no query filters (e.g.
   * search.run answering the first page of search.page): signed for the
   * caller and bound to that operation's route and path parameters.
   */
  cursorFor(opId: OperationId, params: Record<string, string>, position: unknown): string;
}

export type CachePolicy = 'no-store' | { public: number };

export interface OperationResult {
  /** Defaults to the operation's success status. */
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Only cacheable operations (40 §1.4) may return a public policy. */
  cache?: CachePolicy;
  /** Content-Language of localized content. */
  contentLanguage?: Locale;
}

export interface OperationHandler {
  // Method syntax: implementations may narrow the body and query types.
  handle(ctx: OperationContext): Promise<OperationResult> | OperationResult;
}

export const ok = (body: unknown, extra: Omit<OperationResult, 'body'> = {}): OperationResult => ({ ...extra, body });
export const created = (body: unknown, location: string): OperationResult => ({ status: 201, body, headers: { location } });
export const accepted = (body: unknown, location?: string): OperationResult => ({
  status: 202,
  body,
  ...(location ? { headers: { location } } : {}),
});
export const noContent = (): OperationResult => ({ status: 204 });
export const redirect = (url: string): OperationResult => ({ status: 302, headers: { location: url } });
