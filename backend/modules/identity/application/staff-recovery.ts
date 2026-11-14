// Staff account recovery after a lost security key (backend S16b, contract 1.4.0; admin console BR-19, R-08; owner
// decisions DQ-04 and DQ-15). This file holds the request's life on the auth host (cp-web-admin interactions only) and
// what the admin plane shares with it; staff-recovery-admin.ts holds the administrators' queue and decisions.
//
//   auth.staff_recovery_start     email + password (or "forgotten") + one recovery code. Same answer and minimum time
//                                 whatever the account (SEC-AU-11): unknown, disabled, wrong details or an open
//                                 request already all get a handle that can never be verified. When everything is
//                                 right the recovery code is spent, the request is opened (awaiting_email_code) and a
//                                 code goes to the account email with "if this was not you, tell an administrator".
//   auth.staff_recovery_verify    the emailed code → awaiting_approvals; every other active administrator is told by
//                                 email (it links to the console; nothing can be approved from it).
//   admin.staff_recovery_approve  (staff-recovery-admin.ts) two different administrators → approved.
//   auth.staff_recovery_status    the requester's waiting page polls it by handle.
//   auth.staff_recovery_complete_options / auth.staff_recovery_complete
//                                 on a new cp-web-admin interaction (the first one has long expired): the new password
//                                 when forgotten, then a new device-bound key. One transaction disables the old keys
//                                 and recovery codes, issues a new set (shown once), restricts the account for 72
//                                 hours and completes the request; then every session ends and the key signs in at
//                                 once (auth.webauthn_options purpose mfa, auth.mfa_verify → aal3), as at enrolment.
//
// A request expires 24 hours after it was opened (expires_at moves there when the emailed code is checked; until then
// it is 10 minutes); the W15 rule below marks it expired, and every read treats an overdue request as expired already.
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { SessionStore } from '#libs/auth/index.js';
import { writeAudit } from '#libs/audit/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { registerConstraintErrors, type DB } from '#libs/db/index.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { constantTimeEqual, isBreachedPassword, newOtpCode } from '../domain/credentials.js';
import { findAccount, getUser, methods, normalizeEmail, platformRoles, type UserRow } from '../infrastructure/accounts.js';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from '../infrastructure/auth-state.js';
import { IdentityMessages } from '../infrastructure/messages.js';
import { StaffRestrictions } from '../interface/identity.js';
import { AuthServer, isDeviceBoundPasskey } from './auth-server.js';
import { withMinLatency } from './common.js';
import { activeAdmins, StaffRecoveryCodes } from './staff-security.js';
import { WebAuthnService } from './webauthn.js';

const HOUR_MS = 3_600_000;
/** DQ-04: a request lives 24 hours from the moment it was opened. */
export const RECOVERY_TTL_MS = 24 * HOUR_MS;
/** DQ-04: a recovered account is restricted for 72 hours. */
export const RECOVERY_RESTRICTION_MS = 72 * HOUR_MS;
/** DQ-04, DQ-15: two different administrators approve every recovery, whatever the requester's roles. */
export const RECOVERY_APPROVALS = 2;

export type RecoveryRow = Selectable<DB['identity.staff_recovery_requests']>;
export type RecoveryStatus = 'awaiting_email_code' | 'awaiting_approvals' | 'approved' | 'rejected' | 'expired' | 'completed';
const OPEN: readonly string[] = ['awaiting_email_code', 'awaiting_approvals', 'approved'];

registerConstraintErrors({
  // Reachable only by a race the row locks already prevent: a second approval by the same administrator.
  staff_recovery_approvals_once_uq: 'INVALID_TRANSITION',
  staff_recovery_requests_open_uq: 'INVALID_TRANSITION',
});

/** The request handle is 256 random bits, so a plain SHA-256 is enough to store it (as for authorization codes). */
export const handleHashOf = (handle: string): string => createHash('sha256').update(handle).digest('hex');

/** The status a reader sees: an open request past its deadline is expired, even before the W15 rule marks it. */
export function effectiveStatus(r: Pick<RecoveryRow, 'status' | 'expires_at'>, now = Date.now()): RecoveryStatus {
  const status = r.status as RecoveryStatus;
  return OPEN.includes(status) && r.expires_at.getTime() <= now ? 'expired' : status;
}

/** A staff account that may be recovered: active, with a verified email and an active platform role (never disabled staff). */
export async function recoverable(scope: TxScope, u: UserRow | undefined): Promise<boolean> {
  return !!u && u.status === 'active' && u.email_verified_at !== null && (await platformRoles(scope, u.id)).length > 0;
}

export async function approvalsOf(scope: TxScope, requestId: string): Promise<number> {
  const r = await scope.db
    .selectFrom('identity.staff_recovery_approvals')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('request_id', '=', requestId)
    .where('decision', '=', 'approve')
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * Marks overdue open requests expired (all of them, or one account's), each with an audit entry; returns how many.
 * Rows another transaction holds are skipped: it decides them itself.
 */
export async function expireStale(scope: TxScope, o: { userId?: string; limit?: number } = {}, now = new Date()): Promise<number> {
  const { rows } = await sql<{ id: string; user_id: string; previous: string }>`
    WITH stale AS (
      SELECT id, status FROM identity.staff_recovery_requests
       WHERE deleted_at IS NULL
         AND status IN ('awaiting_email_code','awaiting_approvals','approved') AND expires_at <= ${now}
         ${o.userId ? sql`AND user_id = ${o.userId}::uuid` : sql``}
       ORDER BY id
       LIMIT ${o.limit ?? 200}
         FOR UPDATE SKIP LOCKED)
    UPDATE identity.staff_recovery_requests r
       SET status = 'expired', expired_at = ${now}
      FROM stale
     WHERE r.id = stale.id
    RETURNING r.id, r.user_id, stale.status AS previous`.execute(scope.db);
  for (const r of rows)
    await writeAudit(scope, {
      action: 'staff.recovery_expired',
      entityType: 'staff_recovery_request',
      entityId: r.id,
      previous: r.previous,
      next: `expired (account ${r.user_id})`,
    });
  return rows.length;
}

async function requestByHandle(scope: TxScope, handleHash: string, lock = false): Promise<RecoveryRow | undefined> {
  const q = scope.db
    .selectFrom('identity.staff_recovery_requests')
    .selectAll()
    .where('handle_hash', '=', handleHash)
    .where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

/** 40 StaffRecoveryStatus: what the requester's browser may know (no names, no decisions). */
async function statusOf(scope: TxScope, r: RecoveryRow) {
  return {
    status: effectiveStatus(r) as Exclude<RecoveryStatus, 'awaiting_email_code'>,
    password_forgotten: r.password_forgotten,
    approvals: Math.min(RECOVERY_APPROVALS, await approvalsOf(scope, r.id)),
    expires_at: iso(r.expires_at),
  };
}

/** The console's address for the links in staff recovery emails: the origin of cp-web-admin's registered callback. */
export function consoleUrl(config: CarpalConfig): string {
  const uri = config.auth.redirectUris['cp-web-admin']?.[0];
  try {
    return uri ? new URL(uri).origin : 'https://admin.carpals.ir';
  } catch {
    return 'https://admin.carpals.ir';
  }
}

const staffName = (u: UserRow): string => u.display_name ?? u.full_name;

// ------------------------------------------------------------------ auth host

type StartBody = { interaction_id: string; email: string; password?: string; password_forgotten: boolean; recovery_code: string };

@Injectable()
@Operation('auth.staff_recovery_start')
export class StaffRecoveryStartHandler implements OperationHandler {
  /** Verified when no account matches, so every attempt with a password costs the same Argon2id work. */
  #dummyHash: Promise<string> | null = null;

  constructor(
    private readonly auth: AuthServer,
    private readonly crypto: CryptoServices,
    private readonly codes: StaffRecoveryCodes,
    private readonly messages: IdentityMessages,
    @InjectLogger() private readonly log: Logger,
  ) {}

  async handle(ctx: OperationContext<StartBody>): Promise<OperationResult> {
    const b = ctx.body;
    // "C: password required unless password_forgotten, forbidden with it".
    if (b.password_forgotten && b.password !== undefined)
      throw ApiError.validation([{ pointer: '/password', code: 'conditional_forbidden' }]);
    if (!b.password_forgotten && b.password === undefined)
      throw ApiError.validation([{ pointer: '/password', code: 'conditional_required' }]);
    const i = await this.auth.interaction(ctx, b.interaction_id);
    if (i.clientId !== 'cp-web-admin') throw new ApiError('INVALID_CREDENTIALS');
    const email = normalizeEmail(b.email);
    await ctx.rateLimit('auth.recovery', 'account', email);
    const handle = randomBytes(32).toString('base64url');
    const handleHash = handleHashOf(handle);
    await withMinLatency(this.auth.config.auth.minLatencyMs, async () => {
      const opened = await ctx.tx(async (scope) => {
        // The account row is locked, so two starts for one account run one after the other (one open request).
        const user = await findAccount(scope, { email }, true);
        let proven = b.password_forgotten;
        if (!b.password_forgotten) {
          const [method] = user ? (await methods(scope, user.id, ['email_password'])).filter((m) => m.status === 'active') : [];
          this.#dummyHash ??= this.crypto.passwords.hash(randomBytes(16).toString('hex'));
          const ok = await this.crypto.passwords.verify(b.password!, method?.credential_reference ?? (await this.#dummyHash));
          proven = ok && !!method;
        }
        if (!user || !proven || !(await recoverable(scope, user))) return null;
        await expireStale(scope, { userId: user.id });
        const open = await scope.db
          .selectFrom('identity.staff_recovery_requests')
          .select('id')
          .where('user_id', '=', user.id)
          .where('status', 'in', OPEN as string[])
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (open) return null;
        // DQ-04: the recovery code is spent only when everything else is right, and opens the request.
        if (!(await this.codes.use(scope, user.id, b.recovery_code))) return null;
        const row = await scope.db
          .insertInto('identity.staff_recovery_requests')
          .values({
            user_id: user.id,
            password_forgotten: b.password_forgotten,
            handle_hash: handleHash,
            // No IP-to-country lookup exists yet (sessions have none either): ip_country stays empty (S16b-D3).
            ip_country: null,
            // The emailed code's lifetime; the 24 hours start counting from the opening once the code is checked.
            expires_at: new Date(Date.now() + OTP_TTL_MS),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeAudit(scope, {
          action: 'staff.recovery_requested',
          entityType: 'staff_recovery_request',
          entityId: row.id,
          next: `account ${user.id}; ${b.password_forgotten ? 'password forgotten' : 'password proven'}; one recovery code spent`,
        });
        return user;
      });
      const code = newOtpCode();
      i.staffRecovery = {
        handleHash,
        // Nothing opened: a random hash that no code can match, so verify answers like a wrong code.
        codeHash: opened ? this.auth.state.otpHash(code, `recovery:${i.id}`) : randomBytes(32).toString('hex'),
        attempts: 0,
        expiresAt: Date.now() + OTP_TTL_MS,
        live: !!opened,
      };
      await this.auth.state.saveInteraction(i);
      if (!opened) return;
      await this.messages.email(opened.email, 'identity.staff_recovery_code', opened.locale, { code });
      this.log.warn({ security_event: 'staff_recovery_requested', client_id: i.clientId }, 'staff recovery requested');
    });
    return { status: 202, body: { request_handle: handle } };
  }
}

@Injectable()
@Operation('auth.staff_recovery_verify')
export class StaffRecoveryVerifyHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ interaction_id: string; request_handle: string; code: string }>): Promise<OperationResult> {
    const b = ctx.body;
    const i = await this.auth.interaction(ctx, b.interaction_id);
    const p = i.staffRecovery;
    if (
      i.clientId !== 'cp-web-admin' ||
      !p ||
      !constantTimeEqual(handleHashOf(b.request_handle), p.handleHash) ||
      p.expiresAt < Date.now() ||
      p.attempts >= OTP_MAX_ATTEMPTS
    )
      throw new ApiError('CODE_INVALID');
    await ctx.rateLimit('auth.signin', 'account', p.handleHash);
    if (!p.live || !constantTimeEqual(this.auth.state.otpHash(b.code, `recovery:${i.id}`), p.codeHash)) {
      p.attempts += 1;
      // Five wrong codes end the request's way forward (SEC-AU-8); it expires unverified.
      if (p.attempts >= OTP_MAX_ATTEMPTS) delete i.staffRecovery;
      await this.auth.state.saveInteraction(i);
      throw new ApiError('CODE_INVALID');
    }
    delete i.staffRecovery;
    const out = await ctx.tx(async (scope) => {
      const r = await requestByHandle(scope, p.handleHash, true);
      if (!r || effectiveStatus(r) !== 'awaiting_email_code') return null;
      const user = await getUser(scope, r.user_id);
      if (!user || !(await recoverable(scope, user))) return null;
      const row = await scope.db
        .updateTable('identity.staff_recovery_requests')
        .set({
          status: 'awaiting_approvals',
          email_verified_at: sql<Date>`now()`,
          // RECOVERY_TTL_MS: 24 hours from the opening (DQ-04).
          expires_at: sql<Date>`created_at + interval '24 hours'`,
        })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'staff.recovery_email_verified',
        entityType: 'staff_recovery_request',
        entityId: r.id,
        previous: 'awaiting_email_code',
        next: 'awaiting_approvals',
      });
      // S17: the in-app staff notice to every other administrator (the worker routes it).
      await publishEvent(scope, {
        type: 'staff.recovery_requested',
        aggregateType: 'staff_recovery_request',
        aggregateId: r.id,
        payload: { user_id: user.id, staff_name: staffName(user) },
      });
      return { status: await statusOf(scope, row), user, admins: await activeAdmins(scope, user.id) };
    });
    await this.auth.state.saveInteraction(i);
    if (!out) throw new ApiError('CODE_INVALID');
    // Emails here; the in-app staff notice follows from staff.recovery_requested (S17, S16b-D2).
    const link = consoleUrl(this.auth.config);
    for (const a of out.admins)
      await this.messages.email(a.email, 'identity.staff_recovery_requested_admins', a.locale, {
        staff_name: staffName(out.user),
        console_url: link,
      });
    return { body: out.status };
  }
}

@Injectable()
@Operation('auth.staff_recovery_status')
export class StaffRecoveryStatusHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ request_handle: string }>): Promise<OperationResult> {
    const body = await ctx.tx(
      async (scope) => {
        const r = await requestByHandle(scope, handleHashOf(ctx.body.request_handle));
        // A request whose emailed code was never checked does not exist for the browser (as an unknown handle).
        if (!r || r.email_verified_at === null) return null;
        return statusOf(scope, r);
      },
      { readOnly: true },
    );
    if (!body) throw new ApiError('NOT_FOUND');
    return { body };
  }
}

/** An approved request that is still open, else 409 INVALID_TRANSITION(expired|not_approved). */
function requireApproved(r: RecoveryRow): void {
  const status = effectiveStatus(r);
  if (status === 'expired') throw new ApiError('INVALID_TRANSITION', { detail: 'expired' });
  if (status !== 'approved') throw new ApiError('INVALID_TRANSITION', { detail: 'not_approved' });
}

@Injectable()
@Operation('auth.staff_recovery_complete_options')
export class StaffRecoveryCompleteOptionsHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly crypto: CryptoServices,
    private readonly webauthn: WebAuthnService,
  ) {}

  async handle(ctx: OperationContext<{ interaction_id: string; request_handle: string; new_password?: string }>): Promise<OperationResult> {
    const b = ctx.body;
    const i = await this.auth.interaction(ctx, b.interaction_id);
    if (i.clientId !== 'cp-web-admin' || i.completed) throw new ApiError('INVALID_CREDENTIALS');
    const handleHash = handleHashOf(b.request_handle);
    await ctx.rateLimit('auth.signin', 'account', handleHash);
    if (b.new_password !== undefined && isBreachedPassword(b.new_password))
      throw ApiError.validation([{ pointer: '/new_password', code: 'pattern' }]);
    const r = await ctx.tx(async (scope) => {
      const req = await requestByHandle(scope, handleHash, true);
      if (!req || req.email_verified_at === null) throw new ApiError('INVALID_CREDENTIALS');
      requireApproved(req);
      // "C: required when the request has password_forgotten, forbidden otherwise".
      if (req.password_forgotten && b.new_password === undefined)
        throw ApiError.validation([{ pointer: '/new_password', code: 'conditional_required' }]);
      if (!req.password_forgotten && b.new_password !== undefined)
        throw ApiError.validation([{ pointer: '/new_password', code: 'conditional_forbidden' }]);
      const user = await getUser(scope, req.user_id);
      if (!user || !(await recoverable(scope, user))) throw new ApiError('INVALID_TRANSITION', { detail: 'not_approved' });
      const reg = await this.webauthn.registrationOptions(
        scope,
        { id: user.id, email: user.email, displayName: user.display_name ?? user.full_name },
        'Staff key (recovery)',
      );
      return { requestId: req.id, userId: user.id, reg };
    });
    const passwordHash = b.new_password !== undefined ? await this.crypto.passwords.hash(b.new_password) : undefined;
    // The interaction names no account yet: it becomes the account's only when the new key is stored.
    delete i.staffRecovery;
    delete i.enrol;
    delete i.webauthn;
    i.recovery = { requestId: r.requestId, userId: r.userId, methodId: r.reg.methodId, ...(passwordHash ? { passwordHash } : {}) };
    await this.auth.state.saveInteraction(i);
    return { body: r.reg.options };
  }
}

@Injectable()
@Operation('auth.staff_recovery_complete')
export class StaffRecoveryCompleteHandler implements OperationHandler {
  constructor(
    private readonly auth: AuthServer,
    private readonly webauthn: WebAuthnService,
    private readonly codes: StaffRecoveryCodes,
    private readonly sessions: SessionStore,
    private readonly messages: IdentityMessages,
    @InjectLogger() private readonly log: Logger,
  ) {}

  async handle(ctx: OperationContext<{ interaction_id: string; attestation: unknown }>): Promise<OperationResult> {
    const i = await this.auth.interaction(ctx, ctx.body.interaction_id);
    const rc = i.recovery;
    if (i.clientId !== 'cp-web-admin' || !rc || i.completed) throw new ApiError('INVALID_CREDENTIALS');
    await ctx.rateLimit('auth.signin', 'account', rc.userId);
    const out = await ctx.tx(async (scope) => {
      const req = await scope.db
        .selectFrom('identity.staff_recovery_requests')
        .selectAll()
        .where('id', '=', rc.requestId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!req || req.user_id !== rc.userId) throw new ApiError('INVALID_CREDENTIALS');
      requireApproved(req);
      const user = await getUser(scope, req.user_id, true);
      if (!user || !(await recoverable(scope, user))) throw new ApiError('INVALID_TRANSITION', { detail: 'not_approved' });
      const pending = (await methods(scope, user.id, ['webauthn'], true)).find((m) => m.id === rc.methodId && m.status === 'pending');
      if (!pending) throw new ApiError('CODE_INVALID', { detail: 'no pending passkey' });
      await this.webauthn.confirmRegistration(scope, pending, ctx.body.attestation);
      const stored = (await methods(scope, user.id, ['webauthn'])).find((m) => m.id === rc.methodId)!;
      // Throwing rolls everything back: a synced passkey never becomes a staff credential and nothing changes (SEC-ADM-2).
      if (!isDeviceBoundPasskey(stored)) throw new ApiError('PASSKEY_NOT_DEVICE_BOUND');
      const old = await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'disabled', deleted_at: sql<Date>`now()` })
        .where('user_id', '=', user.id)
        .where('method_type', '=', 'webauthn')
        .where('id', '<>', rc.methodId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'active', verified_at: sql<Date>`now()` })
        .where('id', '=', rc.methodId)
        .execute();
      await scope.db.updateTable('identity.user_accounts').set({ mfa_enabled: true }).where('id', '=', user.id).execute();
      if (rc.passwordHash) {
        const [pw] = (await methods(scope, user.id, ['email_password'], true)).filter((m) => m.status === 'active');
        if (pw)
          await scope.db
            .updateTable('identity.authentication_methods')
            .set({ credential_reference: rc.passwordHash })
            .where('id', '=', pw.id)
            .execute();
        else
          await scope.db
            .insertInto('identity.authentication_methods')
            .values({
              user_id: user.id,
              method_type: 'email_password',
              identifier: user.email,
              credential_reference: rc.passwordHash,
              status: 'active',
            })
            .execute();
      }
      // A new set voids every open code of the old sheet.
      const codes = await this.codes.issue(scope, user.id);
      const restrictedUntil = new Date(Date.now() + RECOVERY_RESTRICTION_MS);
      await scope.db
        .updateTable('identity.staff_recovery_requests')
        .set({ status: 'completed', completed_at: sql<Date>`now()`, restricted_until: restrictedUntil })
        .where('id', '=', req.id)
        .execute();
      await writeAudit(scope, {
        action: 'staff.recovery_completed',
        entityType: 'staff_recovery_request',
        entityId: req.id,
        previous: 'approved',
        next: [
          `account ${user.id}`,
          `${Number(old.numUpdatedRows)} old keys disabled`,
          'new device-bound key',
          rc.passwordHash ? 'new password' : 'password kept',
          `${codes.length} new recovery codes (the old set is void)`,
          `restricted until ${restrictedUntil.toISOString()}`,
        ].join('; '),
      });
      await publishEvent(scope, {
        type: 'staff.recovery_completed',
        aggregateType: 'staff_recovery_request',
        aggregateId: req.id,
        payload: { user_id: user.id, staff_name: staffName(user) },
      });
      return { user, codes, admins: await activeAdmins(scope, user.id) };
    });
    // Every session and refresh token of the account ends (refresh families die with their sessions).
    await this.sessions.revokeAll(out.user.id);
    delete i.recovery;
    i.userId = out.user.id;
    i.amr = [];
    i.acr = 'aal1';
    i.authTime = Math.floor(Date.now() / 1000);
    await this.messages.email(out.user.email, 'identity.staff_recovery_completed_account', out.user.locale);
    for (const a of out.admins)
      await this.messages.email(a.email, 'identity.staff_recovery_completed_admins', a.locale, { staff_name: staffName(out.user) });
    this.log.warn({ security_event: 'staff_recovery_completed', client_id: i.clientId }, 'staff recovery completed');
    // The new key proves itself at once: a fresh mfa ceremony on this interaction (aal3 at auth.mfa_verify).
    return { body: { ...(await this.auth.afterEnrolment(i)), recovery_codes: out.codes } };
  }
}

// ------------------------------------------------------------------ restriction and expiry

@Injectable()
export class DbStaffRestrictions extends StaffRestrictions {
  async restrictedUntil(scope: TxScope, userId: string): Promise<Date | null> {
    const r = await scope.db
      .selectFrom('identity.staff_recovery_requests')
      .select((eb) => eb.fn.max('restricted_until').as('until'))
      .where('user_id', '=', userId)
      .where('restricted_until', '>', sql<Date>`now()`)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return r?.until ? new Date(r.until) : null;
  }

  async assertNotRestricted(scope: TxScope, userId: string): Promise<void> {
    const until = await this.restrictedUntil(scope, userId);
    if (until) throw new ApiError('STAFF_RECOVERY_RESTRICTED', { detail: `until ${until.toISOString()}` });
  }
}

/** W15 "staff recovery expiry" (backend S16b): every 5 minutes, overdue open requests become expired (audited). */
@Injectable()
export class StaffRecoveryExpiryRule extends ScheduledRule {
  readonly name = 'identity.staff_recovery_expiry';
  readonly everyMs = 300_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  /** Returns the number of requests expired. */
  async run(now = new Date()): Promise<number> {
    return this.tx.run({ actorType: 'system' }, (scope) => expireStale(scope, {}, now));
  }
}
