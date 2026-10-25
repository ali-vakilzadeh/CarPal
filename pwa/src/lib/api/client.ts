// Typed API client over the generated operation map (GD-09, P2.T6). Calls are made by operation id; the client picks
// the route, fills the path, adds Idempotency-Key (UUIDv7, kept across automatic retries) for IDEM operations and
// If-Match from the ETag cache for ETAG operations, applies the SEC-RL-4 retry rules, paces polls, maps failures to
// ApiProblem, and solves a proof of work when an ATT operation is refused without one (DI-22). The transport decides
// where requests go: the BFF in the browser (browser.ts), the API host on the server (src/server/ssr).
import {
  OPERATIONS,
  type OperationId,
  type OperationInput,
  type OperationPath,
  type OperationQuery,
  type OperationResponse,
  type OperationRoute,
} from '@carpal/api-contracts';
import { ApiProblem, problemFrom } from './problem';
import { isRetryable, OperationGate, RETRY, retryDelay } from './retry';
import { uuidv7 } from './uuid';

export interface TransportRequest {
  opId: OperationId;
  method: string;
  host: OperationRoute['host'];
  /** Contract path with parameters filled in, e.g. /v1/me/vehicles/0193… */
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

export type CallArgs<Id extends OperationId> = MaybeRequired<'path', OperationPath<Id>> &
  (undefined extends OperationInput<Id> ? { body?: OperationInput<Id> } : { body: OperationInput<Id> }) & {
    query?: Partial<OperationQuery<Id>>;
    /** Overrides the cached ETag (e.g. '"v3"'). */
    ifMatch?: string;
    /** Reuse a key across a user-initiated retry of the same write. */
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export type CallRest<Id extends OperationId> = AllOptional<CallArgs<Id>> extends true ? [args?: CallArgs<Id>] : [args: CallArgs<Id>];

export interface CallResult<T> {
  data: T;
  status: number;
  etag: string | null;
  pollAfterMs: number | null;
  replayed: boolean;
  requestId: string | null;
}

export type PowPurpose = 'anonymous' | 'signup' | 'signin' | 'review' | 'invitation';

/** The PoW purpose of each ATT operation a web client calls (auth.token is the BFF's). */
export const POW_PURPOSE: Partial<Record<OperationId, PowPurpose>> = {
  'auth.signup': 'signup',
  'auth.signin_password': 'signin',
  'auth.otp_start': 'signin',
  'auth.password_reset_start': 'signin',
  'reviews.create': 'review',
  'review_invitations.open': 'invitation',
};

export interface ApiClientOptions {
  transport: Transport;
  /** Returns the CarPal-PoW header value for a purpose (browser: challenge + Web Worker). */
  solvePow?: (purpose: PowPurpose) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called for 401 SESSION_ENDED (the BFF signed the user out), e.g. to refresh the session view. */
  onSessionEnded?: () => void;
}

export interface ApiClient {
  api<Id extends OperationId>(opId: Id, ...rest: CallRest<Id>): Promise<OperationResponse<Id>>;
  call<Id extends OperationId>(opId: Id, ...rest: CallRest<Id>): Promise<CallResult<OperationResponse<Id>>>;
  readonly etags: EtagCache;
  readonly gate: OperationGate;
}

/** Last ETag per resource path (GD-09 amendment 2: always from the ETag header, never from a body version). */
export class EtagCache {
  readonly #map = new Map<string, string>();
  get(path: string): string | undefined {
    return this.#map.get(path);
  }
  set(path: string, etag: string): void {
    this.#map.set(path, etag);
  }
  /** Forget a resource's ETag, e.g. after a reaction bumped a post's version (GD-09 amendment 5). */
  delete(path: string): void {
    this.#map.delete(path);
  }
}

/** Picks the route: one with {org_id} when the caller passes org_id (fleet driver views), else the first without. */
export function selectRoute(opId: OperationId, path: Record<string, unknown> | undefined): OperationRoute {
  const routes = OPERATIONS[opId].routes as readonly OperationRoute[];
  const wantsOrg = path !== undefined && 'org_id' in path;
  const route = routes.find((r) => r.pathParams.includes('org_id') === wantsOrg) ?? routes[0];
  if (!route) throw new Error(`${opId}: no route`);
  return route;
}

export function fillPath(route: OperationRoute, params: Record<string, unknown> | undefined): string {
  return route.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '') throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
}

/** Enumerated query values only (TR-7 keeps free text and coordinates in bodies); arrays repeat the key. */
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

  async function call<Id extends OperationId>(opId: Id, ...rest: CallRest<Id>): Promise<CallResult<OperationResponse<Id>>> {
    const args = (rest[0] ?? {}) as CallArgs<Id> & { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    const op = OPERATIONS[opId];
    const route = selectRoute(opId, args.path);
    const path = fillPath(route, args.path);
    const search = buildSearch(args.query);

    const paused = gate.paused(opId);
    if (paused) throw new ApiProblem(503, { code: 'PAUSED', title: paused.code }, { retryAfterMs: paused.remainingMs });

    const headers = new Headers({ accept: 'application/json' });
    let body: string | undefined;
    if (op.inputEncoding === 'json' && args.body !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(args.body);
    }
    if (op.idem) headers.set('idempotency-key', args.idempotencyKey ?? uuidv7());
    if (op.etag) {
      const ifMatch = args.ifMatch ?? etags.get(path) ?? (opId === 'onboarding.update' ? '"v1"' : undefined);
      if (ifMatch) headers.set('if-match', ifMatch);
    }

    const pollKey = `${opId} ${path}${search}`;
    const wait = gate.pollWait(pollKey);
    if (wait > 0) await sleep(Math.min(wait, RETRY.maxSleepMs), args.signal);

    let powTried = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await o.transport({
          opId,
          method: op.method,
          host: route.host,
          path,
          search,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (err) {
        if (args.signal?.aborted) throw err;
        if (attempt + 1 < RETRY.maxAttempts && isRetryable({ method: op.method, idem: op.idem, status: 'network' })) {
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
          data: (text ? JSON.parse(text) : null) as OperationResponse<Id>,
          status: res.status,
          etag,
          pollAfterMs: pollAfter,
          replayed: res.headers.get('idempotent-replayed') === 'true',
          requestId: res.headers.get('carpal-request-id'),
        };
      }

      const problem = await problemFrom(res);
      gate.record(opId, res.status, problem.code, problem.retryAfterMs);
      if (problem.code === 'SESSION_ENDED') o.onSessionEnded?.();
      if (problem.code === 'ATTESTATION_REQUIRED' && !powTried && o.solvePow && POW_PURPOSE[opId]) {
        powTried = true;
        headers.set('carpal-pow', await o.solvePow(POW_PURPOSE[opId]!));
        attempt--;
        continue;
      }
      const retry =
        attempt + 1 < RETRY.maxAttempts && isRetryable({ method: op.method, idem: op.idem, status: res.status, code: problem.code });
      if (!retry || gate.paused(opId)) throw problem;
      const delay = retryDelay(attempt, problem.retryAfterMs, random);
      // A wait longer than 30 s goes to the screen (e.g. 3600 s appointment caps), never into a sleep.
      if (delay > RETRY.maxSleepMs) throw problem;
      await sleep(delay, args.signal);
    }
  }

  return {
    call,
    async api(opId, ...rest) {
      return (await call(opId, ...rest)).data;
    },
    etags,
    gate,
  };
}

function numberHeader(res: Response, name: string): number | null {
  const v = Number(res.headers.get(name) ?? NaN);
  return Number.isFinite(v) ? v : null;
}
