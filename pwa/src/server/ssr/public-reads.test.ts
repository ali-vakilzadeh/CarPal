// The public-read cache (P5, DI-26): one backend call per key and TTL, 404/410 as results, other failures retried.
import { describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { ReadCache, missingOf } from './public-reads';

describe('ReadCache', () => {
  it('shares one call per key within the TTL and reloads after it', async () => {
    let now = 0;
    const cache = new ReadCache(60_000, () => now);
    const load = vi.fn(async () => 'profile');
    await expect(Promise.all([cache.get('k', load), cache.get('k', load)])).resolves.toEqual([
      { ok: true, data: 'profile' },
      { ok: true, data: 'profile' },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 60_001;
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.calls).toBe(2);
  });

  it('turns 404 and 410 into results and keeps them for the TTL', async () => {
    const cache = new ReadCache();
    const load = vi.fn(async () => {
      throw new ApiProblem(404, { code: 'NOT_FOUND' });
    });
    await expect(cache.get('a', load)).resolves.toEqual({ ok: false, missing: 'not_found' });
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.get('b', async () => Promise.reject(new ApiProblem(410, { code: 'GONE' })))).resolves.toEqual({
      ok: false,
      missing: 'gone',
    });
  });

  it('forgets other failures at once so the next request retries', async () => {
    const cache = new ReadCache();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ApiProblem(503, { code: 'UNAVAILABLE' }))
      .mockResolvedValueOnce('ok');
    await expect(cache.get('k', load)).rejects.toBeInstanceOf(ApiProblem);
    await expect(cache.get('k', load)).resolves.toEqual({ ok: true, data: 'ok' });
  });

  it('maps only 404 and 410', () => {
    expect(missingOf(new ApiProblem(404, { code: 'NOT_FOUND' }))).toBe('not_found');
    expect(missingOf(new ApiProblem(500, { code: 'INTERNAL' }))).toBeNull();
    expect(missingOf(new Error('x'))).toBeNull();
  });
});
