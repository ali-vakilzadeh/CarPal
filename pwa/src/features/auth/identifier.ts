// "Mobile number or email" (Docs/21 S-AUTH-02): one field that detects which it is. Phones become E.164 with the
// region's country code when typed nationally ("0912 345 4567" or "912 345 4567" → +989123454567); Persian and
// Arabic digits are accepted. Texts go only to the region's SMS country codes (the auth host answers 422 'enum'
// otherwise, BA-13), so the form says so before sending.
import { toLatinDigits } from '@/lib/format';

export type Identifier =
  { kind: 'email'; value: string } | { kind: 'phone'; value: string; smsAllowed: boolean } | { kind: 'invalid' } | { kind: 'empty' };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** A phone number in E.164, or null. `countryCodes` are the region's SMS codes ("+98"); the first is the default. */
export function normalizePhone(raw: string, countryCodes: readonly string[]): string | null {
  let s = toLatinDigits(raw.trim()).replace(/[\s\-().\p{Cf}]/gu, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (!/^\d+$/.test(s)) return null;
    const code = countryCodes[0] ?? '+98';
    s = `${code}${s.replace(/^0/, '')}`;
  }
  return E164.test(s) ? s : null;
}

export function smsAllowed(phone: string, countryCodes: readonly string[]): boolean {
  return countryCodes.some((c) => phone.startsWith(c));
}

export function parseIdentifier(raw: string, countryCodes: readonly string[]): Identifier {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };
  if (value.includes('@')) return isEmail(value) ? { kind: 'email', value } : { kind: 'invalid' };
  const phone = normalizePhone(value, countryCodes);
  return phone ? { kind: 'phone', value: phone, smsAllowed: smsAllowed(phone, countryCodes) } : { kind: 'invalid' };
}

/** "+98 912 *** 4567" / "s***@example.com": enough to recognise the destination, not to read it off a screen. */
export function maskDestination(value: string, countryCodes: readonly string[] = []): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  const code = countryCodes.find((c) => value.startsWith(c)) ?? value.slice(0, 3);
  const national = value.slice(code.length);
  if (national.length < 7) return `${code} ***`;
  return `${code} ${national.slice(0, 3)} *** ${national.slice(-4)}`;
}
