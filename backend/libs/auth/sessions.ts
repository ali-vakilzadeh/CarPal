// Server-side sessions (40 SEC-AU-4, 52 §4: sessions live in Redis). Every
// request checks the token's `sid`; logout, password or MFA change,
// suspension and "sign out everywhere" delete sessions, which takes effect on
// the next request. Refresh-token families are added by the auth server (S3).
import type { KeyValueStore } from '#libs/infra/index.js';
import type { Acr } from './principal.js';

export interface Session {
  sid: string;
  userId: string;
  clientId: string;
  acr: Acr;
  /** Epoch seconds. */
  authTime: number;
  createdAt: string;
  /** Platform staff session on the admin plane (SEC-ADM-2). */
  staff: boolean;
}

const sessionKey = (sid: string): string => `auth:sess:${sid}`;
const userKey = (userId: string): string => `auth:user-sess:${userId}`;

export class SessionStore {
  constructor(private readonly kv: KeyValueStore) {}

  /** Stores a session for its absolute lifetime (40 §2.2 per client). */
  async create(session: Session, absoluteTtlMs: number): Promise<void> {
    await this.kv.set(sessionKey(session.sid), JSON.stringify(session), { ttlMs: absoluteTtlMs });
    await this.kv.sAdd(userKey(session.userId), session.sid, absoluteTtlMs);
  }

  async get(sid: string): Promise<Session | null> {
    const raw = await this.kv.get(sessionKey(sid));
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  /** Raises the session's assurance after step-up (SEC-AU-10). */
  async stepUp(sid: string, acr: Acr, authTime: number): Promise<void> {
    const s = await this.get(sid);
    if (!s) return;
    const ttl = await this.kv.ttl(sessionKey(sid));
    await this.kv.set(sessionKey(sid), JSON.stringify({ ...s, acr, authTime }), ttl ? { ttlMs: ttl } : {});
  }

  async revoke(sid: string): Promise<void> {
    const s = await this.get(sid);
    await this.kv.del(sessionKey(sid));
    if (s) await this.kv.sRem(userKey(s.userId), sid);
  }

  /** "Sign out everywhere", password change, suspension (SEC-AU-4). */
  async revokeAll(userId: string): Promise<number> {
    const sids = await this.kv.sMembers(userKey(userId));
    for (const sid of sids) await this.kv.del(sessionKey(sid));
    await this.kv.del(userKey(userId));
    return sids.length;
  }

  async list(userId: string): Promise<Session[]> {
    const out: Session[] = [];
    for (const sid of await this.kv.sMembers(userKey(userId))) {
      const s = await this.get(sid);
      if (s) out.push(s);
      else await this.kv.sRem(userKey(userId), sid);
    }
    return out;
  }
}
