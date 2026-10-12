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
  /** Device name shown in me.sessions_list (client and OS from CarPal-Client). */
  deviceLabel?: string;
  /** Last token issue or refresh (ISO). */
  lastSeenAt?: string;
  /** ISO 3166 country of the sign-in, when known. */
  country?: string | null;
  /**
   * The account had an active second factor when the session started. False
   * lets a fresh aal1 sign-in satisfy AAL2 step-up (no second factor exists to
   * step up with; see Authenticator.requireAssurance). Absent = enrolled.
   */
  mfaEnrolled?: boolean;
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
    await this.update(sid, { acr, authTime });
  }

  /** Changes fields of a live session, keeping its absolute expiry. Null when it is gone. */
  async update(sid: string, patch: Partial<Omit<Session, 'sid' | 'userId'>>): Promise<Session | null> {
    const s = await this.get(sid);
    if (!s) return null;
    const ttl = await this.kv.ttl(sessionKey(sid));
    const next: Session = { ...s, ...patch };
    await this.kv.set(sessionKey(sid), JSON.stringify(next), ttl ? { ttlMs: ttl, mode: 'XX' } : { mode: 'XX' });
    return next;
  }

  async revoke(sid: string): Promise<void> {
    const s = await this.get(sid);
    await this.kv.del(sessionKey(sid));
    if (s) await this.kv.sRem(userKey(s.userId), sid);
  }

  /** "Sign out everywhere", password change, suspension (SEC-AU-4); optionally keeps one session. */
  async revokeAll(userId: string, exceptSid?: string): Promise<number> {
    const sids = (await this.kv.sMembers(userKey(userId))).filter((sid) => sid !== exceptSid);
    for (const sid of sids) {
      await this.kv.del(sessionKey(sid));
      await this.kv.sRem(userKey(userId), sid);
    }
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
