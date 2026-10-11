import { describe, expect, it } from 'vitest';
import { assertUpdated, assertVersion, formatEtag, parseIfMatch } from '#libs/concurrency/index.js';
import { IdempotencyStore, requestHash } from '#libs/idempotency/index.js';
import { MemoryKeyValueStore } from '#libs/infra/index.js';
import { toJobView, type JobRow } from '#libs/jobs/index.js';
import type { TxRunner } from '#libs/tenancy/index.js';
import { FlagService } from './index.js';

type Row = { key: string; flag_type: string; enabled: boolean; targeting: unknown };
const fakeTx = (rows: Row[], counter = { n: 0 }) =>
  ({
    run: async (_ctx: unknown, fn: (s: unknown) => unknown) => {
      counter.n++;
      const chain = { select: () => chain, where: () => chain, execute: async () => rows };
      return fn({ db: { selectFrom: () => chain } });
    },
  }) as unknown as TxRunner;

describe('FlagService (L14)', () => {
  const rows: Row[] = [
    { key: 'ai.automation.kill_switch', flag_type: 'kill_switch', enabled: false, targeting: null },
    { key: 'ai.triage.enabled', flag_type: 'ai_feature', enabled: true, targeting: null },
    { key: 'map.enabled', flag_type: 'release', enabled: true, targeting: null },
    { key: 'qna.enabled', flag_type: 'release', enabled: false, targeting: null },
    { key: 'beta.fleet', flag_type: 'beta', enabled: true, targeting: { roles: ['fleet_owner'], percentage: 100 } },
    { key: 'beta.half', flag_type: 'beta', enabled: true, targeting: { percentage: 50 } },
  ];

  it('evaluates flags, targeting and the AI kill switch', async () => {
    const flags = new FlagService(fakeTx(rows), 'dev', 60_000);
    expect(await flags.isEnabled('ai.triage.enabled')).toBe(true);
    expect(await flags.isEnabled('unknown.flag')).toBe(false);
    expect(await flags.isEnabled('beta.fleet', { roles: ['fleet_driver'] })).toBe(false);
    expect(await flags.isEnabled('beta.fleet', { roles: ['fleet_owner'], userId: 'u' })).toBe(true);
    const half = await Promise.all(Array.from({ length: 200 }, (_, i) => flags.isEnabled('beta.half', { userId: `user-${i}` })));
    expect(half.filter(Boolean).length).toBeGreaterThan(60);
    expect(half.filter(Boolean).length).toBeLessThan(140);
    await expect(flags.require('qna.enabled')).rejects.toMatchObject({ code: 'FEATURE_DISABLED', status: 403 });

    const killed = new FlagService(
      fakeTx(rows.map((r) => (r.key === 'ai.automation.kill_switch' ? { ...r, enabled: true } : r))),
      'dev',
      60_000,
    );
    await expect(killed.require('ai.triage.enabled')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', status: 503, retryAfterMs: 60_000 });
    expect(await killed.isEnabled('map.enabled')).toBe(true);
    expect((await killed.evaluateAll()).find((f) => f.key === 'ai.triage.enabled')).toEqual({ key: 'ai.triage.enabled', enabled: false });
  });

  it('caches for the refresh interval and reloads after invalidate()', async () => {
    const counter = { n: 0 };
    const flags = new FlagService(fakeTx(rows, counter), 'dev', 60_000);
    await Promise.all([flags.isEnabled('map.enabled'), flags.isEnabled('qna.enabled')]);
    await flags.isEnabled('map.enabled');
    expect(counter.n).toBe(1);
    flags.invalidate();
    await flags.isEnabled('map.enabled');
    expect(counter.n).toBe(2);
  });
});

describe('IdempotencyStore (L6)', () => {
  it('locks, replays, detects reuse and releases after server errors', async () => {
    const store = new IdempotencyStore(new MemoryKeyValueStore());
    const h1 = requestHash('POST', '/v1/reports', '', Buffer.from('{"a":1}'));
    const h2 = requestHash('POST', '/v1/reports', '', Buffer.from('{"a":2}'));
    expect(requestHash('POST', '/v1/jobs/a/cancel', '', Buffer.alloc(0))).not.toBe(
      requestHash('POST', '/v1/jobs/b/cancel', '', Buffer.alloc(0)),
    );
    const first = await store.begin('u:1', 'reports.create', 'k', h1);
    expect(first.kind).toBe('new');
    await expect(store.begin('u:1', 'reports.create', 'k', h1)).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    await expect(store.begin('u:1', 'reports.create', 'k', h2)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await store.complete((first as { slot: string }).slot, h1, { status: 201, headers: {}, body: { ok: 1 } });
    expect(await store.begin('u:1', 'reports.create', 'k', h1)).toEqual({
      kind: 'replay',
      response: { status: 201, headers: {}, body: { ok: 1 } },
    });
    expect((await store.begin('u:2', 'reports.create', 'k', h1)).kind).toBe('new');
    const crashed = await store.begin('u:3', 'reports.create', 'k', h1);
    await store.abandon((crashed as { slot: string }).slot);
    expect((await store.begin('u:3', 'reports.create', 'k', h1)).kind).toBe('new');
    expect(() => IdempotencyStore.parseKey(undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => IdempotencyStore.parseKey('0190b2d4-7a1c-1c3e-9f00-123456789abc')).toThrow(
      expect.objectContaining({ code: 'MALFORMED_REQUEST' }),
    );
  });
});

describe('concurrency (L7)', () => {
  it('parses If-Match and compares versions', () => {
    expect(formatEtag(7)).toBe('"v7"');
    expect(parseIfMatch('"v7"', true)).toBe(7);
    expect(parseIfMatch(undefined, false)).toBeUndefined();
    expect(() => parseIfMatch(undefined, true)).toThrow(expect.objectContaining({ code: 'PRECONDITION_REQUIRED' }));
    for (const bad of ['v7', '"7"', 'W/"v7"', '*', '"v0"'])
      expect(() => parseIfMatch(bad, true)).toThrow(expect.objectContaining({ code: 'VERSION_MISMATCH' }));
    expect(() => assertVersion(3, 4)).toThrow(expect.objectContaining({ status: 412 }));
    expect(() => assertVersion(undefined, 4)).not.toThrow();
    expect(() => assertUpdated(0, 3)).toThrow(expect.objectContaining({ code: 'VERSION_MISMATCH' }));
    expect(() => assertUpdated(1n, 3)).not.toThrow();
  });
});

describe('jobs (L10)', () => {
  it('projects a job row to the contract Job', () => {
    const row = {
      id: '0190b2d4-7a1c-7c3e-9f00-123456789abc',
      created_at: new Date('2026-10-10T10:00:00Z'),
      updated_at: new Date('2026-10-10T10:01:00Z'),
      version: 2,
      kind: 'fleet_export',
      status: 'succeeded',
      progress: 100,
      result_type: 'fleet_export',
      result_id: '0190b2d4-7a1c-7c3e-9f00-123456789abd',
      error_code: null,
      expires_at: new Date('2026-10-17T10:00:00Z'),
    } as unknown as JobRow;
    expect(toJobView(row)).toEqual({
      id: row.id,
      created_at: '2026-10-10T10:00:00.000Z',
      updated_at: '2026-10-10T10:01:00.000Z',
      version: 2,
      kind: 'fleet_export',
      status: 'succeeded',
      progress: 100,
      result: { type: 'fleet_export', id: '0190b2d4-7a1c-7c3e-9f00-123456789abd' },
      expires_at: '2026-10-17T10:00:00.000Z',
    });
  });
});
