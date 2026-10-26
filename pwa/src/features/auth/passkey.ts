// Passkeys (P4.T4, BA-09): the auth host's WebAuthn request options (auth.webauthn_options) go to the browser through
// @simplewebauthn/browser (major 14, matching @simplewebauthn/server 14 in backend/), and the assertion goes back
// with auth.mfa_verify method webauthn — as the only factor ("Sign in with a passkey", purpose signin) or as the
// second factor (purpose mfa). The RP ID is the auth host's (dev: localhost, CARPAL_WEBAUTHN_RP_ID).
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { ApiClient } from '@/lib/api/client';
import type { OperationResponse, WebAuthnAssertion } from '@carpal/api-contracts';

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** The person closed the browser's passkey sheet or no passkey matched: not an error worth a message. */
export function passkeyCancelled(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

export async function verifyWithPasskey(
  api: ApiClient,
  interactionId: string,
  purpose: 'signin' | 'mfa',
): Promise<OperationResponse<'auth.mfa_verify'>> {
  const options = await api.api('auth.webauthn_options', { body: { interaction_id: interactionId, purpose } });
  const assertion = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return api.api('auth.mfa_verify', {
    body: { interaction_id: interactionId, method: 'webauthn', assertion: assertion as unknown as WebAuthnAssertion },
  });
}
