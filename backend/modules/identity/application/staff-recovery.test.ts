// Backend S16b: the pure parts of the staff account recovery (status a reader sees, handle hashing, rate-limit bucket).
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUCKETS } from '#libs/rate-limit/index.js';
import { effectiveStatus, handleHashOf, RECOVERY_RESTRICTION_MS, RECOVERY_TTL_MS } from './staff-recovery.js';

const at = (ms: number) => new Date(ms);

describe('staff recovery (S16b, DQ-04)', () => {
  it('an open request past its deadline reads as expired; closed ones keep their status', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    for (const status of ['awaiting_email_code', 'awaiting_approvals', 'approved']) {
      expect(effectiveStatus({ status, expires_at: at(now + 1) }, now)).toBe(status);
      expect(effectiveStatus({ status, expires_at: at(now) }, now)).toBe('expired');
    }
    for (const status of ['rejected', 'expired', 'completed'])
      expect(effectiveStatus({ status, expires_at: at(now - RECOVERY_TTL_MS) }, now)).toBe(status);
  });

  it('stores the handle as a SHA-256 hex digest', () => {
    const h = handleHashOf('A'.repeat(43));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(handleHashOf('A'.repeat(43))).toBe(h);
    expect(handleHashOf('B'.repeat(43))).not.toBe(h);
  });

  it('keeps the owner-decided windows: 24 hours to live, 72 hours of restriction', () => {
    expect(RECOVERY_TTL_MS).toBe(24 * 3_600_000);
    expect(RECOVERY_RESTRICTION_MS).toBe(72 * 3_600_000);
  });

  it('limits recovery requests per account and per IP prefix (40 §2.8 auth.recovery)', () => {
    expect(DEFAULT_BUCKETS['auth.recovery']).toEqual([
      { limit: 3, windowMs: 3_600_000, scope: 'account' },
      { limit: 5, windowMs: 86_400_000, scope: 'account' },
      { limit: 10, windowMs: 3_600_000, scope: 'ip' },
    ]);
  });
});
