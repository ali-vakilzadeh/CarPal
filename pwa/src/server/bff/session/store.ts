// Session store port (GD-08): lite = in-memory with TTL (one process, dev), redis = shared (written, unverified).
import type { SessionRecord } from './types';

export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>;
  /** Stores the record for `ttlMs` (idle timeout, capped by the record's absolute expiry by the caller). */
  set(record: SessionRecord, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
  close?(): Promise<void>;
}

/** In-memory store with per-entry TTL; expired entries are dropped on read and by a periodic sweep. */
export class LiteSessionStore implements SessionStore {
  readonly #entries = new Map<string, { json: string; expiresAt: number }>();
  readonly #now: () => number;
  #sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(o: { now?: () => number; sweepMs?: number } = {}) {
    this.#now = o.now ?? Date.now;
    if (o.sweepMs !== 0) {
      this.#sweeper = setInterval(() => this.sweep(), o.sweepMs ?? 60_000);
      this.#sweeper.unref?.();
    }
  }

  async get(id: string): Promise<SessionRecord | null> {
    const e = this.#entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return null;
    }
    // Stored as JSON so callers never share mutable objects (same semantics as the Redis adapter).
    return JSON.parse(e.json) as SessionRecord;
  }

  async set(record: SessionRecord, ttlMs: number): Promise<void> {
    this.#entries.set(record.id, { json: JSON.stringify(record), expiresAt: this.#now() + ttlMs });
  }

  async delete(id: string): Promise<void> {
    this.#entries.delete(id);
  }

  sweep(): void {
    const now = this.#now();
    for (const [id, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  async close(): Promise<void> {
    clearInterval(this.#sweeper);
    this.#entries.clear();
  }
}
