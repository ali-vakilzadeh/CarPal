// Staff security on the admin plane (backend S16a, contract 1.4.0; admin console BR-19; owner decision DQ-04): the
// staff member's own recovery codes and device-bound keys, and the break-glass reset run from the server shell.
//
// Recovery codes (52 StaffRecoveryCode): ten single-use codes per account, 20 Crockford base32 characters each,
// stored only as HMAC-SHA-256 with a server key and compared in constant time. They are used only to ask for an
// account recovery (S16b), never as a sign-in factor. A set is shown once: at the first passkey enrolment
// (auth.passkey_enrol) and from admin.staff_recovery_codes_regenerate; a new set voids the old one.
//
// Own keys: list, add a backup key and remove one, each after a fresh aal3 (5 minutes, SEC-ADM-2). Only device-bound
// credentials are stored (PASSKEY_NOT_DEVICE_BOUND), and the last device-bound key is never removed (LAST_PASSKEY).
// Every change ends the member's other sessions (SEC-AU-4) and is told to the account's email.
//
// Break glass (pnpm staff:break-glass, tools/db/staff.ts): disables the account's keys and recovery codes in the
// database and publishes staff.break_glass; StaffBreakGlassConsumer, in the running backend, ends the sessions (they
// live in the server process, which a CLI cannot reach) and tells the account and every active administrator.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { SessionStore } from '#libs/auth/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import {
  ACK,
  created,
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { EventEnvelope } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { EventConsumer, publishEvent } from '#libs/outbox/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { staffOf } from '#modules/admin/interface/admin.js';
import { constantTimeEqual, newStaffRecoveryCodes, normalizeStaffRecoveryCode } from '../domain/credentials.js';
import { getUser, methods, type MethodRow } from '../infrastructure/accounts.js';
import { IdentityMessages } from '../infrastructure/messages.js';
import { isDeviceBoundPasskey } from './auth-server.js';
import { WebAuthnService } from './webauthn.js';

/** SEC-ADM-2: sensitive staff operations need a sign-in at aal3 within the last 5 minutes. */
export const STAFF_FRESH_AAL3_S = 300;
/** At most this many active keys per staff member. */
export const STAFF_PASSKEY_LIMIT = 10;
/** The reason recorded for the member's own security changes (SEC-ADM-3: no reason is asked for one's own keys). */
const OWN_SECURITY = "the staff member's own security keys and recovery codes";

// ------------------------------------------------------------------ recovery codes

@Injectable()
export class StaffRecoveryCodes {
  constructor(private readonly crypto: CryptoServices) {}

  /** Keyed hash of a canonical code, bound to the account (a code of one account is worthless for another). */
  #hash(userId: string, canonical: string): string {
    return this.crypto.hmac.digest('staff-recovery-code', `src:${userId}:${canonical}`).toString('hex');
  }

  /** Voids the open codes and stores a new set of ten; returns the codes once. */
  async issue(scope: TxScope, userId: string): Promise<string[]> {
    await this.revokeAll(scope, userId);
    const codes = newStaffRecoveryCodes();
    const setId = uuidv7();
    await scope.db
      .insertInto('identity.staff_recovery_codes')
      .values(codes.map((c) => ({ user_id: userId, set_id: setId, code_hash: this.#hash(userId, normalizeStaffRecoveryCode(c)!) })))
      .execute();
    return codes;
  }

  /** Voids every open code of the account (a new set, or the break-glass reset). */
  async revokeAll(scope: TxScope, userId: string): Promise<number> {
    const r = await scope.db
      .updateTable('identity.staff_recovery_codes')
      .set({ revoked_at: sql<Date>`now()` })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  async remaining(scope: TxScope, userId: string): Promise<number> {
    const r = await scope.db
      .selectFrom('identity.staff_recovery_codes')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Math.min(10, Number(r.n));
  }

  /**
   * Spends one open code of the account (the recovery request of S16b). Every open code is compared in constant time,
   * so the answer takes as long whichever code matches; a used or voided code never matches again.
   */
  async use(scope: TxScope, userId: string, typed: string): Promise<boolean> {
    const canonical = normalizeStaffRecoveryCode(typed);
    const open = await scope.db
      .selectFrom('identity.staff_recovery_codes')
      .select(['id', 'code_hash'])
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .execute();
    // A malformed code is still hashed and compared, so it takes the same time as a wrong one.
    const hash = this.#hash(userId, canonical ?? 'X'.repeat(20));
    let match: string | null = null;
    for (const row of open) if (constantTimeEqual(row.code_hash, hash) && canonical) match = row.id;
    if (!match) return false;
    await scope.db
      .updateTable('identity.staff_recovery_codes')
      .set({ used_at: sql<Date>`now()` })
      .where('id', '=', match)
      .execute();
    return true;
  }
}

// ------------------------------------------------------------------ own keys

/** 40 StaffPasskey: one of the caller's own WebAuthn credentials (no credential id, no public key). */
function toStaffPasskey(m: MethodRow) {
  const d = (m.credential_data ?? {}) as { device_bound?: boolean; aaguid?: string };
  // "none" attestation: the AAGUID is the authenticator's claim, unverified; all zeros means it gave none.
  const aaguid = d.aaguid && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(d.aaguid) ? d.aaguid : null;
  return {
    id: m.id,
    label: (m.label ?? 'Security key').slice(0, 60),
    created_at: iso(m.verified_at ?? m.created_at),
    last_used_at: isoOrNull(m.last_used_at),
    device_bound: d.device_bound === true,
    aaguid,
  };
}

const activeKeys = async (scope: TxScope, userId: string, lock = false) =>
  (await methods(scope, userId, ['webauthn'], lock)).filter((m) => m.status === 'active');

@Injectable()
@Operation('admin.staff_passkeys_list')
export class AdminStaffPasskeysListHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const keys = await ctx.tx((scope) => activeKeys(scope, s.userId), { readOnly: true });
    return { body: { passkeys: keys.slice(0, 20).map(toStaffPasskey) } };
  }
}

@Injectable()
@Operation('admin.staff_passkey_register_options')
export class AdminStaffPasskeyRegisterOptionsHandler implements OperationHandler {
  constructor(private readonly webauthn: WebAuthnService) {}

  async handle(ctx: OperationContext<{ label: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    ctx.requireAssurance('aal3', STAFF_FRESH_AAL3_S);
    const body = await ctx.tx(async (scope) => {
      const user = await getUser(scope, s.userId);
      if (!user) throw new ApiError('NOT_FOUND');
      if ((await activeKeys(scope, s.userId)).length >= STAFF_PASSKEY_LIMIT)
        throw new ApiError('INVALID_TRANSITION', { detail: 'passkey_limit' });
      const r = await this.webauthn.registrationOptions(
        scope,
        { id: user.id, email: user.email, displayName: user.display_name ?? user.full_name },
        ctx.body.label,
      );
      return r.options;
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.staff_passkey_register')
export class AdminStaffPasskeyRegisterHandler implements OperationHandler {
  constructor(
    private readonly webauthn: WebAuthnService,
    private readonly sessions: SessionStore,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext<{ attestation: unknown }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    ctx.requireAssurance('aal3', STAFF_FRESH_AAL3_S);
    const sessionId = ctx.principal.kind === 'staff' ? ctx.principal.sessionId : undefined;
    const { key, user } = await ctx.tx(async (scope) => {
      // admin.staff_passkey_register_options keeps one pending credential per account (earlier ones are discarded).
      const pending = (await methods(scope, s.userId, ['webauthn'], true)).filter((m) => m.status === 'pending').at(-1);
      if (!pending) throw new ApiError('CODE_INVALID', { detail: 'no pending passkey' });
      if ((await activeKeys(scope, s.userId)).length >= STAFF_PASSKEY_LIMIT)
        throw new ApiError('INVALID_TRANSITION', { detail: 'passkey_limit' });
      await this.webauthn.confirmRegistration(scope, pending, ctx.body.attestation);
      const stored = (await methods(scope, s.userId, ['webauthn'])).find((m) => m.id === pending.id)!;
      // Throwing rolls the stored credential back: a synced passkey never becomes a staff credential (SEC-ADM-2).
      if (!isDeviceBoundPasskey(stored)) throw new ApiError('PASSKEY_NOT_DEVICE_BOUND');
      const row = await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'active', verified_at: sql<Date>`now()` })
        .where('id', '=', pending.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'staff.passkey_added',
        entityType: 'authentication_method',
        entityId: row.id,
        reason: OWN_SECURITY,
        next: `webauthn "${row.label ?? ''}" (device-bound)`.slice(0, 2000),
      });
      return { key: row, user: await getUser(scope, s.userId) };
    });
    // SEC-AU-4 (MFA change): the other sessions end; this one has just proven a key.
    await this.sessions.revokeAll(s.userId, sessionId);
    if (user) await this.messages.email(user.email, 'identity.staff_passkey_added', user.locale);
    return created(toStaffPasskey(key), `/v1/admin/me/passkeys/${key.id}`);
  }
}

@Injectable()
@Operation('admin.staff_passkey_remove')
export class AdminStaffPasskeyRemoveHandler implements OperationHandler {
  constructor(
    private readonly sessions: SessionStore,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    ctx.requireAssurance('aal3', STAFF_FRESH_AAL3_S);
    const sessionId = ctx.principal.kind === 'staff' ? ctx.principal.sessionId : undefined;
    const user = await ctx.tx(async (scope) => {
      const keys = await activeKeys(scope, s.userId, true);
      const key = keys.find((m) => m.id === ctx.params.method_id);
      if (!key) throw new ApiError('NOT_FOUND');
      // The account must keep a key it can sign in with (SEC-ADM-2: device-bound only).
      if (!keys.some((m) => m.id !== key.id && isDeviceBoundPasskey(m))) throw new ApiError('LAST_PASSKEY');
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ status: 'disabled', deleted_at: sql<Date>`now()` })
        .where('id', '=', key.id)
        .execute();
      await writeAudit(scope, {
        action: 'staff.passkey_removed',
        entityType: 'authentication_method',
        entityId: key.id,
        reason: OWN_SECURITY,
        previous: `webauthn "${key.label ?? ''}"`.slice(0, 2000),
      });
      return getUser(scope, s.userId);
    });
    await this.sessions.revokeAll(s.userId, sessionId);
    if (user) await this.messages.email(user.email, 'identity.staff_passkey_removed', user.locale);
    return { body: ACK };
  }
}

@Injectable()
@Operation('admin.staff_recovery_codes_regenerate')
export class AdminStaffRecoveryCodesRegenerateHandler implements OperationHandler {
  constructor(
    private readonly codes: StaffRecoveryCodes,
    private readonly messages: IdentityMessages,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    ctx.requireAssurance('aal3', STAFF_FRESH_AAL3_S);
    const { codes, user, at } = await ctx.tx(async (scope) => {
      const out = await this.codes.issue(scope, s.userId);
      // Audited without the codes.
      await writeAudit(scope, {
        action: 'staff.recovery_codes_regenerated',
        entityType: 'user_account',
        entityId: s.userId,
        reason: OWN_SECURITY,
        next: `${out.length} new codes; the previous set is void`,
      });
      return { codes: out, user: await getUser(scope, s.userId), at: new Date() };
    });
    if (user) await this.messages.email(user.email, 'identity.staff_recovery_codes_created', user.locale);
    // Staff responses are never cached (no-store, pipeline); the codes are not kept anywhere in plain text.
    return { body: { recovery_codes: codes, created_at: iso(at) } };
  }
}

// ------------------------------------------------------------------ break glass

export const BREAK_GLASS_EVENT = 'staff.break_glass';

/**
 * The database half of the break-glass reset (system context, tools/db/staff.ts): the account's keys (active and
 * pending) and open recovery codes are disabled, so the next sign-in enrols a key again with password + emailed code;
 * audited as actor system with the operator's reason; staff.break_glass carries the rest to the running backend.
 */
export async function breakGlass(
  scope: TxScope,
  codes: Pick<StaffRecoveryCodes, 'revokeAll'>,
  userId: string,
  reason: string,
): Promise<{ keys: number; codes: number }> {
  const keys = await scope.db
    .updateTable('identity.authentication_methods')
    .set({ status: 'disabled', deleted_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('method_type', '=', 'webauthn')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const voided = await codes.revokeAll(scope, userId);
  const summary = { keys: Number(keys.numUpdatedRows), codes: voided };
  await writeAudit(scope, {
    action: 'staff.break_glass',
    entityType: 'user_account',
    entityId: userId,
    reason,
    previous: `${summary.keys} WebAuthn credentials, ${summary.codes} open recovery codes`,
    next: 'keys and recovery codes disabled; the next sign-in enrols a key again',
  });
  await publishEvent(scope, {
    type: BREAK_GLASS_EVENT,
    aggregateType: 'user_account',
    aggregateId: userId,
    payload: { user_id: userId },
  });
  return summary;
}

/**
 * staff.break_glass in the running backend: ends the account's sessions and refresh tokens, drops its cached
 * permissions and tells the account and every other active administrator by email. The in-app staff notice comes
 * with the staff notices of S17.
 */
@Injectable()
export class StaffBreakGlassConsumer extends EventConsumer {
  readonly name = 'identity.staff_break_glass';
  readonly subjects = [BREAK_GLASS_EVENT];

  constructor(
    private readonly tx: TxRunner,
    private readonly sessions: SessionStore,
    private readonly authorizer: Authorizer,
    private readonly messages: IdentityMessages,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const userId = String(event.payload.user_id ?? event.aggregateId);
    const people = await this.tx.run(
      { actorType: 'system' },
      async (scope) => {
        const account = await getUser(scope, userId);
        const { rows: admins } = await sql<{ email: string; locale: string }>`
          SELECT DISTINCT u.email, u.locale
            FROM identity.role_memberships m
            JOIN identity.user_accounts u ON u.id = m.user_id AND u.deleted_at IS NULL AND u.status = 'active'
           WHERE m.organization_id IS NULL AND m.role = 'platform_admin' AND m.status = 'active' AND m.deleted_at IS NULL
             AND u.id <> ${userId}::uuid`.execute(scope.db);
        return { account, admins };
      },
      { readOnly: true },
    );
    await this.sessions.revokeAll(userId);
    await this.authorizer.invalidateUser(userId);
    const name = people.account ? (people.account.display_name ?? people.account.full_name) : userId;
    if (people.account) await this.messages.email(people.account.email, 'identity.staff_break_glass_account', people.account.locale);
    for (const a of people.admins) await this.messages.email(a.email, 'identity.staff_break_glass_admins', a.locale, { staff_name: name });
    this.logger.warn({ security_event: 'staff_break_glass', admins_notified: people.admins.length }, 'staff break glass applied');
  }
}
