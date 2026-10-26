// Auth errors → what the hosted sign-in shows (P4.T2/T3, BA-13). Everything stays enumeration-safe (SEC-AU-11): the
// auth host answers the same for known and unknown accounts, and so do these messages. Form-level outcomes (expired
// interaction, timed lock) are steps of their own; field errors go under their field.
import { ApiProblem } from '@/lib/api/problem';
import type { MessageKey } from '@/lib/i18n/keys';

/** The default pause when a 429 names no delay (Docs/21 S-AUTH-09: "paused for 15 minutes"). */
export const DEFAULT_LOCK_MS = 15 * 60_000;

export type AuthOutcome =
  | { kind: 'expired' }
  | { kind: 'locked'; retryAfterMs: number }
  | { kind: 'fields'; fields: Record<string, MessageKey>; message: MessageKey }
  | { kind: 'message'; message: MessageKey };

/** Field errors of a 422 VALIDATION_FAILED, by JSON pointer of the request body. */
function fieldMessage(pointer: string, code: string): MessageKey {
  if ((pointer === '/password' || pointer === '/new_password') && code === 'pattern') return 'auth.password.breached';
  if (pointer === '/password' || pointer === '/new_password')
    return code === 'too_long' ? 'auth.password.tooLong' : 'auth.password.tooShort';
  if ((pointer === '/destination' || pointer === '/phone') && code === 'enum') return 'auth.errors.smsCountry';
  if (pointer === '/email' || pointer === '/destination') return 'auth.errors.email';
  if (pointer === '/phone') return 'auth.errors.phone';
  if (pointer === '/full_name') return 'auth.errors.fullName';
  return 'auth.errors.check';
}

/**
 * The outcome of a failed auth call. `credentials` is the message for 401 INVALID_CREDENTIALS and 422 CODE_INVALID
 * in this step (e.g. "Email or password is not correct").
 */
export function authOutcome(err: unknown, credentials: MessageKey = 'auth.errors.generic'): AuthOutcome {
  if (!(err instanceof ApiProblem)) return { kind: 'message', message: 'auth.errors.generic' };
  if (err.status === 410 || err.code === 'LINK_EXPIRED' || err.code === 'LINK_USED') return { kind: 'expired' };
  if (err.status === 429 || err.code === 'RATE_LIMITED' || err.code === 'PAUSED')
    return { kind: 'locked', retryAfterMs: err.retryAfterMs ?? DEFAULT_LOCK_MS };
  if (err.code === 'NETWORK' || err.status === 502 || err.status === 503 || err.status === 504)
    return { kind: 'message', message: 'auth.errors.network' };
  if (err.code === 'INVALID_CREDENTIALS' || err.code === 'CODE_INVALID') return { kind: 'message', message: credentials };
  if (err.code === 'VALIDATION_FAILED' && err.fields.length) {
    const fields: Record<string, MessageKey> = {};
    for (const f of err.fields) fields[f.pointer] ??= fieldMessage(f.pointer, f.code);
    const first = Object.values(fields)[0]!;
    return { kind: 'fields', fields, message: Object.keys(fields).length === 1 ? first : 'auth.errors.check' };
  }
  return { kind: 'message', message: 'auth.errors.generic' };
}
