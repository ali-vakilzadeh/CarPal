// Short-lived auth server state in the key-value store (52 §4 "one-time codes
// and sessions live in Redis"): sign-in interactions, authorization codes,
// refresh-token families, one-time codes and proof-of-work challenges. Secrets
// are kept only as hashes (codes, refresh tokens: HMAC; authorization codes:
// SHA-256 of 256 random bits). Single use is atomic (compare-and-delete).
import { createHash, randomBytes } from 'node:crypto';
import type { Acr } from '#libs/auth/index.js';
import { uuidv7, type Hmac } from '#libs/crypto/index.js';
import type { KeyValueStore } from '#libs/infra/index.js';

const MIN = 60_000;
export const INTERACTION_TTL_MS = 30 * MIN;
export const AUTH_CODE_TTL_MS = MIN;
export const OTP_TTL_MS = 10 * MIN;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_MS = MIN;
export const POW_TTL_MS = 5 * MIN;

/** One pending one-time code (SEC-AU-8). `live` is false when nothing was sent (unknown destination): it can never match. */
export interface PendingOtp {
  channel: 'email' | 'sms';
  destination: string;
  purpose: 'signin' | 'verify';
  codeHash: string;
  attempts: number;
  expiresAt: number;
  sentAt: number;
  live: boolean;
}

/** A hosted sign-in interaction (40 §6.2: created by auth.authorize, cookie __Host-cp_ia). */
export interface Interaction {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  acrValues?: Acr;
  uiLocales?: string;
  createdAt: number;
  /** Authenticated account (after the first factor). */
  userId?: string;
  acr?: Acr;
  amr: string[];
  authTime?: number;
  /** A second factor is still needed (auth.mfa_verify). */
  mfaPending?: boolean;
  /** The account has an active second factor (Session.mfaEnrolled of the resulting session). */
  mfaEnrolled?: boolean;
  mfaFailures: number;
  completed?: boolean;
  otp?: PendingOtp;
}

export interface AuthCodeGrant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  acr: Acr;
  authTime: number;
  nonce: string;
  scope: string;
  mfaEnrolled: boolean;
}

export interface RefreshRecord {
  /** Session = token family: revoking the session revokes the family (SEC-AU-5). */
  sid: string;
  userId: string;
  clientId: string;
  scope: string;
  cnfJkt?: string;
  /** Epoch ms after which the family cannot be refreshed (session absolute lifetime). */
  absoluteExpiry: number;
}

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const opaque = (): string => randomBytes(32).toString('base64url');

export class AuthState {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly hmac: Hmac,
  ) {}

  // ---------------------------------------------------------- interactions

  async createInteraction(i: Omit<Interaction, 'id' | 'createdAt' | 'amr' | 'mfaFailures'>): Promise<Interaction> {
    const full: Interaction = { ...i, id: uuidv7(), createdAt: Date.now(), amr: [], mfaFailures: 0 };
    await this.kv.set(`auth:ia:${full.id}`, JSON.stringify(full), { ttlMs: INTERACTION_TTL_MS });
    return full;
  }

  async interaction(id: string): Promise<Interaction | null> {
    const raw = await this.kv.get(`auth:ia:${id}`);
    return raw ? (JSON.parse(raw) as Interaction) : null;
  }

  /** Saves changes, keeping the interaction's expiry. */
  async saveInteraction(i: Interaction): Promise<void> {
    const ttl = (await this.kv.ttl(`auth:ia:${i.id}`)) ?? INTERACTION_TTL_MS;
    await this.kv.set(`auth:ia:${i.id}`, JSON.stringify(i), { ttlMs: Math.max(1, ttl), mode: 'XX' });
  }

  async dropInteraction(id: string): Promise<void> {
    await this.kv.del(`auth:ia:${id}`);
  }

  // ---------------------------------------------------------- authorization codes

  async issueCode(grant: AuthCodeGrant): Promise<string> {
    const code = opaque();
    await this.kv.set(`auth:code:${sha256hex(code)}`, JSON.stringify(grant), { ttlMs: AUTH_CODE_TTL_MS });
    return code;
  }

  /**
   * Single use: the first caller deletes the entry. A replayed code returns
   * `{ replayed: sid }` (the session it created is then revoked, RFC 6749 §4.1.2).
   */
  async consumeCode(code: string): Promise<{ grant: AuthCodeGrant } | { replayed: string | null } | null> {
    const key = `auth:code:${sha256hex(code)}`;
    const raw = await this.kv.get(key);
    if (raw && (await this.kv.compareAndDelete(key, raw))) return { grant: JSON.parse(raw) as AuthCodeGrant };
    const used = await this.kv.get(`auth:code-used:${sha256hex(code)}`);
    return used !== null ? { replayed: used || null } : null;
  }

  async markCodeUsed(code: string, sid: string): Promise<void> {
    await this.kv.set(`auth:code-used:${sha256hex(code)}`, sid, { ttlMs: 10 * MIN });
  }

  // ---------------------------------------------------------- refresh tokens

  #rtKey(token: string): string {
    return this.hmac.digest('refresh-token', token).toString('hex');
  }

  /** Opaque 256-bit refresh token, stored as HMAC; idle (sliding) expiry capped by the absolute one. */
  async issueRefresh(r: RefreshRecord, idleMs: number): Promise<string> {
    const token = `cprt_${opaque()}`;
    const ttl = Math.min(idleMs, r.absoluteExpiry - Date.now());
    await this.kv.set(`auth:rt:${this.#rtKey(token)}`, JSON.stringify(r), { ttlMs: Math.max(1, ttl) });
    return token;
  }

  /**
   * Rotation (SEC-AU-5): the token is deleted on first use. A rotated token
   * presented again is reuse: `{ reused }` names the family (session) to revoke.
   */
  async useRefresh(token: string): Promise<{ record: RefreshRecord } | { reused: RefreshRecord } | null> {
    const h = this.#rtKey(token);
    const raw = await this.kv.get(`auth:rt:${h}`);
    if (raw && (await this.kv.compareAndDelete(`auth:rt:${h}`, raw))) {
      const record = JSON.parse(raw) as RefreshRecord;
      await this.kv.set(`auth:rt-used:${h}`, raw, { ttlMs: Math.max(1, record.absoluteExpiry - Date.now()) });
      return { record };
    }
    const used = await this.kv.get(`auth:rt-used:${h}`);
    return used ? { reused: JSON.parse(used) as RefreshRecord } : null;
  }

  /** auth.revoke: the record of a live refresh token, without consuming it. */
  async peekRefresh(token: string): Promise<RefreshRecord | null> {
    const raw = await this.kv.get(`auth:rt:${this.#rtKey(token)}`);
    return raw ? (JSON.parse(raw) as RefreshRecord) : null;
  }

  // ---------------------------------------------------------- one-time codes

  otpHash(code: string, binding: string): string {
    return this.hmac.digest('otp', `${binding}:${code}`).toString('hex');
  }

  async putPhoneChange(userId: string, otp: PendingOtp): Promise<void> {
    await this.kv.set(`auth:otp-phone:${userId}`, JSON.stringify(otp), { ttlMs: OTP_TTL_MS });
  }

  async phoneChange(userId: string): Promise<PendingOtp | null> {
    const raw = await this.kv.get(`auth:otp-phone:${userId}`);
    return raw ? (JSON.parse(raw) as PendingOtp) : null;
  }

  async savePhoneChange(userId: string, otp: PendingOtp | null): Promise<void> {
    if (!otp) await this.kv.del(`auth:otp-phone:${userId}`);
    else await this.kv.set(`auth:otp-phone:${userId}`, JSON.stringify(otp), { ttlMs: Math.max(1, otp.expiresAt - Date.now()), mode: 'XX' });
  }

  // ---------------------------------------------------------- proof of work

  async putPow(id: string, c: { prefix: string; bits: number; purpose: string }): Promise<void> {
    await this.kv.set(`auth:pow:${id}`, JSON.stringify(c), { ttlMs: POW_TTL_MS });
  }

  /** Single use: returns the challenge and deletes it. */
  async takePow(id: string): Promise<{ prefix: string; bits: number; purpose: string } | null> {
    const raw = await this.kv.get(`auth:pow:${id}`);
    if (!raw || !(await this.kv.compareAndDelete(`auth:pow:${id}`, raw))) return null;
    return JSON.parse(raw) as { prefix: string; bits: number; purpose: string };
  }

  // ---------------------------------------------------------- DPoP nonces

  async newDpopNonce(): Promise<string> {
    const nonce = opaque();
    await this.kv.set(`auth:dpop-nonce:${nonce}`, '1', { ttlMs: 5 * MIN });
    return nonce;
  }

  async dpopNonceValid(nonce: string | undefined): Promise<boolean> {
    return !!nonce && /^[A-Za-z0-9_-]{43}$/.test(nonce) && (await this.kv.get(`auth:dpop-nonce:${nonce}`)) !== null;
  }
}
