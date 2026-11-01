// P13.T5 — client obligations of Docs/40 Appendix C item 6 and TR-3, against a fake HTTP server (node:http) with the
// real fetch, timers and jitter: no request repeated before the server's delay (CarPal-Retry-After-Ms, + ≤ 20 %);
// backoff without a delay; only safe and IDEM requests retried (same Idempotency-Key); CarPal-Poll-After-Ms slows
// polling; three 503s pause the operation without another request; unknown response fields and enum values are
// accepted and unknown values map to 'unknown'.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createI18n, translator } from '@/lib/i18n/core';
import { createApiClient, type ApiClient } from './client';
import { knownEnum } from './enums';
import { ApiProblem } from './problem';
import { RETRY } from './retry';

interface Hit {
  method: string;
  path: string;
  at: number;
  idem: string | null;
}
type Reply = (res: ServerResponse, req: IncomingMessage) => void;

let server: Server;
let base = '';
let hits: Hit[] = [];
let replies: Reply[] = [];

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.writeHead(status, {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  json(status, { type: 'x', title: code, status, code, request_id: 'r' }, headers);

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({
      method: req.method!,
      path: req.url!,
      at: performance.now(),
      idem: (req.headers['idempotency-key'] as string | undefined) ?? null,
    });
    req.resume();
    req.on('end', () => (replies.shift() ?? problem(500, 'NO_REPLY_SCRIPTED'))(res, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function client(random = Math.random): ApiClient {
  return createApiClient({
    transport: (r) => fetch(`${base}${r.path}${r.search}`, { method: r.method, headers: r.headers, body: r.body, signal: r.signal }),
    random,
  });
}

beforeEach(() => {
  hits = [];
  replies = [];
});

const gaps = () => hits.slice(1).map((h, i) => h.at - hits[i]!.at);

describe('SEC-RL-4 against a fake server', () => {
  it('never repeats a read before CarPal-Retry-After-Ms, and adds at most 20 % jitter', async () => {
    replies = [problem(429, 'RATE_LIMITED', { 'carpal-retry-after-ms': '400' }), json(200, { id: 'u' })];
    await client().api('me.get');
    expect(hits).toHaveLength(2);
    expect(gaps()[0]).toBeGreaterThanOrEqual(400);
    expect(gaps()[0]).toBeLessThan(400 * 1.2 + 250);
  });

  it('backs off with full jitter when no delay is given, and stops after 5 attempts', async () => {
    replies = Array.from({ length: 6 }, () => problem(502, 'BAD_GATEWAY'));
    const err = await client(() => 0.05)
      .api('me.get')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect(hits).toHaveLength(RETRY.maxAttempts);
    // random 0.05 → 25, 50, 100, 200 ms (U[0, 500·2^n]); never sooner.
    gaps().forEach((g, i) => expect(g).toBeGreaterThanOrEqual(0.05 * RETRY.baseMs * 2 ** i - 5));
  });

  it('retries an IDEM write with the same Idempotency-Key after the delay', async () => {
    replies = [problem(503, 'OVERLOADED', { 'carpal-retry-after-ms': '200' }), json(201, { id: 'q' })];
    await client().api('questions.create', { body: { title: 'Why does it squeak?', body: 'x', content_locale: 'en' } as never });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.idem).toBeTruthy();
    expect(hits[1]!.idem).toBe(hits[0]!.idem);
    expect(gaps()[0]).toBeGreaterThanOrEqual(200);
  });

  it('does not retry a write without IDEM; the user retries it', async () => {
    replies = [problem(503, 'OVERLOADED', { 'carpal-retry-after-ms': '100' })];
    const err = (await client()
      .api('vehicles.update', { path: { vehicle_id: '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2' }, body: {} as never, ifMatch: '"v1"' })
      .catch((e: unknown) => e)) as ApiProblem;
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(100);
    expect(hits).toHaveLength(1);
  });

  it('pauses an operation after three 503s in a row: the fourth call sends nothing', async () => {
    const c = client();
    const update = (): Promise<ApiProblem> =>
      c.api('vehicles.update', { path: { vehicle_id: '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2' }, body: {} as never, ifMatch: '"v1"' }).then(
        () => Promise.reject(new Error('expected a failure')),
        (e: unknown) => e as ApiProblem,
      );
    replies = Array.from({ length: 3 }, () => problem(503, 'OVERLOADED', { 'carpal-retry-after-ms': '60000' }));
    for (let i = 0; i < 3; i++) expect((await update()).status).toBe(503);
    const paused = await update();
    expect(paused.code).toBe('PAUSED');
    expect(hits).toHaveLength(3);
  });

  it('waits for CarPal-Poll-After-Ms before polling the same operation again', async () => {
    const c = client();
    replies = [json(200, { count: 1 }, { 'carpal-poll-after-ms': '300' }), json(200, { count: 2 })];
    await c.call('notifications.unread_count');
    const answered = performance.now();
    await c.call('notifications.unread_count');
    expect(hits).toHaveLength(2);
    expect(hits[1]!.at - answered).toBeGreaterThanOrEqual(295);
  });
});

describe('TR-3: unknown response fields and enum values', () => {
  it('accepts a response with fields and enum values this build does not know', async () => {
    replies = [json(200, { id: 'a', status: 'teleported', hologram: { depth: 3 }, version: 2 })];
    const a = await client().api('appointments.get', { path: { appointment_id: '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2' } });
    expect(a.id).toBe('a');
    expect(knownEnum('AppointmentStatus', a.status)).toBe('unknown');
    expect(knownEnum('AppointmentStatus', 'confirmed')).toBe('confirmed');
    expect(knownEnum('UrgencyLevel', undefined)).toBe('unknown');
  });

  it('labels an unknown value of an enum label group "Unknown", and leaves other missing keys visible', () => {
    const en = translator(
      createI18n('en', { common: { unknownValue: 'Unknown' }, appointments: { status: { confirmed: 'Confirmed' } } } as never),
    );
    expect(en('appointments.status.confirmed' as never)).toBe('Confirmed');
    expect(en('appointments.status.teleported' as never)).toBe('Unknown');
    expect(en('appointments.nowhere' as never)).toBe('appointments.nowhere');
    expect(en('appointments.status.Not A Value' as never)).toBe('appointments.status.Not A Value');
  });
});
