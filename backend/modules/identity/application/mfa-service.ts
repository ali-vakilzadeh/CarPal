// Second factors (40 SEC-AU-9, 52 AuthenticationMethod), shared by the
// account API (enrol, confirm, remove, recovery codes) and the auth server
// (auth.mfa_verify). TOTP secrets are envelope-encrypted at rest (AAD binds
// the blob to its method row); the last used step is kept in credential_data
// so a code cannot be replayed. Recovery codes are stored as HMAC, one row
// each, and are single use.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { base32Decode, base32Encode, newRecoveryCodes, normalizeRecoveryCode, verifyTotp } from '../domain/credentials.js';
import { methods, type MethodRow } from '../infrastructure/accounts.js';

const ENC = 'enc1:';

@Injectable()
export class MfaService {
  constructor(private readonly crypto: CryptoServices) {}

  /** credential_reference of a new TOTP method: the encrypted base32 secret. */
  sealSecret(methodId: string, secret: Buffer): string {
    return ENC + this.crypto.envelope.encrypt(base32Encode(secret), `identity.totp:${methodId}`).toString('base64');
  }

  #secret(m: MethodRow): Buffer {
    const ref = m.credential_reference ?? '';
    if (!ref.startsWith(ENC)) throw new Error(`TOTP method ${m.id} has no sealed secret`);
    return base32Decode(this.crypto.envelope.decryptString(Buffer.from(ref.slice(ENC.length), 'base64'), `identity.totp:${m.id}`));
  }

  /** Checks a TOTP code against one method (row locked by the caller); records the used step. */
  async checkTotp(scope: TxScope, m: MethodRow, code: string): Promise<boolean> {
    const data = (m.credential_data as { last_step?: number } | null) ?? {};
    const step = verifyTotp(this.#secret(m), code, data.last_step ?? null);
    if (step === null) return false;
    await scope.db
      .updateTable('identity.authentication_methods')
      .set({ credential_data: JSON.stringify({ ...data, last_step: step }), last_used_at: sql`now()` })
      .where('id', '=', m.id)
      .execute();
    return true;
  }

  /** Any active TOTP method of the user accepts the code. */
  async verifyAnyTotp(scope: TxScope, userId: string, code: string): Promise<boolean> {
    for (const m of await methods(scope, userId, ['totp_mfa'], true)) {
      if (m.status === 'active' && (await this.checkTotp(scope, m, code))) return true;
    }
    return false;
  }

  #codeHash(userId: string, code: string): string {
    return this.crypto.hmac.digest('otp', `rc:${userId}:${normalizeRecoveryCode(code)}`).toString('hex');
  }

  /** Replaces all recovery codes with ten new ones; returns them once. */
  async issueRecoveryCodes(scope: TxScope, userId: string): Promise<string[]> {
    await this.disableRecoveryCodes(scope, userId);
    const codes = newRecoveryCodes();
    await scope.db
      .insertInto('identity.authentication_methods')
      .values(
        codes.map((c) => ({
          user_id: userId,
          method_type: 'recovery_code',
          identifier: uuidv7(),
          credential_reference: this.#codeHash(userId, c),
          status: 'active',
          verified_at: new Date(),
        })),
      )
      .execute();
    return codes;
  }

  async disableRecoveryCodes(scope: TxScope, userId: string): Promise<void> {
    await scope.db
      .updateTable('identity.authentication_methods')
      .set({ status: 'disabled', deleted_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('method_type', '=', 'recovery_code')
      .where('deleted_at', 'is', null)
      .execute();
  }

  /** Single use: an unused code is marked used in one conditional update. */
  async useRecoveryCode(scope: TxScope, userId: string, code: string): Promise<boolean> {
    const used = await scope.db
      .updateTable('identity.authentication_methods')
      .set({ last_used_at: sql`now()`, status: 'disabled' })
      .where('user_id', '=', userId)
      .where('method_type', '=', 'recovery_code')
      .where('credential_reference', '=', this.#codeHash(userId, code))
      .where('status', '=', 'active')
      .where('last_used_at', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(used.numUpdatedRows) === 1;
  }
}
