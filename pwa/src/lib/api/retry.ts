// SEC-RL-4 client obligations, implemented once (GD-09): never retry before the server's delay and add 0-20 %
// jitter; without a delay, exponential backoff with full jitter (base 500 ms, cap 30 s, at most 5 attempts); only
// safe methods and IDEM requests retry automatically; after 3 consecutive 503s an operation pauses for the last given
// delay. Delays above 30 s are never slept on — the caller shows them (GD-09 amendment 3).

export const RETRY = { baseMs: 500, capMs: 30_000, maxAttempts: 5, maxSleepMs: 30_000, pauseAfter503s: 3 } as const;

/** Statuses worth retrying (transient): rate limited, gateway trouble, overload. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export function isRetryable(o: { method: string; idem: boolean; status: number | 'network'; code?: string }): boolean {
  if (o.method !== 'GET' && !o.idem) return false;
  if (o.status === 'network') return true;
  // AI_UNAVAILABLE is a state (GD-13), not a hiccup; retrying it only delays the fallback.
  if (o.code === 'AI_UNAVAILABLE') return false;
  return RETRY_STATUS.has(o.status);
}

/**
 * Delay before attempt `attempt + 1` (attempt counts from 0). With a server delay: delay × (1 + U[0, 0.2]);
 * without: U[0, min(cap, base × 2^attempt)].
 */
export function retryDelay(attempt: number, serverDelayMs: number | null, random: () => number = Math.random): number {
  if (serverDelayMs !== null) return Math.ceil(serverDelayMs * (1 + 0.2 * random()));
  return Math.floor(random() * Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt));
}

/** Per-operation pause after repeated 503s, and poll pacing from CarPal-Poll-After-Ms (SEC-RL-3). */
export class OperationGate {
  readonly #consecutive503 = new Map<string, number>();
  readonly #pausedUntil = new Map<string, { until: number; code: string }>();
  readonly #pollAfter = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The pause in force for an operation, if any. */
  paused(opId: string): { remainingMs: number; code: string } | null {
    const p = this.#pausedUntil.get(opId);
    if (!p) return null;
    const remainingMs = p.until - this.now();
    if (remainingMs <= 0) {
      this.#pausedUntil.delete(opId);
      return null;
    }
    return { remainingMs, code: p.code };
  }

  record(opId: string, status: number, code: string | undefined, serverDelayMs: number | null): void {
    if (status !== 503) {
      this.#consecutive503.delete(opId);
      return;
    }
    const n = (this.#consecutive503.get(opId) ?? 0) + 1;
    this.#consecutive503.set(opId, n);
    if (n >= RETRY.pauseAfter503s) {
      this.#pausedUntil.set(opId, { until: this.now() + (serverDelayMs ?? RETRY.capMs), code: code ?? 'OVERLOADED' });
      this.#consecutive503.delete(opId);
    }
  }

  /** Milliseconds to wait before this poll key may be called again (0 = now). */
  pollWait(key: string): number {
    const until = this.#pollAfter.get(key);
    if (until === undefined) return 0;
    const wait = until - this.now();
    if (wait <= 0) this.#pollAfter.delete(key);
    return Math.max(0, wait);
  }

  recordPoll(key: string, pollAfterMs: number | null, random: () => number = Math.random): void {
    if (pollAfterMs !== null) this.#pollAfter.set(key, this.now() + Math.ceil(pollAfterMs * (1 + 0.2 * random())));
  }
}
