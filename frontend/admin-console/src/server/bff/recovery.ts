// Staff account recovery through the /id proxy (AC10b.T3, SEC-ADM-2, backend S16b). The auth host answers
// auth.staff_recovery_start with an opaque request handle that the later calls name (verify, status, key options).
// The handle never reaches the browser: the proxy keeps it here, server-side, under a random id that the browser holds
// in an HttpOnly cookie (__Host-cpa_rcv, 24 h like the request), and puts it back into the request body on its way to
// the auth host. The staff member may come back hours later, after two administrators approved, with a new sign-in
// interaction: the cookie survives it, so the sign-in page can continue the recovery. The handle is dropped when the
// request is completed, rejected, expired or unknown to the auth host. auth.staff_recovery_complete takes no handle;
// its answer (the new recovery codes) passes through untouched and is never read or logged here (GD-12).
import { OPERATIONS } from '@carpal/api-contracts';
import type { RespClient } from './session/redis';

/** The browser's reference to the stored handle (never the handle itself). */
export const RECOVERY_COOKIE = '__Host-cpa_rcv';
/** A request expires 24 hours after it was opened (Docs/40 auth.staff_recovery_start). */
export const RECOVERY_TTL_MS = 24 * 3_600_000;

export interface RecoveryStore {
  get(id: string): Promise<string | null>;
  set(id: string, handle: string, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
  close?(): Promise<void>;
}

/** One process (dev, lite): a map with expiry, swept on read. */
export class LiteRecoveryStore implements RecoveryStore {
  readonly #entries = new Map<string, { handle: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.#now = o.now ?? Date.now;
  }

  async get(id: string): Promise<string | null> {
    const e = this.#entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return null;
    }
    return e.handle;
  }

  async set(id: string, handle: string, ttlMs: number): Promise<void> {
    const now = this.#now();
    for (const [k, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(k);
    this.#entries.set(id, { handle, expiresAt: now + ttlMs });
  }

  async delete(id: string): Promise<void> {
    this.#entries.delete(id);
  }

  get size(): number {
    return this.#entries.size;
  }
}

const REDIS_PREFIX = 'cp:admin:rcv:';

/** Shared store (written, not verified against a real Redis, like RedisSessionStore): its own key prefix. */
export class RedisRecoveryStore implements RecoveryStore {
  constructor(private readonly client: RespClient) {}

  async get(id: string): Promise<string | null> {
    const r = await this.client.command('GET', REDIS_PREFIX + id);
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : null;
  }

  async set(id: string, handle: string, ttlMs: number): Promise<void> {
    const r = await this.client.command('SET', REDIS_PREFIX + id, handle, 'PX', String(Math.max(1, Math.floor(ttlMs))));
    if (r instanceof Error) throw r;
  }

  async delete(id: string): Promise<void> {
    const r = await this.client.command('DEL', REDIS_PREFIX + id);
    if (r instanceof Error) throw r;
  }
}

function authRoute(opId: keyof typeof OPERATIONS): string {
  const route = OPERATIONS[opId].routes.find((r) => r.host === 'auth');
  if (!route) throw new Error(`${opId} has no auth-host route`);
  return route.path;
}

/** The recovery routes of the auth host, by what the proxy does with them. */
export const RECOVERY_PATHS = {
  start: authRoute('auth.staff_recovery_start'),
  verify: authRoute('auth.staff_recovery_verify'),
  status: authRoute('auth.staff_recovery_status'),
  options: authRoute('auth.staff_recovery_complete_options'),
  complete: authRoute('auth.staff_recovery_complete'),
} as const;

export type RecoveryRoute = keyof typeof RECOVERY_PATHS;

export function recoveryRoute(path: string): RecoveryRoute | null {
  for (const [k, v] of Object.entries(RECOVERY_PATHS)) if (v === path) return k as RecoveryRoute;
  return null;
}

/** Routes whose body names the handle: the proxy fills it in from the store. */
export const NEEDS_HANDLE: ReadonlySet<RecoveryRoute> = new Set(['verify', 'status', 'options']);

/** States after which the request cannot be continued: the stored handle is dropped. */
export const ENDED_STATES: ReadonlySet<string> = new Set(['rejected', 'expired', 'completed']);

const HANDLE = /^[A-Za-z0-9_-]{43}$/;
export const RECOVERY_ID = /^[A-Za-z0-9_-]{43}$/;

/** The request handle from an auth.staff_recovery_start answer; null when the answer does not carry a valid one. */
export function handleFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const h = (body as Record<string, unknown>).request_handle;
  return typeof h === 'string' && HANDLE.test(h) ? h : null;
}

/** The browser's JSON body with the stored handle put in (anything the browser sent under that name is replaced). */
export function withHandle(body: Uint8Array, handle: string): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.byteLength ? body : new TextEncoder().encode('{}')));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return new TextEncoder().encode(JSON.stringify({ ...(parsed as Record<string, unknown>), request_handle: handle }));
}
