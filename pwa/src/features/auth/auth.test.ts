// P4.T2/T3 helpers of the hosted sign-in: identifier detection and phone normalisation, masking, password advice,
// and the enumeration-safe mapping of auth errors.
import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api/problem';
import { maskDestination, normalizePhone, parseIdentifier } from './identifier';
import { checkPassword, passwordError } from './password';
import { authOutcome, DEFAULT_LOCK_MS } from './problems';

const IR = ['+98'];

describe('identifier', () => {
  it.each([
    ['sara@example.com', { kind: 'email', value: 'sara@example.com' }],
    ['  sara@example.com ', { kind: 'email', value: 'sara@example.com' }],
    ['0912 345 4567', { kind: 'phone', value: '+989123454567', smsAllowed: true }],
    ['912-345-4567', { kind: 'phone', value: '+989123454567', smsAllowed: true }],
    ['۰۹۱۲۳۴۵۴۵۶۷', { kind: 'phone', value: '+989123454567', smsAllowed: true }],
    ['+98 (912) 345 4567', { kind: 'phone', value: '+989123454567', smsAllowed: true }],
    ['0049 30 1234567', { kind: 'phone', value: '+49301234567', smsAllowed: false }],
    ['sara@', { kind: 'invalid' }],
    ['12', { kind: 'invalid' }],
    ['abc', { kind: 'invalid' }],
    ['', { kind: 'empty' }],
  ])('%s', (input, expected) => {
    expect(parseIdentifier(input, IR)).toEqual(expected);
  });

  it('normalises with the first region code and rejects non-E.164 numbers', () => {
    expect(normalizePhone('9123454567', ['+98', '+971'])).toBe('+989123454567');
    expect(normalizePhone('+0123', IR)).toBeNull();
  });

  it('masks destinations enough to recognise, not to read', () => {
    expect(maskDestination('+989123454567', IR)).toBe('+98 912 *** 4567');
    expect(maskDestination('sara@example.com')).toBe('s***@example.com');
    expect(maskDestination('+98123', IR)).toBe('+98 ***');
  });
});

describe('password advice', () => {
  it('scores length and mix, and refuses the account contacts', () => {
    expect(checkPassword('').score).toBe(0);
    expect(checkPassword('short1').label).toBe('auth.password.weak');
    expect(checkPassword('silver-e90-2012').score).toBe(3);
    expect(checkPassword('silver-e90-2012-winter').label).toBe('auth.password.strong');
    const own = checkPassword('sara.m-2026-garage', ['sara.m@example.com']);
    expect(own.rules.notContact).toBe(false);
    expect(own.score).toBe(1);
    expect(checkPassword('call-me-9123454567', ['+989123454567']).rules.notContact).toBe(false);
  });

  it('length errors; an empty optional password is fine', () => {
    expect(passwordError('', false)).toBeNull();
    expect(passwordError('', true)).toBe('auth.password.tooShort');
    expect(passwordError('a'.repeat(11), false)).toBe('auth.password.tooShort');
    expect(passwordError('a'.repeat(129), false)).toBe('auth.password.tooLong');
    expect(passwordError('a'.repeat(12), true)).toBeNull();
  });
});

describe('auth outcomes (enumeration-safe, BA-13)', () => {
  const problem = (status: number, body: Record<string, unknown>, retryAfterMs?: number) =>
    new ApiProblem(status, body, retryAfterMs ? { retryAfterMs } : {});

  it('maps interaction expiry, locks, credentials and network trouble', () => {
    expect(authOutcome(problem(410, { code: 'LINK_EXPIRED' }))).toEqual({ kind: 'expired' });
    expect(authOutcome(problem(429, { code: 'RATE_LIMITED' }, 90_000))).toEqual({ kind: 'locked', retryAfterMs: 90_000 });
    expect(authOutcome(problem(429, { code: 'RATE_LIMITED' }))).toEqual({ kind: 'locked', retryAfterMs: DEFAULT_LOCK_MS });
    expect(authOutcome(problem(401, { code: 'INVALID_CREDENTIALS' }), 'auth.signin.invalid')).toEqual({
      kind: 'message',
      message: 'auth.signin.invalid',
    });
    expect(authOutcome(problem(422, { code: 'CODE_INVALID' }), 'auth.code.wrong')).toEqual({ kind: 'message', message: 'auth.code.wrong' });
    expect(authOutcome(problem(0, { code: 'NETWORK' }))).toEqual({ kind: 'message', message: 'auth.errors.network' });
    expect(authOutcome(new Error('x'))).toEqual({ kind: 'message', message: 'auth.errors.generic' });
  });

  it('maps field errors: breached password, out-of-region SMS, email', () => {
    const v = (errors: { pointer: string; code: string }[]) => problem(422, { code: 'VALIDATION_FAILED', errors });
    expect(authOutcome(v([{ pointer: '/password', code: 'pattern' }]))).toEqual({
      kind: 'fields',
      fields: { '/password': 'auth.password.breached' },
      message: 'auth.password.breached',
    });
    expect(authOutcome(v([{ pointer: '/new_password', code: 'pattern' }]))).toMatchObject({ message: 'auth.password.breached' });
    expect(authOutcome(v([{ pointer: '/destination', code: 'enum' }]))).toMatchObject({ message: 'auth.errors.smsCountry' });
    expect(
      authOutcome(
        v([
          { pointer: '/phone', code: 'enum' },
          { pointer: '/email', code: 'format' },
        ]),
      ),
    ).toEqual({
      kind: 'fields',
      fields: { '/phone': 'auth.errors.smsCountry', '/email': 'auth.errors.email' },
      message: 'auth.errors.check',
    });
  });
});
