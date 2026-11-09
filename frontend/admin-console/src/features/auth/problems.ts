// Auth errors → what the staff sign-in shows (AC4.T1), adapted from pwa/src/features/auth/problems.ts. Enumeration-safe
// (SEC-AU-11): the auth host answers the same for unknown accounts, wrong passwords and accounts staff disabled
// (INVALID_CREDENTIALS), so the console cannot show "account disabled" as its own state; the invalid-credentials
// message names that case instead (deviation D-24). Form-level outcomes are steps of their own: an expired interaction
// (410), a timed pause (429) and the access gate (a 403 that is not one of the BFF's or auth host's own refusals:
// the network gate in front of admin.<DOMAIN>, OQ-02, DI-04).
import { ApiProblem } from '@/lib/api/problem';
import type { MessageKey } from '@/lib/i18n/keys';

/** The pause when a 429 names no delay. */
export const DEFAULT_LOCK_MS = 15 * 60_000;

export type AuthOutcome =
  { kind: 'expired' } | { kind: 'locked'; retryAfterMs: number } | { kind: 'gate' } | { kind: 'message'; message: MessageKey };

/** 403 answers the console itself gives (BFF proxy, auth host), as opposed to the network gate. */
const OWN_403 = new Set(['CSRF_FAILED', 'ATTESTATION_REQUIRED', 'FORBIDDEN']);

/**
 * The outcome of a failed sign-in call. `credentials` is the message for 401 INVALID_CREDENTIALS and 422 CODE_INVALID
 * in this step (e.g. "The email or password is not correct").
 */
export function authOutcome(err: unknown, credentials: MessageKey = 'admin.signin.errors.generic'): AuthOutcome {
  if (!(err instanceof ApiProblem)) return { kind: 'message', message: 'admin.signin.errors.generic' };
  if (err.status === 410 || err.code === 'LINK_EXPIRED' || err.code === 'LINK_USED') return { kind: 'expired' };
  if (err.status === 429 || err.code === 'RATE_LIMITED' || err.code === 'PAUSED')
    return { kind: 'locked', retryAfterMs: err.retryAfterMs ?? DEFAULT_LOCK_MS };
  if (err.status === 403 && !OWN_403.has(err.code)) return { kind: 'gate' };
  if (err.code === 'NETWORK' || err.status === 502 || err.status === 503 || err.status === 504)
    return { kind: 'message', message: 'admin.signin.errors.network' };
  if (err.code === 'PASSKEY_NOT_DEVICE_BOUND') return { kind: 'message', message: 'admin.signin.errors.notDeviceBound' };
  if (err.code === 'INVALID_CREDENTIALS' || err.code === 'CODE_INVALID') return { kind: 'message', message: credentials };
  if (err.code === 'VALIDATION_FAILED') return { kind: 'message', message: credentials };
  return { kind: 'message', message: 'admin.signin.errors.generic' };
}

/** The ?signin= outcomes of /bff/oauth/callback (src/server/bff/oauth/flow.ts SigninOutcome). */
export const SIGNIN_OUTCOMES = ['expired', 'state', 'issuer', 'cancelled', 'failed', 'step_up', 'account', 'not_staff'] as const;
export type SigninOutcome = (typeof SIGNIN_OUTCOMES)[number];

export function isSigninOutcome(value: unknown): value is SigninOutcome {
  return typeof value === 'string' && (SIGNIN_OUTCOMES as readonly string[]).includes(value);
}

export function outcomeMessage(outcome: SigninOutcome): MessageKey {
  return `admin.signin.outcome.${outcome}`;
}
