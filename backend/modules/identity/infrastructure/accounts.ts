// Account data access shared by the account API (api host, user context) and
// the auth server (auth host, system context): identity.* tables only.
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { registerConstraintErrors, type DB } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export type UserRow = Selectable<DB['identity.user_accounts']>;
export type PreferenceRow = Selectable<DB['identity.user_preferences']>;
export type MethodRow = Selectable<DB['identity.authentication_methods']>;
export type MembershipRow = Selectable<DB['identity.role_memberships']>;

registerConstraintErrors({
  user_accounts_email_uq: 'DUPLICATE',
  user_accounts_phone_uq: 'DUPLICATE',
  data_subject_requests_open_uq: 'DUPLICATE',
});

/** 40 §3.1 Email is lower-cased (the schema checks the shape only). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** The live (not deleted) account of an email or phone. */
export async function findAccount(scope: TxScope, by: { email: string } | { phone: string }, lock = false): Promise<UserRow | undefined> {
  let q = scope.db.selectFrom('identity.user_accounts').selectAll().where('deleted_at', 'is', null).where('status', '<>', 'deleted');
  q = 'email' in by ? q.where('email', '=', normalizeEmail(by.email)) : q.where('phone', '=', by.phone);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

export async function getUser(scope: TxScope, userId: string, lock = false): Promise<UserRow | undefined> {
  const q = scope.db.selectFrom('identity.user_accounts').selectAll().where('id', '=', userId).where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

export async function getPreferences(scope: TxScope, userId: string): Promise<PreferenceRow> {
  return scope.db.selectFrom('identity.user_preferences').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
}

/** Methods of a user by type, live (not deleted) ones only. */
export async function methods(scope: TxScope, userId: string, types: MethodRow['method_type'][], lock = false): Promise<MethodRow[]> {
  const q = scope.db
    .selectFrom('identity.authentication_methods')
    .selectAll()
    .where('user_id', '=', userId)
    .where('method_type', 'in', types)
    .where('deleted_at', 'is', null)
    .orderBy('id');
  return (lock ? q.forUpdate() : q).execute();
}

/** Active second factors (TOTP and WebAuthn), 52 AuthenticationMethod. */
export async function activeSecondFactors(scope: TxScope, userId: string): Promise<MethodRow[]> {
  return (await methods(scope, userId, ['totp_mfa', 'webauthn'])).filter((m) => m.status === 'active');
}

export async function platformRoles(scope: TxScope, userId: string): Promise<string[]> {
  const rows = await scope.db
    .selectFrom('identity.role_memberships')
    .select('role')
    .where('user_id', '=', userId)
    .where('organization_id', 'is', null)
    .where('role', 'like', 'platform\\_%')
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .execute();
  return rows.map((r) => r.role);
}

/** Expires the remaining active link tokens of a type (a new link replaces the old ones). */
export async function revokeVerificationTokens(
  scope: TxScope,
  userId: string,
  type: 'email_verification' | 'password_reset',
): Promise<void> {
  await scope.db
    .updateTable('identity.verification_tokens')
    .set({ status: 'revoked' })
    .where('user_id', '=', userId)
    .where('token_type', '=', type)
    .where('status', '=', 'active')
    .execute();
}

/**
 * Atomic single use of an ev/pr link (SEC-LT-4, SEC-IC-5): one conditional
 * UPDATE; returns the row, or the follow-up read explaining the failure.
 */
export async function consumeVerificationToken(
  scope: TxScope,
  hash: Buffer,
  type: 'email_verification' | 'password_reset',
): Promise<
  { ok: true; userId: string; targetEmail: string | null } | { ok: false; usedAt: Date | null } | { ok: false; usedAt: undefined }
> {
  const row = await scope.db
    .updateTable('identity.verification_tokens')
    .set({ used_at: sql`now()`, status: 'used' })
    .where('token_hash', '=', hash)
    .where('token_type', '=', type)
    .where('status', '=', 'active')
    .where('used_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .where('deleted_at', 'is', null)
    .returning(['user_id', 'target_email'])
    .executeTakeFirst();
  if (row) return { ok: true, userId: row.user_id, targetEmail: row.target_email };
  const seen = await scope.db
    .selectFrom('identity.verification_tokens')
    .select('used_at')
    .where('token_hash', '=', hash)
    .where('token_type', '=', type)
    .executeTakeFirst();
  return { ok: false, usedAt: seen ? seen.used_at : undefined };
}
