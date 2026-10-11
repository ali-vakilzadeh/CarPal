// L8 rate limits (41 §2.2, 40 §2.8 SEC-RL): sliding windows per bucket in the
// KV store, the default bucket of each route plus its RL(...) buckets, the
// server-directed retry delay (CarPal-Retry-After-Ms, Retry-After,
// retry_after_ms), escalation to a temporary block, and load shedding by
// priority (SEC-RL-2).
import { ApiError, type Route } from '#libs/contract/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';
import { loadBuckets, PIPELINE_SCOPES, type Scope, type Window } from './buckets.js';

export { DEFAULT_BUCKETS, loadBuckets, type Scope, type Window, type PipelineScope, type UseCaseScope } from './buckets.js';

/** Who is calling, as far as the pipeline knows. */
export interface RateSubject {
  kind: 'none' | 'anonymous' | 'user' | 'staff';
  /** user id, or anonymous device-key hash. */
  id?: string;
  ipPrefix: string;
  orgId?: string;
}

export interface Decision {
  /** Headers for every response (IETF RateLimit fields of the tightest window). */
  headers: Record<string, string>;
}

export interface RateLimiterOptions {
  kv: KeyValueStore;
  overridesJson?: string;
  scale?: number;
  /** Denials within 10 min before the key is blocked for 15 min (abuse escalation). */
  escalateAfter?: number;
  onEscalation?: (key: string) => void;
}

const BLOCK_MS = 15 * 60_000;

/** Default bucket of a route's tag (40 §2.8 "every operation also has the default bucket of its tag"). */
export function defaultBucket(route: Route, subject: RateSubject): string {
  if (route.host === 'admin-api') return 'admin.default';
  const publicRoute = route.security.principals.some((alt) => alt.some((t) => t.tag === 'PUB'));
  if (publicRoute && (subject.kind === 'anonymous' || subject.kind === 'none')) return 'public.read';
  return route.method === 'GET' ? 'default.read' : 'default.write';
}

export function routeBuckets(route: Route, subject: RateSubject): string[] {
  const explicit = route.security.tags.filter((t) => t.tag === 'RL').flatMap((t) => t.args);
  return [...new Set([defaultBucket(route, subject), ...explicit])];
}

function scopeKey(scope: Scope, s: RateSubject): string | null {
  const caller = s.id ? `${s.kind}:${s.id}` : `ip:${s.ipPrefix}`;
  switch (scope) {
    case 'principal':
    case 'device':
    case 'staff':
    case 'user': // anonymous callers fall back to their device key, token-less callers to their IP prefix
      return caller;
    case 'anon':
      return s.kind === 'anonymous' || s.kind === 'none' ? caller : null;
    case 'org':
      return s.orgId ? `org:${s.orgId}` : caller;
    case 'org_or_user':
      return s.orgId ? `org:${s.orgId}` : caller;
    case 'ip':
      return `ip:${s.ipPrefix}`;
    default:
      return null;
  }
}

export class RateLimiter {
  readonly buckets: Record<string, Window[]>;

  constructor(private readonly o: RateLimiterOptions) {
    this.buckets = loadBuckets(o.overridesJson, o.scale ?? 1);
  }

  /**
   * Pipeline check of the pipeline-scoped windows of every bucket of the route.
   * Phase "caller" runs before authorization; phase "org" runs after it, so a
   * caller who is not a member cannot use up an organization's quota.
   */
  async check(bucketNames: string[], subject: RateSubject, phase: 'caller' | 'org' = 'caller'): Promise<Decision> {
    const keys: { bucket: string; window: Window; key: string }[] = [];
    for (const name of bucketNames) {
      const windows = this.buckets[name];
      if (!windows) throw new Error(`unknown rate-limit bucket ${name}`);
      for (const w of windows) {
        if (!PIPELINE_SCOPES.has(w.scope)) continue;
        if ((w.scope === 'org' || w.scope === 'org_or_user') !== (phase === 'org')) continue;
        const k = scopeKey(w.scope, subject);
        if (k) keys.push({ bucket: name, window: w, key: k });
      }
    }
    return this.#consume(keys, 1);
  }

  /**
   * Use-case check for request-dependent scopes (account, destination,
   * author, subject, bytes), e.g. consume('auth.signin', 'account', email).
   * `limit` overrides the configured value (plan entitlements on ai.org).
   */
  async consume(bucket: string, scope: Scope, key: string, cost = 1, limit?: number): Promise<Decision> {
    const windows = (this.buckets[bucket] ?? []).filter((w) => w.scope === scope);
    if (windows.length === 0) throw new Error(`bucket ${bucket} has no ${scope} window`);
    return this.#consume(
      windows.map((w) => ({ bucket, window: limit ? { ...w, limit } : w, key: `${scope}:${key}` })),
      cost,
    );
  }

  async #consume(entries: { bucket: string; window: Window; key: string }[], cost: number): Promise<Decision> {
    for (const e of entries) {
      const blocked = await this.o.kv.ttl(`rl:block:${e.key}`);
      if (blocked !== null && blocked > 0) throw this.#limited(blocked, e.bucket, e.window, 0);
    }
    let tightest: { bucket: string; window: Window; remaining: number; resetMs: number } | null = null;
    for (const e of entries) {
      const r = await this.o.kv.slidingWindow(`rl:${e.bucket}:${e.window.windowMs}:${e.key}`, e.window.windowMs, e.window.limit, cost);
      if (!r.allowed) {
        await this.#escalate(e.key);
        throw this.#limited(r.retryAfterMs, e.bucket, e.window, r.resetMs);
      }
      if (!tightest || r.remaining / e.window.limit < tightest.remaining / tightest.window.limit) {
        tightest = { bucket: e.bucket, window: e.window, remaining: r.remaining, resetMs: r.resetMs };
      }
    }
    return { headers: tightest ? headersFor(tightest.bucket, tightest.window, tightest.remaining, tightest.resetMs) : {} };
  }

  async #escalate(key: string): Promise<void> {
    const threshold = this.o.escalateAfter ?? 50;
    const n = await this.o.kv.incr(`rl:abuse:${key}`, 1, 10 * 60_000);
    if (n === threshold) {
      await this.o.kv.set(`rl:block:${key}`, '1', { ttlMs: BLOCK_MS });
      this.o.onEscalation?.(key);
    }
  }

  #limited(retryAfterMs: number, bucket: string, w: Window, resetMs: number): ApiError {
    const delay = Math.min(3_600_000, Math.max(100, Math.ceil(retryAfterMs)));
    return new ApiError('RATE_LIMITED', { retryAfterMs: delay, detail: `bucket ${bucket}`, headers: headersFor(bucket, w, 0, resetMs) });
  }
}

function headersFor(bucket: string, w: Window, remaining: number, resetMs: number): Record<string, string> {
  return {
    'ratelimit-policy': `"${bucket}";q=${w.limit};w=${Math.ceil(w.windowMs / 1000)}`,
    ratelimit: `"${bucket}";r=${Math.max(0, Math.floor(remaining))};t=${Math.ceil(resetMs / 1000)}`,
  };
}

// ------------------------------------------------------------------ shedding

/** SEC-RL-2 priorities: lower numbers are shed first. */
export enum ShedPriority {
  AnalyticsAndAi = 0,
  SearchAndMap = 1,
  Read = 2,
  Write = 3,
  Critical = 4,
}

const CRITICAL = new Set(['auth.token', 'auth.signin_password', 'auth.otp_verify', 'auth.mfa_verify', 'auth.revoke', 'admin.flag_update']);
const SHED_AT = [0.5, 0.7, 0.85, 0.95, 1.0];

export function shedPriority(opId: string, method: string): ShedPriority {
  if (CRITICAL.has(opId) || (opId.startsWith('appointments.') && method !== 'GET')) return ShedPriority.Critical;
  if (opId === 'events.ingest' || opId.startsWith('ai.') || opId.startsWith('triage.')) return ShedPriority.AnalyticsAndAi;
  if (opId.startsWith('search.') || opId.startsWith('map.')) return ShedPriority.SearchAndMap;
  return method === 'GET' ? ShedPriority.Read : ShedPriority.Write;
}

/** In-process load shedding on requests in flight (the gateway sheds earlier in full deployments). */
export class LoadShedder {
  #inflight = 0;

  constructor(private readonly capacity: number) {}

  get inflight(): number {
    return this.#inflight;
  }

  /** Admits the request or throws 503 OVERLOADED with a retry delay. Call the returned function when done. */
  enter(priority: ShedPriority): () => void {
    const limit = Math.max(1, Math.floor(this.capacity * SHED_AT[priority]!));
    if (this.#inflight >= limit) {
      const load = this.#inflight / this.capacity;
      throw new ApiError('OVERLOADED', { retryAfterMs: Math.round(1_000 * (1 + load) * (1 + Math.random() * 0.2)) });
    }
    this.#inflight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#inflight--;
      }
    };
  }
}
