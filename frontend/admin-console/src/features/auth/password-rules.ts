// New staff passwords in the sign-in (AC14b.T2 first-sign-in change; AC10b recovery with a forgotten password): the
// client checks of SEC-AU-7 that it can make before sending (12-128 characters, typed twice the same), a strength hint
// from length and character variety only (no dictionary, no dependency), and the server's field errors on
// /new_password mapped to what the person can fix: `pattern` = a password known from breaches, `not_unique` = the
// initial password again (backend auth-ops.ts PasswordSetInitialHandler), a length code = too short or too long.
import { ApiProblem } from '@/lib/api/problem';
import type { MessageKey } from '@/lib/i18n/keys';

export const NEW_PASSWORD_MIN = 12;
export const NEW_PASSWORD_MAX = 128;

export type NewPasswordProblem = 'length' | 'repeat';

/** What is wrong with a new password typed twice, before it is sent; null when it can be sent. */
export function newPasswordProblem(password: string, repeat: string): NewPasswordProblem | null {
  if (password.length < NEW_PASSWORD_MIN || password.length > NEW_PASSWORD_MAX) return 'length';
  if (password !== repeat) return 'repeat';
  return null;
}

export type PasswordStrength = 'short' | 'fair' | 'good' | 'strong';

/** A hint only: the server decides. Length counts most (a passphrase of several words is best). */
export function passwordStrength(password: string): PasswordStrength {
  const n = [...password].length;
  if (n < NEW_PASSWORD_MIN) return 'short';
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter((re) => re.test(password)).length;
  if (n >= 20 || (n >= 16 && kinds >= 3)) return 'strong';
  if (n >= 14 || kinds >= 3) return 'good';
  return 'fair';
}

/** The server's refusal of a new password (422 VALIDATION_FAILED at /new_password), or null for any other error. */
export function newPasswordRefusal(err: unknown): MessageKey | null {
  if (!(err instanceof ApiProblem) || err.code !== 'VALIDATION_FAILED') return null;
  const field = err.field('/new_password');
  if (!field) return null;
  if (field.code === 'pattern') return 'admin.signin.initial.errors.breached';
  if (field.code === 'not_unique') return 'admin.signin.initial.errors.same';
  return 'admin.signin.initial.errors.length';
}
