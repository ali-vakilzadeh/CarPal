import { describe, expect, it } from 'vitest';
import { operationById } from '#libs/contract/index.js';
import { MemoryKeyValueStore } from '#libs/infra/index.js';
import { defaultBucket, LoadShedder, RateLimiter, routeBuckets, shedPriority, ShedPriority, type RateSubject } from './index.js';

const user: RateSubject = { kind: 'user', id: 'u1', ipPrefix: '10.0.0.0/24' };
const anon: RateSubject = { kind: 'anonymous', id: 'k1', ipPrefix: '10.0.0.0/24' };
const route = (opId: string) => operationById(opId).routes[0]!;

describe('buckets (40 §2.8)', () => {
  it('picks the default bucket of the tag plus RL(...) buckets', () => {
    expect(routeBuckets(route('config.client'), anon)).toEqual(['public.read']);
    expect(routeBuckets(route('config.client'), user)).toEqual(['default.read', 'public.read']);
    expect(routeBuckets(route('reports.create'), user)).toEqual(['default.write', 'report.create']);
    expect(defaultBucket(route('admin.users_search'), { kind: 'staff', id: 's', ipPrefix: 'x' })).toBe('admin.default');
  });
});

describe('RateLimiter', () => {
  it('limits per caller, reports RateLimit headers and the retry delay', async () => {
    const rl = new RateLimiter({
      kv: new MemoryKeyValueStore(),
      overridesJson: '{"report.create":[{"limit":2,"windowMs":86400000,"scope":"user"}]}',
    });
    const d = await rl.check(['report.create'], user);
    expect(d.headers).toEqual({
      'ratelimit-policy': '"report.create";q=2;w=86400',
      ratelimit: expect.stringMatching(/^"report.create";r=1;t=\d+$/),
    });
    await rl.check(['report.create'], user);
    await expect(rl.check(['report.create'], user)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: expect.any(Number) });
    await expect(rl.check(['report.create'], { ...user, id: 'u2' })).resolves.toBeTruthy();
  });

  it('applies organization windows only in the org phase (after authorization)', async () => {
    const rl = new RateLimiter({
      kv: new MemoryKeyValueStore(),
      overridesJson: '{"geo.business":[{"limit":1,"windowMs":3600000,"scope":"org"}]}',
    });
    for (let i = 0; i < 3; i++) await rl.check(['geo.business'], { ...user, orgId: 'victim' }, 'caller');
    await rl.check(['geo.business'], { ...user, orgId: 'o1' }, 'org');
    await expect(rl.check(['geo.business'], { ...user, id: 'u9', orgId: 'o1' }, 'org')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('consumes request-dependent scopes from the use case and escalates repeated abuse to a block', async () => {
    let escalated = '';
    const rl = new RateLimiter({ kv: new MemoryKeyValueStore(), escalateAfter: 3, onEscalation: (k) => (escalated = k) });
    for (let i = 0; i < 5; i++) await rl.consume('auth.signin', 'account', 'a@b.c');
    await expect(rl.consume('auth.signin', 'account', 'a@b.c')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(rl.consume('auth.signin', 'account', 'a@b.c')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(rl.consume('auth.signin', 'account', 'a@b.c')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(escalated).toBe('account:a@b.c');
    await expect(rl.consume('auth.signin', 'account', 'a@b.c')).rejects.toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(() => new RateLimiter({ kv: new MemoryKeyValueStore(), overridesJson: '{"x":[{"limit":0}]}' })).toThrow(/invalid bucket/);
  });

  it('scales every quota (tests raise limits)', () => {
    const rl = new RateLimiter({ kv: new MemoryKeyValueStore(), scale: 10 });
    expect(rl.buckets['default.write']![0]!.limit).toBe(600);
  });
});

describe('LoadShedder (SEC-RL-2)', () => {
  it('sheds analytics and AI first, critical operations last', () => {
    expect(shedPriority('events.ingest', 'POST')).toBe(ShedPriority.AnalyticsAndAi);
    expect(shedPriority('search.providers', 'POST')).toBe(ShedPriority.SearchAndMap);
    expect(shedPriority('vehicles.list', 'GET')).toBe(ShedPriority.Read);
    expect(shedPriority('vehicles.create', 'POST')).toBe(ShedPriority.Write);
    expect(shedPriority('auth.token', 'POST')).toBe(ShedPriority.Critical);
    const s = new LoadShedder(10);
    const held = Array.from({ length: 5 }, () => s.enter(ShedPriority.Read));
    expect(() => s.enter(ShedPriority.AnalyticsAndAi)).toThrow(expect.objectContaining({ code: 'OVERLOADED' }));
    expect(() => s.enter(ShedPriority.Critical)).not.toThrow();
    held.forEach((r) => r());
    held[0]!(); // releasing twice is harmless
    expect(s.inflight).toBe(1);
  });
});
