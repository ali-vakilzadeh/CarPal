// Typed admin API client (AC3.T5) over the generated admin operation map, adapted from pwa/src/lib/api/client.ts.
// Calls are made by operation id: api(opId, {path, query, body, purpose, reason}). The client fills the path, sends the
// purpose of a PURP read as CarPal-Access-Purpose (GD-10; refused here without one), the reason of a DELETE as the
// CarPal-Reason header and of any other RSN write in the body (GD-11, DI-09), adds Idempotency-Key (UUIDv7, kept
// across automatic retries) for IDEM operations and If-Match from the ETag cache for ETAG operations, applies the
// SEC-RL-4 retry rules, paces polls, and maps failures to ApiProblem. act() tells an applied change from one waiting
// for a second staff member (202 PendingChange) and from an accepted background job (202 Job), whatever the map
// says (AC1 notes: conditional 4EYES).
import type { Job, PendingChange } from '@carpal/api-contracts';
import {
  ADMIN_OPERATIONS,
  type AdminInput,
  type AdminOperationId,
  type AdminOperationMeta,
  type AdminPath,
  type AdminQuery,
  type AdminResponse,
} from '@/lib/api/generated';
import { ApiProblem, problemFrom } from './problem';
import { isRetryable, OperationGate, RETRY, retryDelay } from './retry';
import { uuidv7 } from './uuid';

/** SEC-ADM-5: the work item a purpose-bound read is for (GD-10), e.g. `case:0193…`. */
export type PurposeKind = 'case' | 'dispute' | 'dsr' | 'verification' | 'approval';
export type AccessPurpose = `${PurposeKind}:${string}`;
const PURPOSE = /^(case|dispute|dsr|verification|approval):[0-9a-f-]{36}$/;

export function purposeOf(kind: PurposeKind, id: string): AccessPurpose {
  return `${kind}:${id}`;
}

export interface TransportRequest {
  opId: AdminOperationId;
  method: string;
  /** Contract path with parameters filled in, e.g. /v1/admin/users/0193… */
  path: string;
  /** '' or '?a=1&b=2' */
  search: string;
  headers: Headers;
  body?: string;
  signal?: AbortSignal;
}

export type Transport = (req: TransportRequest) => Promise<Response>;

/** True when every member of T is optional (so the argument may be left out); Record<string, never> counts as empty. */
type AllOptional<T> = string extends keyof T ? true : Partial<T> extends T ? true : false;
type MaybeRequired<Key extends string, T> = AllOptional<T> extends true ? { [K in Key]?: T } : { [K in Key]: T };

export type CallArgs<Id extends AdminOperationId> = MaybeRequired<'path', AdminPath<Id>> &
  (undefined extends AdminInput<Id> ? { body?: AdminInput<Id> } : { body: AdminInput<Id> }) & {
    query?: Partial<AdminQuery<Id>>;
    /** The work item of a PURP read (GD-10). */
    purpose?: AccessPurpose;
    /** RSN: sent as CarPal-Reason on DELETE, else as body.reason when the body has none (GD-11). */
    reason?: string;
    /** Overrides the cached ETag (e.g. '"v3"'). */
    ifMatch?: string;
    /** Reuse a key across a user-initiated retry of the same write. */
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export type CallRest<Id extends AdminOperationId> = AllOptional<CallArgs<Id>> extends true ? [args?: CallArgs<Id>] : [args: CallArgs<Id>];

export interface CallResult<T> {
  data: T;
  status: number;
  etag: string | null;
  pollAfterMs: number | null;
  replayed: boolean;
  requestId: string | null;
}

/** The outcome of a write (GD-11): applied now, waiting for a second staff member, or running as a background job. */
export type Outcome<T> =
  | { kind: 'applied'; data: T; requestId: string | null }
  | { kind: 'pending'; change: PendingChange; requestId: string | null }
  | { kind: 'accepted'; job: Job; pollAfterMs: number | null; requestId: string | null };

export interface ApiClientOptions {
  transport: Transport;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called for 401 SESSION_ENDED / UNAUTHENTICATED (the BFF has no staff session any more). */
  onSessionEnded?: () => void;
}

export interface ApiClient {
  api<Id extends AdminOperationId>(opId: Id, ...rest: CallRest<Id>): Promise<AdminResponse<Id>>;
  call<Id extends AdminOperationId>(opId: Id, ...rest: CallRest<Id>): Promise<CallResult<AdminResponse<Id>>>;
  act<Id extends AdminOperationId>(opId: Id, ...rest: CallRest<Id>): Promise<Outcome<AdminResponse<Id>>>;
  readonly etags: EtagCache;
  readonly gate: OperationGate;
}

/** Last ETag per resource path (always from the ETag header, never from a body version). */
export class EtagCache {
  readonly #map = new Map<string, string>();
  get(path: string): string | undefined {
    return this.#map.get(path);
  }
  set(path: string, etag: string): void {
    this.#map.set(path, etag);
  }
  delete(path: string): void {
    this.#map.delete(path);
  }
  clear(): void {
    this.#map.clear();
  }
}

export function fillPath(op: Pick<AdminOperationMeta, 'path'>, params: Record<string, unknown> | undefined): string {
  return op.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
}

/** Enumerated query values only (TR-7 keeps free text in bodies); arrays repeat the key. */
export function buildSearch(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) p.append(k, String(item));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** CarPal-Reason: printable ASCII stays as typed; anything else is percent-encoded (the backend decodes it, DI-09). */
export function reasonHeader(reason: string): string {
  const oneLine = reason.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(oneLine) && !oneLine.includes('%') ? oneLine : encodeURIComponent(oneLine);
}

const isPendingChange = (v: unknown): v is PendingChange =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as PendingChange).change_id === 'string' &&
  typeof (v as PendingChange).op_id === 'string';
const isJob = (v: unknown): v is Job =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Job).id === 'string' &&
  typeof (v as Job).kind === 'string' &&
  typeof (v as Job).status === 'string';

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

export function createApiClient(o: ApiClientOptions): ApiClient {
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
  const gate = new OperationGate(o.now);
  const etags = new EtagCache();

  async function call<Id extends AdminOperationId>(opId: Id, ...rest: CallRest<Id>): Promise<CallResult<AdminResponse<Id>>> {
    const args = (rest[0] ?? {}) as CallArgs<Id> & { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    const op: AdminOperationMeta = ADMIN_OPERATIONS[opId];
    const path = fillPath(op, args.path);
    const search = buildSearch(args.query);

    const paused = gate.paused(opId);
    if (paused) throw new ApiProblem(503, { code: 'PAUSED', title: paused.code }, { retryAfterMs: paused.remainingMs });

    const headers = new Headers({ accept: 'application/json' });
    if (op.purpose) {
      if (!args.purpose || !PURPOSE.test(args.purpose)) throw new ApiProblem(400, { code: 'PURPOSE_REQUIRED', title: opId });
      headers.set('carpal-access-purpose', args.purpose);
    }
    let bodyValue = args.body;
    if (op.reason && args.reason !== undefined) {
      if (op.method === 'DELETE') headers.set('carpal-reason', reasonHeader(args.reason));
      else if (op.inputEncoding === 'json') {
        const b = (bodyValue ?? {}) as Record<string, unknown>;
        if (b.reason === undefined) bodyValue = { ...b, reason: args.reason };
      }
    }
    let body: string | undefined;
    if (op.inputEncoding === 'json' && bodyValue !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(bodyValue);
    }
    if (op.idempotent) headers.set('idempotency-key', args.idempotencyKey ?? uuidv7());
    if (op.etag) {
      const ifMatch = args.ifMatch ?? etags.get(path);
      if (ifMatch) headers.set('if-match', ifMatch);
    }

    const pollKey = `${opId} ${path}${search}`;
    const wait = gate.pollWait(pollKey);
    if (wait > 0) await sleep(Math.min(wait, RETRY.maxSleepMs), args.signal);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await o.transport({
          opId,
          method: op.method,
          path,
          search,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (err) {
        if (args.signal?.aborted) throw err;
        if (attempt + 1 < RETRY.maxAttempts && isRetryable({ method: op.method, idem: op.idempotent, status: 'network' })) {
          await sleep(retryDelay(attempt, null, random), args.signal);
          continue;
        }
        throw new ApiProblem(0, { code: 'NETWORK', title: String(err) });
      }

      const etag = res.headers.get('etag');
      if (res.ok) {
        gate.record(opId, res.status, undefined, null);
        if (etag) etags.set(path, etag);
        else if (op.method === 'DELETE') etags.delete(path);
        const pollAfter = numberHeader(res, 'carpal-poll-after-ms');
        gate.recordPoll(pollKey, pollAfter, random);
        const text = res.status === 204 ? '' : await res.text();
        return {
          data: (text ? JSON.parse(text) : null) as AdminResponse<Id>,
          status: res.status,
          etag,
          pollAfterMs: pollAfter,
          replayed: res.headers.get('idempotent-replayed') === 'true',
          requestId: res.headers.get('carpal-request-id'),
        };
      }

      const problem = await problemFrom(res);
      gate.record(opId, res.status, problem.code, problem.retryAfterMs);
      if (res.status === 401 && problem.signedOut) o.onSessionEnded?.();
      const retry =
        attempt + 1 < RETRY.maxAttempts && isRetryable({ method: op.method, idem: op.idempotent, status: res.status, code: problem.code });
      if (!retry || gate.paused(opId)) throw problem;
      const delay = retryDelay(attempt, problem.retryAfterMs, random);
      // A wait longer than 30 s goes to the screen, never into a sleep.
      if (delay > RETRY.maxSleepMs) throw problem;
      await sleep(delay, args.signal);
    }
  }

  return {
    call,
    async api(opId, ...rest) {
      return (await call(opId, ...rest)).data;
    },
    async act(opId, ...rest) {
      const r = await call(opId, ...rest);
      if (r.status === 202 && isPendingChange(r.data)) return { kind: 'pending', change: r.data, requestId: r.requestId };
      if (r.status === 202 && isJob(r.data)) return { kind: 'accepted', job: r.data, pollAfterMs: r.pollAfterMs, requestId: r.requestId };
      return { kind: 'applied', data: r.data, requestId: r.requestId };
    },
    etags,
    gate,
  };
}

function numberHeader(res: Response, name: string): number | null {
  const v = Number(res.headers.get(name) ?? NaN);
  return Number.isFinite(v) ? v : null;
}

/**
 * ASYNC helper (AC3.T5): re-reads until `done` says so, waiting what the server asked (CarPal-Poll-After-Ms, paced by
 * the client's gate) or `fallbackMs`, at most `maxPolls` times. Contract 1.3.0 has no admin-plane job read
 * (jobs.get is on the api host, which refuses admin tokens; DI-14, BR-20), so screens poll the record the job changes
 * (e.g. admin.dsr_queue for a DSR export).
 */
export async function pollUntil<T>(
  read: () => Promise<{ data: T; pollAfterMs: number | null }>,
  done: (data: T) => boolean,
  o: { fallbackMs?: number; maxPolls?: number; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  const max = o.maxPolls ?? 60;
  for (let i = 0; ; i++) {
    const r = await read();
    if (done(r.data)) return r.data;
    if (i + 1 >= max) throw new ApiProblem(0, { code: 'POLL_TIMEOUT', title: 'still running' });
    await sleep(Math.min(r.pollAfterMs ?? o.fallbackMs ?? 2_000, RETRY.maxSleepMs), o.signal);
  }
}
