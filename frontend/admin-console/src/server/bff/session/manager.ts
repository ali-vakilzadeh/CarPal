// Session lifecycle over the store port (AC3.T2), adapted from pwa/src/server/bff/session/manager.ts (GD-03): cookie →
// record, idle (30 min) and absolute (8 h) expiry, rotation at sign-in (fixation), and serialized read-modify-write per
// session id, so two parallel requests of one browser never overwrite each other's token rotation (a stale refresh
// token written back would trip reuse detection). Admin changes: the cookie is always a browser-session cookie (no
// "Keep me signed in" for staff), and only API calls count as activity (reading /bff/session does not).
import { SESSION_COOKIE, type BffConfig } from '../config';
import { randomToken } from '../crypto';
import { hostCookie, parseCookies } from '../http';
import type { SessionStore } from './store';
import type { SessionRecord } from './types';

const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** lastSeenAt is written back at most this often by read-only requests (the idle deadline is exact to a minute). */
export const TOUCH_INTERVAL_MS = 60_000;

export class SessionManager {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: SessionStore,
    private readonly config: Pick<BffConfig, 'sessionIdleMs' | 'sessionAbsoluteMs'>,
    private readonly now: () => number = Date.now,
  ) {}

  idFrom(request: Request): string | undefined {
    const id = parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE);
    return id && ID_PATTERN.test(id) ? id : undefined;
  }

  async load(request: Request): Promise<SessionRecord | null> {
    const id = this.idFrom(request);
    return id ? this.get(id) : null;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const r = await this.store.get(id);
    if (!r) return null;
    const now = this.now();
    if (r.absoluteExpiresAt <= now || this.idleDeadline(r) <= now) {
      await this.store.delete(id);
      return null;
    }
    return r;
  }

  /** When the session ends without further activity: the idle limit, capped by the absolute one. */
  idleDeadline(r: SessionRecord): number {
    return Math.min(r.lastSeenAt + this.config.sessionIdleMs, r.absoluteExpiresAt);
  }

  create(locale?: string): SessionRecord {
    const now = this.now();
    return {
      id: randomToken(32),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.config.sessionAbsoluteMs,
      csrf: randomToken(32),
      ...(locale ? { locale } : {}),
      logins: [],
      intents: [],
    };
  }

  async save(r: SessionRecord): Promise<void> {
    r.lastSeenAt = this.now();
    await this.store.set(r, Math.max(1, Math.min(this.config.sessionIdleMs, r.absoluteExpiresAt - r.lastSeenAt)));
  }

  /**
   * Stores a changed record without counting it as activity (token refresh, profile update): the store keeps it for
   * what is left of the idle period.
   */
  async put(r: SessionRecord): Promise<void> {
    await this.store.set(r, Math.max(1, this.idleDeadline(r) - this.now()));
  }

  /** Loads, mutates and saves one session under a per-id lock; null when the session is gone. */
  async update(id: string, fn: (r: SessionRecord) => void | Promise<void>, o: { activity?: boolean } = {}): Promise<SessionRecord | null> {
    return this.#exclusive(id, async () => {
      const r = await this.get(id);
      if (!r) return null;
      await fn(r);
      if (o.activity === false) await this.put(r);
      else await this.save(r);
      return r;
    });
  }

  /** Writes lastSeenAt back when it is older than a minute (keeps the idle timeout sliding without a write per call). */
  async touch(r: SessionRecord): Promise<void> {
    if (this.now() - r.lastSeenAt < TOUCH_INTERVAL_MS) return;
    await this.update(r.id, () => {});
  }

  /**
   * A new id for the same browser (sign-in): the old record is deleted, the new one gets a new CSRF secret and an
   * absolute lifetime counted from now.
   */
  async rotate(old: SessionRecord | null, fill: (r: SessionRecord) => void): Promise<SessionRecord> {
    const next = this.create(old?.locale);
    fill(next);
    if (old) await this.#exclusive(old.id, () => this.store.delete(old.id));
    await this.save(next);
    return next;
  }

  async destroy(id: string): Promise<void> {
    await this.#exclusive(id, () => this.store.delete(id));
  }

  /** Always a browser-session cookie: closing the browser ends the staff session in it (the server ends it anyway). */
  cookie(r: SessionRecord): string {
    return hostCookie(SESSION_COOKIE, r.id, { sameSite: 'Strict' });
  }

  clearCookie(): string {
    return hostCookie(SESSION_COOKIE, '', { sameSite: 'Strict', maxAgeS: 0 });
  }

  async #exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    }
  }
}
