import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#libs/config/index.js';
import {
  createInfra,
  FileDeadLetterStore,
  LocalObjectStorage,
  MemoryEventBus,
  MemoryJobQueue,
  MemoryKeyValueStore,
  NotConfiguredError,
  subjectMatches,
  type EventEnvelope,
} from './index.js';

describe('MemoryKeyValueStore', () => {
  it('supports TTL, NX/XX, compare-and-delete, counters and sets', async () => {
    let now = 1_000_000;
    const kv = new MemoryKeyValueStore(() => now);
    expect(await kv.set('a', '1', { ttlMs: 100, mode: 'NX' })).toBe(true);
    expect(await kv.set('a', '2', { mode: 'NX' })).toBe(false);
    expect(await kv.set('b', '2', { mode: 'XX' })).toBe(false);
    expect(await kv.ttl('a')).toBe(100);
    now += 100;
    expect(await kv.get('a')).toBeNull();
    await kv.set('lock', 'owner-1');
    expect(await kv.compareAndDelete('lock', 'owner-2')).toBe(false);
    expect(await kv.compareAndDelete('lock', 'owner-1')).toBe(true);
    expect(await kv.incr('n', 1, 1000)).toBe(1);
    expect(await kv.incr('n', 5)).toBe(6);
    await kv.sAdd('s', 'x');
    await kv.sAdd('s', 'y');
    await kv.sRem('s', 'x');
    expect(await kv.sMembers('s')).toEqual(['y']);
    expect(await kv.delPrefix('s')).toBe(1);
    await kv.close();
  });

  it('implements a sliding window with an exact retry delay', async () => {
    const kv = new MemoryKeyValueStore();
    const t0 = 60_000 * 1000; // start of a window
    for (let i = 0; i < 5; i++) expect((await kv.slidingWindow('rl', 60_000, 5, 1, t0 + i)).allowed).toBe(true);
    const denied = await kv.slidingWindow('rl', 60_000, 5, 1, t0 + 10);
    expect(denied.allowed).toBe(false);
    // The current window alone is full: room appears once the previous-window weight decays enough after the reset.
    expect(denied.retryAfterMs).toBeGreaterThan(59_000);
    const retryAt = t0 + 10 + denied.retryAfterMs;
    expect((await kv.slidingWindow('rl', 60_000, 5, 1, retryAt - 1_000)).allowed).toBe(false);
    expect((await kv.slidingWindow('rl', 60_000, 5, 1, retryAt)).allowed).toBe(true);
    await kv.close();
  });
});

const event = (type: string, id = 'e1'): EventEnvelope => ({
  eventId: id,
  type,
  aggregateType: 'x',
  aggregateId: 'a',
  organizationId: null,
  payload: {},
  schemaVersion: 1,
  occurredAt: new Date().toISOString(),
  requestId: null,
});

describe('MemoryEventBus', () => {
  it('matches subjects like NATS', () => {
    expect(subjectMatches('review.*', 'review.published')).toBe(true);
    expect(subjectMatches('review.*', 'review.invitation.sent')).toBe(false);
    expect(subjectMatches('review.>', 'review.invitation.sent')).toBe(true);
    expect(subjectMatches('>', 'anything.at.all')).toBe(true);
  });

  it('retries with backoff and dead-letters after max_deliver', async () => {
    const dl = new FileDeadLetterStore(null);
    const bus = new MemoryEventBus(dl);
    const seen: number[] = [];
    let okCount = 0;
    bus.subscribe({
      consumer: 'flaky',
      subjects: ['a.b'],
      maxDeliver: 3,
      backoffMs: [1],
      handler: async (_e, attempt) => {
        seen.push(attempt);
        throw new Error('boom');
      },
    });
    bus.subscribe({ consumer: 'ok', subjects: ['a.*'], handler: async () => void okCount++ });
    await bus.publish(event('a.b'));
    await bus.idle();
    expect(seen).toEqual([1, 2, 3]);
    expect(okCount).toBe(1);
    expect((await dl.list('flaky'))[0]).toMatchObject({ attempts: 3, error: 'boom' });
    await bus.close();
  });
});

describe('MemoryJobQueue', () => {
  it('processes FIFO with bounded concurrency and cancels queued and running jobs', async () => {
    const q = new MemoryJobQueue();
    const done: string[] = [];
    let aborted = false;
    await q.enqueue('w', { jobId: 'slow' });
    await q.enqueue('w', { jobId: 'queued' });
    q.process('w', async (job, signal) => {
      if (job.jobId === 'slow') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        aborted = signal.aborted;
      }
      done.push(job.jobId);
    });
    await q.cancel('queued');
    await q.cancel('slow');
    await q.idle();
    expect(done).toEqual(['slow']);
    expect(aborted).toBe(true);
    await q.close();
  });
});

describe('LocalObjectStorage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carpal-storage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts only uploads that match the signed constraints and serves signed downloads', async () => {
    const storage = new LocalObjectStorage(dir, 'http://127.0.0.1:0', Buffer.alloc(32, 7));
    const server = await storage.listen(0, '127.0.0.1');
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const body = Buffer.from('hello media');
      const sha = createHash('sha256').update(body).digest('base64');
      const put = await storage.presignPut('u/1/a.txt', {
        contentType: 'text/plain',
        contentLength: body.length,
        sha256: sha,
        expiresInMs: 600_000,
      });
      const url = put.url.replace('http://127.0.0.1:0', base);
      const bad = await fetch(url, { method: 'PUT', headers: { ...put.headers, 'content-type': 'image/png' }, body });
      expect(bad.status).toBe(403);
      const ok = await fetch(url, { method: 'PUT', headers: put.headers, body });
      expect(ok.status).toBe(200);
      const get = (await storage.presignGet('u/1/a.txt', { expiresInMs: 60_000, disposition: 'attachment' })).replace(
        'http://127.0.0.1:0',
        base,
      );
      const res = await fetch(get);
      expect(await res.text()).toBe('hello media');
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await fetch(get.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
      await expect(storage.put('../escape', body, 'text/plain')).rejects.toThrow(/invalid object key/);
    } finally {
      server.close();
    }
  });
});

describe('createInfra', () => {
  it('builds lite adapters, and full skeletons that fail loudly', async () => {
    const lite = createInfra(loadConfig({ CARPAL_INFRA: 'lite' }), { dataDir: null });
    expect(lite.mode).toBe('lite');
    await lite.close();
    const fullInfra = createInfra(loadConfig({ CARPAL_INFRA: 'full' }), { dataDir: null });
    await expect(fullInfra.kv.get('x')).rejects.toBeInstanceOf(NotConfiguredError);
    expect(() => fullInfra.bus.subscribe({ consumer: 'c', subjects: ['>'], handler: async () => {} })).toThrow(NotConfiguredError);
  });
});
