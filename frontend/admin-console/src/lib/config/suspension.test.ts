// AC10.T0 unit test of suspension durations (BR-07): a fixed end, or none for "until reactivated".
import { describe, expect, it } from 'vitest';
import { isSuspendDuration, suspendUntil } from './suspension';

describe('suspendUntil', () => {
  const now = Date.parse('2026-11-18T10:15:42.123Z');
  it('adds whole days and drops seconds; "until reactivated" has no end', () => {
    expect(suspendUntil('1d', now)).toBe('2026-11-19T10:15:00.000Z');
    expect(suspendUntil('30d', now)).toBe('2026-12-18T10:15:00.000Z');
    expect(suspendUntil('until_reactivated', now)).toBeNull();
  });
  it('accepts only the listed durations', () => {
    expect(isSuspendDuration('7d')).toBe(true);
    expect(isSuspendDuration('2d')).toBe(false);
  });
});
