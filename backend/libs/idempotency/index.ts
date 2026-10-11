// L6 idempotency (40 SEC-IC-1/2): Idempotency-Key records in the KV store for
// 24 h per (principal, operation, key) with a SHA-256 hash of the request.
// Same key + same request → the original status and body are replayed with
// Idempotent-Replayed: true; same key + different request → 422
// IDEMPOTENCY_KEY_REUSED; same key still running → 409 IDEMPOTENCY_IN_PROGRESS.
import { createHash } from 'node:crypto';
import { ApiError } from '#libs/contract/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';

/** UUID v4 or v7 (40 §1.3). */
export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RECORD_TTL_MS = 24 * 3_600_000;
/** A crashed request releases its lock after this long. */
const LOCK_TTL_MS = 5 * 60_000;

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface Record_ {
  state: 'running' | 'done';
  hash: string;
  response?: StoredResponse;
}

export type Begin = { kind: 'new'; slot: string } | { kind: 'replay'; response: StoredResponse };

/**
 * The request hash covers method, path (with its parameters), query and body,
 * so one key can never replay a response of another resource.
 */
export function requestHash(method: string, path: string, query: string, body: Buffer): string {
  return createHash('sha256').update(`${method}\n${path}\n${query}\n`).update(body).digest('base64url');
}

export class IdempotencyStore {
  constructor(private readonly kv: KeyValueStore) {}

  /** Validates the header value (missing → 428, malformed → 400). */
  static parseKey(header: string | undefined): string {
    if (header === undefined || header === '') throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
    if (!IDEMPOTENCY_KEY_PATTERN.test(header))
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Idempotency-Key must be a UUID v4 or v7' });
    return header.toLowerCase();
  }

  #slot(principal: string, opId: string, key: string): string {
    return `idem:${createHash('sha256').update(`${principal}\n${opId}\n${key}`).digest('base64url')}`;
  }

  async begin(principal: string, opId: string, key: string, hash: string): Promise<Begin> {
    const slot = this.#slot(principal, opId, key);
    const running: Record_ = { state: 'running', hash };
    if (await this.kv.set(slot, JSON.stringify(running), { ttlMs: LOCK_TTL_MS, mode: 'NX' })) return { kind: 'new', slot };
    const raw = await this.kv.get(slot);
    if (raw === null) return this.begin(principal, opId, key, hash); // expired between the two calls
    const existing = JSON.parse(raw) as Record_;
    if (existing.hash !== hash) throw new ApiError('IDEMPOTENCY_KEY_REUSED');
    if (existing.state === 'running' || !existing.response) throw new ApiError('IDEMPOTENCY_IN_PROGRESS');
    return { kind: 'replay', response: existing.response };
  }

  /** Stores the final response (any status below 500) for 24 h. */
  async complete(slot: string, hash: string, response: StoredResponse): Promise<void> {
    const record: Record_ = { state: 'done', hash, response };
    await this.kv.set(slot, JSON.stringify(record), { ttlMs: RECORD_TTL_MS });
  }

  /** Releases the lock after a server error so the client can retry with the same key. */
  async abandon(slot: string): Promise<void> {
    await this.kv.del(slot);
  }
}
