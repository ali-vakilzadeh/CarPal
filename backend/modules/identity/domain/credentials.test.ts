import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  constantTimeEqual,
  hotp,
  isBreachedPassword,
  leadingZeroBits,
  newOtpCode,
  newRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUri,
  pkceMatches,
  solvePow,
  totpStep,
  verifyTotp,
} from './credentials.js';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"), last 6 digits of the 8-digit values.
const SEED = Buffer.from('12345678901234567890');
const RFC6238: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it('matches the RFC test vectors', () => {
    for (const [t, code] of RFC6238) expect(hotp(SEED, Math.floor(t / 30))).toBe(code);
  });

  it('accepts ±1 step, refuses replays of a used step and anything further away', () => {
    const now = 1_234_567_890_000;
    const step = totpStep(now);
    expect(verifyTotp(SEED, hotp(SEED, step), null, now)).toBe(step);
    expect(verifyTotp(SEED, hotp(SEED, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 2), null, now)).toBeNull();
    expect(verifyTotp(SEED, hotp(SEED, step), step, now)).toBeNull();
    expect(verifyTotp(SEED, hotp(SEED, step + 1), step, now)).toBe(step + 1);
  });

  it('base32 round-trips and builds an otpauth URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const uri = otpauthUri(SEED, 'sara@example.com');
    expect(uri).toBe(
      'otpauth://totp/CarPal:sara%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=CarPal&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('codes', () => {
  it('one-time codes are 6 digits; recovery codes are ten distinct xxxxx-xxxxx', () => {
    for (let i = 0; i < 50; i++) expect(newOtpCode()).toMatch(/^\d{6}$/);
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(normalizeRecoveryCode(' ABCDE-fghij ')).toBe('abcdefghij');
    expect(constantTimeEqual('123456', '123456')).toBe(true);
    expect(constantTimeEqual('123456', '1234567')).toBe(false);
  });
});

describe('PKCE S256 (RFC 7636 Appendix B)', () => {
  it('matches the RFC example and refuses malformed verifiers', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN')).toBe(false);
    expect(pkceMatches('short', 'x')).toBe(false);
  });
});

describe('proof of work', () => {
  it('counts leading zero bits; a solution meets the difficulty', () => {
    const nonce = solvePow('prefix-1234567890', 10);
    expect(leadingZeroBits('prefix-1234567890', nonce)).toBeGreaterThanOrEqual(10);
  });
});

describe('password policy (SEC-AU-7)', () => {
  it('refuses well-known and trivial passwords, accepts passphrases', () => {
    for (const p of ['password1234', 'Password1234', '123456789012', 'aaaaaaaaaaaa', 'qwertyuiop12'])
      expect(isBreachedPassword(p), p).toBe(true);
    for (const p of ['correct horse battery staple', 'ماشین من سفید است', 'xK9#mQ2$vL7!']) expect(isBreachedPassword(p), p).toBe(false);
  });
});
