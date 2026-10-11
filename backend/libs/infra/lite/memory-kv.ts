// In-memory KeyValueStore for lite mode. Single process only: every app that
// shares sessions, idempotency or rate-limit state must run in the same
// process (pnpm dev does). Operations are synchronous internally, so each call
// is atomic with respect to the others (Node runs one at a time).
import type { KeyValueStore, SetOptions, WindowResult } from '../ports.js';

interface Entry {
  value: string | Set<string>;
  expiresAt: number | null;
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly #data = new Map<string, Entry>();
  readonly #sweeper: NodeJS.Timeout;

  constructor(private readonly clock: () => number = Date.now) {
    // Expired entries are removed lazily on access and by a periodic sweep.
    this.#sweeper = setInterval(() => this.#sweep(), 30_000);
    this.#sweeper.unref();
  }

  #live(key: string, now = this.clock()): Entry | undefined {
    const e = this.#data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= now) {
      this.#data.delete(key);
      return undefined;
    }
    return e;
  }

  #sweep(): void {
    const now = this.clock();
    for (const [k, e] of this.#data) if (e.expiresAt !== null && e.expiresAt <= now) this.#data.delete(k);
  }

  #string(key: string, now?: number): string | null {
    const e = this.#live(key, now);
    if (!e) return null;
    if (typeof e.value !== 'string') throw new Error(`WRONGTYPE ${key} holds a set`);
    return e.value;
  }

  async get(key: string): Promise<string | null> {
    return this.#string(key);
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const exists = this.#live(key) !== undefined;
    if (options.mode === 'NX' && exists) return false;
    if (options.mode === 'XX' && !exists) return false;
    this.#data.set(key, { value, expiresAt: options.ttlMs !== undefined ? this.clock() + options.ttlMs : null });
    return true;
  }

  async del(key: string): Promise<boolean> {
    const existed = this.#live(key) !== undefined;
    this.#data.delete(key);
    return existed;
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    if (this.#string(key) !== expected) return false;
    this.#data.delete(key);
    return true;
  }

  async incr(key: string, by = 1, ttlMs?: number): Promise<number> {
    const e = this.#live(key);
    if (!e) {
      this.#data.set(key, { value: String(by), expiresAt: ttlMs !== undefined ? this.clock() + ttlMs : null });
      return by;
    }
    if (typeof e.value !== 'string' || !/^-?\d+$/.test(e.value)) throw new Error(`ERR value of ${key} is not an integer`);
    const n = Number(e.value) + by;
    e.value = String(n);
    return n;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    const e = this.#live(key);
    if (!e) return false;
    e.expiresAt = this.clock() + ttlMs;
    return true;
  }

  async ttl(key: string): Promise<number | null> {
    const e = this.#live(key);
    return e?.expiresAt != null ? e.expiresAt - this.clock() : null;
  }

  async sAdd(key: string, member: string, ttlMs?: number): Promise<void> {
    const e = this.#live(key);
    if (e && !(e.value instanceof Set)) throw new Error(`WRONGTYPE ${key} holds a string`);
    if (e) (e.value as Set<string>).add(member);
    else this.#data.set(key, { value: new Set([member]), expiresAt: null });
    if (ttlMs !== undefined) this.#data.get(key)!.expiresAt = this.clock() + ttlMs;
  }

  async sRem(key: string, member: string): Promise<void> {
    const e = this.#live(key);
    if (e?.value instanceof Set) {
      e.value.delete(member);
      if (e.value.size === 0) this.#data.delete(key);
    }
  }

  async sMembers(key: string): Promise<string[]> {
    const e = this.#live(key);
    return e?.value instanceof Set ? [...e.value] : [];
  }

  async slidingWindow(key: string, windowMs: number, limit: number, cost = 1, now = this.clock()): Promise<WindowResult> {
    const slot = Math.floor(now / windowMs);
    const elapsed = now - slot * windowMs;
    const curKey = `${key}:${slot}`;
    const prevKey = `${key}:${slot - 1}`;
    const cur = Number(this.#string(curKey, now) ?? 0);
    const prev = Number(this.#string(prevKey, now) ?? 0);
    const weight = (windowMs - elapsed) / windowMs;
    const estimate = prev * weight + cur;
    const resetMs = windowMs - elapsed;
    if (estimate + cost <= limit) {
      this.#data.set(curKey, { value: String(cur + cost), expiresAt: now + 2 * windowMs });
      const count = estimate + cost;
      return { allowed: true, count, limit, remaining: Math.max(0, Math.floor(limit - count)), retryAfterMs: 0, resetMs };
    }
    // Earliest time (without further calls) at which the estimate leaves room for `cost`:
    // within this window the previous window's weight decays; after the reset the
    // current count becomes the decaying previous one.
    let retryAfterMs: number;
    if (cur + cost <= limit) retryAfterMs = resetMs - ((limit - cur - cost) * windowMs) / prev;
    else if (cost <= limit) retryAfterMs = resetMs + windowMs - ((limit - cost) * windowMs) / cur;
    else retryAfterMs = 2 * windowMs;
    return { allowed: false, count: estimate, limit, remaining: 0, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)), resetMs };
  }

  async delPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.#data.keys()]) {
      if (k.startsWith(prefix)) {
        this.#data.delete(k);
        n++;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    clearInterval(this.#sweeper);
    this.#data.clear();
  }
}
