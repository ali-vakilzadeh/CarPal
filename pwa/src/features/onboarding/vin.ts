// VIN input (BA-29, Docs/21 C-ONB-01): pasted VINs are cleaned the way the backend does it (upper case, Persian and
// Arabic digits to Latin, spaces and dashes dropped); 17 characters without I, O and Q; the ISO 3779 check digit
// (position 9) is checked only for North American (WMI 1-5) and Chinese (L) VINs, like the backend (backend DI-37).
import { toLatinDigits } from '@/lib/format';

export const VIN_LENGTH = 17;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const VALUES: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function cleanVin(raw: string): string {
  return toLatinDigits(raw)
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

function checkDigitOk(vin: string): boolean {
  const sum = [...vin].reduce((acc, c, i) => acc + (/\d/.test(c) ? Number(c) : (VALUES[c] ?? 0)) * WEIGHTS[i]!, 0);
  const expected = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === expected;
}

export type VinProblem = 'length' | 'letters' | 'invalid' | null;

/** Why a cleaned VIN cannot be sent, or null (an empty VIN is fine: it is optional). */
export function vinProblem(vin: string): VinProblem {
  if (!vin) return null;
  if (/[IOQ]/.test(vin)) return 'letters';
  if (vin.length !== VIN_LENGTH) return 'length';
  if (!VIN.test(vin)) return 'invalid';
  if (/^[1-5L]/.test(vin) && !checkDigitOk(vin)) return 'invalid';
  return null;
}
