import { describe, expect, it } from 'vitest';
import { checkTimezone, withMinLatency } from './common.js';

describe('withMinLatency (SEC-AU-11)', () => {
  it('takes at least the floor on success and on failure', async () => {
    let t0 = performance.now();
    expect(await withMinLatency(60, async () => 'ok')).toBe('ok');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(58);
    t0 = performance.now();
    await expect(withMinLatency(60, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(58);
    t0 = performance.now();
    await withMinLatency(0, async () => undefined);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('checkTimezone', () => {
  it('accepts tzdb names and UTC, refuses others with a pointer', () => {
    expect(() => checkTimezone('Asia/Tehran', '/timezone')).not.toThrow();
    expect(() => checkTimezone('UTC', '/timezone')).not.toThrow();
    expect(() => checkTimezone('Mars/Olympus', '/timezone')).toThrow(
      expect.objectContaining({ errors: [{ pointer: '/timezone', code: 'enum' }] }),
    );
  });
});
