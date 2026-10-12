// VIN rules (52 §8 Vehicle.vin, 40 Vin, VIN_INVALID): the contract checks the
// format (17 characters without I, O and Q, after uppercasing and digit
// normalization). The ISO 3779 check digit (position 9) is mandatory only in
// North America (WMI 1-5) and China (L); elsewhere, including the pilot
// region, manufacturers may use position 9 freely, so it is checked only
// for those VINs. Only the last four characters are ever shown (SEC-OUT-2).

const VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
}; // prettier-ignore
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** ISO 3779 check digit of a well-formed VIN ('0'-'9' or 'X'). */
export function checkDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i]!;
    const v = c >= '0' && c <= '9' ? Number(c) : VALUES[c]!;
    sum += v * WEIGHTS[i]!;
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/** Regions where position 9 must be the check digit. */
export const checkDigitRequired = (vin: string): boolean => /^[1-5L]/.test(vin);

/** True when the VIN passes the format and, where required, the check digit (else 422 VIN_INVALID). */
export function vinValid(vin: string): boolean {
  if (!VIN_PATTERN.test(vin)) return false;
  return !checkDigitRequired(vin) || vin[8] === checkDigit(vin);
}

export const vinLast4 = (vin: string): string => vin.slice(-4);

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/**
 * Model year from position 10 (30-year cycle starting 1980 = A): the most
 * recent candidate not after next year. Null for codes outside the table.
 */
export function modelYear(vin: string, currentYear: number): number | null {
  const i = YEAR_CODES.indexOf(vin[9] ?? '');
  if (i < 0) return null;
  let year = 1980 + i;
  while (year + 30 <= currentYear + 1) year += 30;
  return year;
}
