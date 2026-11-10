// Exchange rate rules of the console (AC6.T1, Docs/40 §23.5 admin.exchange_rate_update, GD-41): a rate is a decimal
// amount of the display currency per US dollar (Dec<14,4>, > 0). A change of more than 20 % waits for a second
// platform admin (the server decides, rateNeedsSecondApprover in backend/modules/admin/application/platform-ops.ts;
// the console only warns before sending). Persian digits and separators typed by staff are accepted.
import { toLatinDigits } from '@/lib/format';

/** Dec<14,4>: up to 10 digits before the point and 4 after. */
const DECIMAL = /^\d{1,10}(\.\d{1,4})?$/;

/** The four-eyes threshold of the contract ("change over 20 %"). */
export const FOUR_EYES_RATIO = 0.2;

export type RateProblem = 'empty' | 'format' | 'zero' | 'same';

/** A typed rate as the contract's decimal string, or the problem with it. */
export function parseRate(input: string, current?: string): { value: string } | { problem: RateProblem } {
  const s = toLatinDigits(input)
    .trim()
    .replace(/[\s,٬،_']/g, '')
    .replace(/٫/g, '.');
  if (!s) return { problem: 'empty' };
  if (!DECIMAL.test(s)) return { problem: 'format' };
  if (!(Number(s) > 0)) return { problem: 'zero' };
  if (current !== undefined && Number(s) === Number(current)) return { problem: 'same' };
  return { value: s };
}

/** Relative change from the current rate (0.05 = 5 %). */
export function changeRatio(current: string, next: string): number {
  const c = Number(current);
  return c > 0 ? (Number(next) - c) / c : Infinity;
}

/** Same rule as the server: |next − current| / current > 20 %. */
export function needsSecondApprover(current: string, next: string): boolean {
  return Math.abs(changeRatio(current, next)) > FOUR_EYES_RATIO;
}

/** US dollar amounts the preview converts (a small service and a typical repair). */
export const SAMPLE_USD = [1, 25] as const;
