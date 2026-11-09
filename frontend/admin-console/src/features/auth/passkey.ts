// Staff passkeys (AC4.T1/T2, SEC-ADM-2), adapted from pwa/src/features/auth/passkey.ts: the auth host's WebAuthn options
// go to the browser through @simplewebauthn/browser (major 14, matching @simplewebauthn/server 14 in backend/) and the
// result goes back through the /id proxy. Sign-in: auth.webauthn_options (purpose signin = the key alone, or mfa =
// after the password) then auth.mfa_verify method webauthn. First passkey of a staff account: auth.passkey_enrol_options
// with the emailed code, navigator.credentials.create(), auth.passkey_enrol; the auth host then asks for the new key at
// once (next mfa). Only device-bound credentials count: a passkey synced across devices is refused (422
// PASSKEY_NOT_DEVICE_BOUND) and not stored.
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { AuthNext, WebAuthnAssertion, WebAuthnAttestation } from '@carpal/api-contracts';
import type { AuthClient } from './auth-client';

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** The staff member closed the browser's key prompt or no key answered in time: not an error worth a message. */
export function passkeyCancelled(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

/** A security key that already holds a credential for this account (InvalidStateError at create()). */
export function passkeyAlreadyRegistered(err: unknown): boolean {
  return err instanceof Error && err.name === 'InvalidStateError';
}

export async function verifyWithPasskey(auth: AuthClient, interactionId: string, purpose: 'signin' | 'mfa'): Promise<AuthNext> {
  const options = await auth.call('auth.webauthn_options', { interaction_id: interactionId, purpose });
  const assertion = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return auth.call('auth.mfa_verify', {
    interaction_id: interactionId,
    method: 'webauthn',
    assertion: assertion as unknown as WebAuthnAssertion,
  });
}

/** Checks the emailed code and gets the creation options (a wrong code fails here, before any browser prompt). */
export async function enrolmentOptions(
  auth: AuthClient,
  interactionId: string,
  code: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await auth.call('auth.passkey_enrol_options', { interaction_id: interactionId, code });
  return options as unknown as PublicKeyCredentialCreationOptionsJSON;
}

/** Creates the credential with the browser and stores it (answers next 'mfa' with the new key). */
export async function enrolPasskey(
  auth: AuthClient,
  interactionId: string,
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<AuthNext> {
  const attestation = await startRegistration({ optionsJSON: options });
  return auth.call('auth.passkey_enrol', { interaction_id: interactionId, attestation: attestation as unknown as WebAuthnAttestation });
}
