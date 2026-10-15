// WebAuthn passkeys and security keys (GD-31; 40 SEC-AU-9, SEC-AU-10,
// SEC-ADM-2; @simplewebauthn/server, the FIDO2 library of Google's
// webauthndemo). Credentials are 52 AuthenticationMethod rows of type
// webauthn: identifier = credential id (base64url), credential_data = the
// public key, signature counter, transports and whether the credential is
// bound to one device (a hardware key or a non-synced platform key: aal3 for
// staff). Options are WebAuthn Level 3 JSON with attestation none and
// userVerification required; challenges live 5 minutes.
import { Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import { sql } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { methods, type MethodRow } from '../infrastructure/accounts.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
/** EdDSA, ES256, RS256: the widely supported algorithms (no experimental post-quantum ones yet). */
const ALGORITHMS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];

/** credential_data of a webauthn method (pending: the registration challenge only). */
interface CredentialData {
  challenge?: string;
  challenge_expires_at?: number;
  credential_id?: string;
  public_key?: string;
  counter?: number;
  transports?: string[];
  device_bound?: boolean;
  aaguid?: string;
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const dataOf = (m: MethodRow): CredentialData => (m.credential_data ?? {}) as CredentialData;

@Injectable()
export class WebAuthnService {
  constructor(@InjectConfig() private readonly config: CarpalConfig) {}

  private get rp() {
    return this.config.webauthn;
  }

  /** me.webauthn_register_options: a pending credential holding the challenge; earlier pending ones are discarded. */
  async registrationOptions(scope: TxScope, user: { id: string; email: string; displayName: string | null }, label: string) {
    const existing = (await methods(scope, user.id, ['webauthn'])).filter((m) => m.status === 'active');
    await scope.db
      .updateTable('identity.authentication_methods')
      .set({ status: 'disabled', deleted_at: sql`now()` })
      .where('user_id', '=', user.id)
      .where('method_type', '=', 'webauthn')
      .where('status', '=', 'pending')
      .where('deleted_at', 'is', null)
      .execute();
    const options = await generateRegistrationOptions({
      rpName: this.rp.rpName,
      rpID: this.rp.rpId,
      userName: user.email,
      userDisplayName: user.displayName ?? '',
      userID: new Uint8Array(Buffer.from(user.id.replace(/-/g, ''), 'hex')),
      attestationType: 'none',
      timeout: CHALLENGE_TTL_MS,
      excludeCredentials: existing.map((m) => ({
        id: dataOf(m).credential_id!,
        ...(dataOf(m).transports ? { transports: dataOf(m).transports } : {}),
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    const id = uuidv7();
    await scope.db
      .insertInto('identity.authentication_methods')
      .values({
        id,
        user_id: user.id,
        method_type: 'webauthn',
        identifier: `pending:${id}`,
        label,
        credential_data: JSON.stringify({
          challenge: options.challenge,
          challenge_expires_at: Date.now() + CHALLENGE_TTL_MS,
        } satisfies CredentialData),
        status: 'pending',
      })
      .execute();
    return { options, methodId: id };
  }

  /** me.mfa_confirm with an attestation: verifies it against the pending challenge and stores the credential. */
  async confirmRegistration(scope: TxScope, m: MethodRow, attestation: unknown): Promise<void> {
    const d = dataOf(m);
    if (!d.challenge || (d.challenge_expires_at ?? 0) < Date.now())
      throw new ApiError('CODE_INVALID', { detail: 'registration challenge expired' });
    let info;
    try {
      const r = await verifyRegistrationResponse({
        response: attestation as RegistrationResponseJSON,
        expectedChallenge: d.challenge,
        expectedOrigin: this.rp.origins,
        expectedRPID: this.rp.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
      if (!r.verified) throw new Error('not verified');
      info = r.registrationInfo;
    } catch {
      throw new ApiError('CODE_INVALID', { detail: 'attestation rejected' });
    }
    const data: CredentialData = {
      credential_id: info.credential.id,
      public_key: b64url(info.credential.publicKey),
      counter: info.credential.counter,
      ...(info.credential.transports ? { transports: info.credential.transports } : {}),
      device_bound: info.credentialDeviceType === 'singleDevice',
      aaguid: info.aaguid,
    };
    await scope.db
      .updateTable('identity.authentication_methods')
      .set({ identifier: info.credential.id, credential_data: JSON.stringify(data) })
      .where('id', '=', m.id)
      .execute();
  }

  /** auth.webauthn_options: request options; for a known user, only that user's credentials are allowed. */
  async authenticationOptions(scope: TxScope, userId: string | null) {
    const creds = userId ? (await methods(scope, userId, ['webauthn'])).filter((m) => m.status === 'active') : [];
    return generateAuthenticationOptions({
      rpID: this.rp.rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: 'required',
      allowCredentials: creds.map((m) => ({
        id: dataOf(m).credential_id!,
        ...(dataOf(m).transports ? { transports: dataOf(m).transports } : {}),
      })),
    });
  }

  /**
   * Verifies an assertion against the ceremony's challenge; the credential
   * must be active (and the user's, when the user is known). Updates the
   * signature counter. Returns null when the assertion does not verify.
   */
  async verifyAssertion(
    scope: TxScope,
    assertion: unknown,
    challenge: string,
    userId: string | null,
  ): Promise<{ userId: string; methodId: string; deviceBound: boolean } | null> {
    const a = assertion as AuthenticationResponseJSON;
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') return null;
    let q = scope.db
      .selectFrom('identity.authentication_methods')
      .selectAll()
      .where('method_type', '=', 'webauthn')
      .where('identifier', '=', a.id)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null);
    if (userId) q = q.where('user_id', '=', userId);
    const m = await q.forUpdate().executeTakeFirst();
    if (!m) return null;
    const d = dataOf(m);
    try {
      const r = await verifyAuthenticationResponse({
        response: a,
        expectedChallenge: challenge,
        expectedOrigin: this.rp.origins,
        expectedRPID: this.rp.rpId,
        requireUserVerification: true,
        credential: {
          id: d.credential_id!,
          publicKey: new Uint8Array(Buffer.from(d.public_key!, 'base64url')),
          counter: d.counter ?? 0,
          ...(d.transports ? { transports: d.transports as never } : {}),
        },
      });
      if (!r.verified) return null;
      await scope.db
        .updateTable('identity.authentication_methods')
        .set({ credential_data: JSON.stringify({ ...d, counter: r.authenticationInfo.newCounter }), last_used_at: sql`now()` })
        .where('id', '=', m.id)
        .execute();
      return { userId: m.user_id, methodId: m.id, deviceBound: d.device_bound === true };
    } catch {
      return null;
    }
  }
}
