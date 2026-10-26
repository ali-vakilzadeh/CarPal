// Password rules shown before and while typing (Docs/21 S-AUTH-03): 12-128 characters (auth.signup Str<12,128>),
// a mix of letters and numbers or symbols, and not the account's own email or phone. The strength meter is advice;
// the auth host has the last word (a breached or trivial password is 422 'pattern', BA-13).
import type { MessageKey } from '@/lib/i18n/keys';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export interface PasswordCheck {
  /** 0 = empty, 1 weak … 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: MessageKey | null;
  rules: { length: boolean; mix: boolean; notContact: boolean };
}

const LABELS: Record<1 | 2 | 3 | 4, MessageKey> = {
  1: 'auth.password.weak',
  2: 'auth.password.fair',
  3: 'auth.password.good',
  4: 'auth.password.strong',
};

/** `contacts`: the email and phone typed in the same form. */
export function checkPassword(password: string, contacts: readonly string[] = []): PasswordCheck {
  const length = password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
  const mix = /\p{L}/u.test(password) && /[\p{N}\p{P}\p{S}]/u.test(password);
  const lower = password.toLowerCase();
  const notContact = !contacts
    .map((c) => (c.includes('@') ? c.split('@')[0]! : c.replace(/\D/g, '').slice(-7)).toLowerCase())
    .some((c) => c.length >= 4 && lower.includes(c));
  if (!password) return { score: 0, label: null, rules: { length: false, mix, notContact: true } };
  let score: 1 | 2 | 3 | 4 = password.length < PASSWORD_MIN ? 1 : password.length < 16 ? 2 : 3;
  if (length && mix && score < 4) score = (score + 1) as 2 | 3 | 4;
  if (!notContact) score = 1;
  return { score, label: LABELS[score], rules: { length, mix, notContact } };
}

/** The error to show under the field, or null (an empty optional password is fine). */
export function passwordError(password: string, required: boolean): MessageKey | null {
  if (!password) return required ? 'auth.password.tooShort' : null;
  if (password.length < PASSWORD_MIN) return 'auth.password.tooShort';
  if (password.length > PASSWORD_MAX) return 'auth.password.tooLong';
  return null;
}
