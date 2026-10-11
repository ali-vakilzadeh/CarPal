import { describe, expect, it } from 'vitest';
import { CryptoServices, EnvelopeCipher, ID_PATTERN, PasswordHasher, uuidv7, uuidv7Time } from './index.js';

const crypto = new CryptoServices('test-master-secret-0123456789-abcdefghij');

describe('uuidv7', () => {
  it('is a canonical v7 id, time-ordered and monotonic within a millisecond', () => {
    const now = Date.UTC(2026, 9, 10);
    const ids = Array.from({ length: 50 }, () => uuidv7(now));
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
    expect(ids[0]!.charAt(14)).toBe('7');
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Time(ids[0]!)).toBe(now);
  });
});

describe('key ring', () => {
  it('derives stable, purpose-separated keys', () => {
    const other = new CryptoServices('test-master-secret-0123456789-abcdefghij');
    expect(other.keys.hmacKey('link-token').equals(crypto.keys.hmacKey('link-token'))).toBe(true);
    expect(crypto.keys.hmacKey('link-token').equals(crypto.keys.hmacKey('otp'))).toBe(false);
    const a = crypto.keys.ed25519('jwt-1').publicKey.export({ format: 'jwk' });
    const b = other.keys.ed25519('jwt-1').publicKey.export({ format: 'jwk' });
    expect(a).toEqual(b);
    expect(a.crv).toBe('Ed25519');
  });
});

describe('envelope encryption', () => {
  it('round-trips, binds the AAD and rejects tampering', () => {
    const blob = crypto.envelope.encrypt('WVWZZZ1JZXW000001', 'vehicle.vin:1');
    expect(crypto.envelope.decryptString(blob, 'vehicle.vin:1')).toBe('WVWZZZ1JZXW000001');
    expect(() => crypto.envelope.decrypt(blob, 'vehicle.vin:2')).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => crypto.envelope.decrypt(tampered, 'vehicle.vin:1')).toThrow();
    expect(() => crypto.envelope.decrypt(blob.subarray(0, 20))).toThrow(/truncated/);
  });

  it('keeps old KEKs readable after rotation', () => {
    const old = EnvelopeCipher.fromKeyRing(crypto.keys, 'k1').encrypt('x');
    const rotated = EnvelopeCipher.fromKeyRing(crypto.keys, 'k2');
    expect(rotated.decryptString(old)).toBe('x');
    expect(EnvelopeCipher.kekIdOf(rotated.encrypt('y'))).toBe('k2');
  });
});

describe('hmac', () => {
  it('verifies in constant time', () => {
    const d = crypto.hmac.digest('link-token', 'cp_ev_abc');
    expect(d).toHaveLength(32);
    expect(crypto.hmac.verify('link-token', 'cp_ev_abc', d)).toBe(true);
    expect(crypto.hmac.verify('link-token', 'cp_ev_abd', d)).toBe(false);
    expect(crypto.hmac.verify('otp', 'cp_ev_abc', d)).toBe(false);
  });
});

describe('passwords (Argon2id)', () => {
  // Cheap parameters keep the unit test fast; SEC-AU-7 parameters are the default.
  const hasher = new PasswordHasher(crypto.keys.pepper(), { memoryKiB: 1024, passes: 1, parallelism: 1 });

  it('hashes to a PHC string and verifies', async () => {
    const phc = await hasher.hash('correct horse battery staple');
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await hasher.verify('correct horse battery staple', phc)).toBe(true);
    expect(await hasher.verify('correct horse battery stapl', phc)).toBe(false);
    expect(await hasher.verify('x', 'garbage')).toBe(false);
  });

  it('depends on the pepper and flags weak parameters', async () => {
    const phc = await hasher.hash('pw-123456789012');
    const otherPepper = new PasswordHasher(Buffer.alloc(32, 1), { memoryKiB: 1024, passes: 1, parallelism: 1 });
    expect(await otherPepper.verify('pw-123456789012', phc)).toBe(false);
    expect(crypto.passwords.needsRehash(phc)).toBe(true);
  });
});

describe('cursor signing', () => {
  it('binds the principal and query, expires after 15 minutes and detects tampering', () => {
    const now = Date.now();
    const c = crypto.cursors.sign('user:1', 'vehicles.list?status=active', { after: 'abc' }, now);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(crypto.cursors.verify(c, 'user:1', 'vehicles.list?status=active', now)).toEqual({ ok: true, position: { after: 'abc' } });
    expect(crypto.cursors.verify(c, 'user:2', 'vehicles.list?status=active', now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(crypto.cursors.verify(c, 'user:1', 'vehicles.list?status=sold', now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(crypto.cursors.verify(c, 'user:1', 'vehicles.list?status=active', now + 16 * 60_000)).toEqual({ ok: false, reason: 'expired' });
    const flipped = (c[5] === 'A' ? 'B' : 'A') + c.slice(1);
    expect(crypto.cursors.verify(flipped, 'user:1', 'vehicles.list?status=active', now).ok).toBe(false);
    expect(crypto.cursors.verify('not a cursor', 'user:1', 'q', now)).toEqual({ ok: false, reason: 'malformed' });
  });
});
