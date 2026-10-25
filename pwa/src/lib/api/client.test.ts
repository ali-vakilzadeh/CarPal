import { describe, expect, it } from 'vitest';
import { browserTransport, createCsrfSource } from './browser';
import { buildSearch, createApiClient, fillPath, selectRoute, type TransportRequest } from './client';
import { ApiProblem, parseStepUp } from './problem';
import { isRetryable, OperationGate, RETRY, retryDelay } from './retry';

const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'x', title: code, status, code, request_id: 'r1', ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

/** The ApiProblem a call rejects with (fails the test when it resolves). */
async function failure(p: Promise<unknown>): Promise<ApiProblem> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiProblem) return e;
    throw e;
  }
  throw new Error('expected the call to fail');
}

function harness(responses: (Response | Error | ((r: TransportRequest) => Response))[], o: { now?: () => number } = {}) {
  const sent: TransportRequest[] = [];
  const slept: number[] = [];
  const client = createApiClient({
    transport: async (r) => {
      sent.push({ ...r, headers: new Headers(r.headers) });
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(r) : next;
    },
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
    solvePow: async () => 'ch.42',
    ...o,
  });
  return { client, sent, slept };
}

describe('routes and URLs', () => {
  it('picks the me route, or the fleet route when org_id is given', () => {
    expect(selectRoute('vehicles.list', undefined).path).toBe('/v1/me/vehicles');
    expect(selectRoute('vehicles.list', { org_id: 'o' }).path).toBe('/v1/orgs/{org_id}/fleet/vehicles');
  });

  it('fills and encodes path parameters, refuses missing ones', () => {
    const route = selectRoute('vehicles.get', undefined);
    expect(fillPath(route, { vehicle_id: 'a/b c' })).toBe('/v1/me/vehicles/a%2Fb%20c');
    expect(() => fillPath(route, {})).toThrow(/vehicle_id/);
  });

  it('builds queries from enumerated values, skipping empty ones and repeating arrays', () => {
    expect(buildSearch({ status: 'active', limit: 20, cursor: undefined, tag: ['a', 'b'] })).toBe('?status=active&limit=20&tag=a&tag=b');
    expect(buildSearch({})).toBe('');
  });
});

describe('typed calls', () => {
  it('returns typed data and sends JSON with an idempotency key for IDEM operations', async () => {
    const { client, sent } = harness([Response.json({ id: 'v1', version: 1 }, { status: 201, headers: { etag: '"v1"' } })]);
    const v = await client.api('vehicles.create', { body: { nickname: 'Pride' } as never });
    expect(v).toEqual({ id: 'v1', version: 1 });
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.path).toBe('/v1/me/vehicles');
    expect(sent[0]!.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(sent[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(sent[0]!.body).toBe('{"nickname":"Pride"}');
  });

  it('keeps the Idempotency-Key across automatic retries of an IDEM write (SEC-RL-4)', async () => {
    const { client, sent, slept } = harness([
      problem(503, 'OVERLOADED', { retry_after_ms: 1000 }, { 'carpal-retry-after-ms': '1000' }),
      new TypeError('network'),
      Response.json({ id: 'v1' }, { status: 201 }),
    ]);
    await client.api('vehicles.create', { body: {} as never });
    const keys = sent.map((s) => s.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(1);
    expect(slept[0]).toBe(1100); // server delay + 10 % (random 0.5 of the 0-20 % jitter)
    expect(slept[1]).toBe(500); // full jitter: 0.5 × min(30 s, 500 ms × 2^1)
  });

  it('never retries a non-IDEM write automatically', async () => {
    const { client, sent } = harness([problem(503, 'OVERLOADED', { retry_after_ms: 100 })]);
    await expect(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never })).rejects.toMatchObject({ status: 503 });
    expect(sent).toHaveLength(1);
  });

  it('retries a safe read at most 5 times with backoff', async () => {
    const { client, sent, slept } = harness(Array.from({ length: 6 }, () => problem(502, 'BAD_GATEWAY')));
    await expect(client.api('me.get')).rejects.toMatchObject({ status: 502 });
    expect(sent).toHaveLength(RETRY.maxAttempts);
    expect(slept).toEqual([250, 500, 1000, 2000]);
  });

  it('surfaces waits above 30 s instead of sleeping (GD-09 amendment 3)', async () => {
    const { client, slept } = harness([problem(429, 'RATE_LIMITED', { retry_after_ms: 3_600_000 })]);
    const err = await failure(client.api('me.get'));
    expect(err).toBeInstanceOf(ApiProblem);
    expect(err.rateLimited).toBe(true);
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(slept).toEqual([]);
  });

  it('does not retry AI_UNAVAILABLE and exposes its safety block and fallback path (BA-02)', async () => {
    const safety = { flag: true, level: 'urgent', message_i18n_key: 'safety.brakes', urgent_help_available: true, do_not_drive: true };
    const { client, sent } = harness([problem(503, 'AI_UNAVAILABLE', { safety, fallback_path: '/v1/search' })]);
    const err = await failure(client.api('config.client'));
    expect(sent).toHaveLength(1);
    expect(err.safety).toEqual(safety);
    expect(err.fallbackPath).toBe('/v1/search');
  });

  it('pauses an operation after 3 consecutive 503s for the last given delay', async () => {
    let now = 0;
    const responses = Array.from({ length: 3 }, () => problem(503, 'OVERLOADED', { retry_after_ms: 40_000 }));
    const { client, sent } = harness(responses, { now: () => now });
    await expect(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never })).rejects.toBeTruthy();
    await expect(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never })).rejects.toBeTruthy();
    await expect(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never })).rejects.toBeTruthy();
    const paused = await failure(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never }));
    expect(paused.code).toBe('PAUSED');
    expect(paused.retryAfterMs).toBe(40_000);
    expect(sent).toHaveLength(3);
    now = 40_001;
    expect(client.gate.paused('vehicles.update')).toBeNull();
  });

  it('sends If-Match from the last ETag of the resource, and "v1" for a first onboarding save', async () => {
    const { client, sent } = harness([
      Response.json({ id: 'v', version: 4 }, { headers: { etag: '"v4"' } }),
      Response.json({ id: 'v', version: 5 }, { headers: { etag: '"v5"' } }),
      Response.json({ id: 'v', version: 6 }, { headers: { etag: '"v6"' } }),
      Response.json({}),
    ]);
    await client.api('vehicles.get', { path: { vehicle_id: 'v' } });
    await client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never });
    await client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never });
    expect(sent[1]!.headers.get('if-match')).toBe('"v4"');
    expect(sent[2]!.headers.get('if-match')).toBe('"v5"');
    await client.api('onboarding.update', { path: { flow_type: 'consumer' as never }, body: { current_step: 'vehicle' } as never });
    expect(sent[3]!.headers.get('if-match')).toBe('"v1"');
  });

  it('maps problems: fields, VERSION_MISMATCH, VIN transfer, consent, step-up', async () => {
    const { client } = harness([
      problem(422, 'VALIDATION_FAILED', { errors: [{ pointer: '/vin', code: 'pattern' }] }),
      problem(412, 'VERSION_MISMATCH'),
      problem(409, 'DUPLICATE', { vin_transfer_available: true }),
      problem(403, 'CONSENT_REQUIRED', { consent_type: 'location_usage' }),
      problem(
        401,
        'STEP_UP_REQUIRED',
        {},
        { 'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal2", max_age=600' },
      ),
    ]);
    const e = () => failure(client.api('vehicles.update', { path: { vehicle_id: 'v' }, body: {} as never }));
    expect((await e()).field('/vin')?.code).toBe('pattern');
    expect((await e()).versionMismatch).toBe(true);
    expect((await e()).vinTransferAvailable).toBe(true);
    expect((await e()).consentType).toBe('location_usage');
    expect((await e()).stepUp).toEqual({ acrValues: 'aal2', maxAgeS: 600 });
    expect(parseStepUp(null)).toEqual({ acrValues: 'aal2', maxAgeS: null });
  });

  it('solves a proof of work once when an ATT operation is refused without one (DI-22)', async () => {
    const { client, sent } = harness([problem(403, 'ATTESTATION_REQUIRED'), Response.json({ id: 'r' }, { status: 201 })]);
    await client.api('reviews.create', { body: {} as never });
    expect(sent[0]!.headers.get('carpal-pow')).toBeNull();
    expect(sent[1]!.headers.get('carpal-pow')).toBe('ch.42');
    expect(sent[0]!.headers.get('idempotency-key')).toBe(sent[1]!.headers.get('idempotency-key'));
  });

  it('waits for CarPal-Poll-After-Ms before polling the same operation again (SEC-RL-3)', async () => {
    const { client, slept } = harness([
      Response.json({ count: 1 }, { headers: { 'carpal-poll-after-ms': '10000' } }),
      Response.json({ count: 2 }),
    ]);
    const first = await client.call('notifications.unread_count');
    expect(first.pollAfterMs).toBe(10_000);
    await client.call('notifications.unread_count');
    expect(slept[0]).toBeGreaterThan(10_000);
    expect(slept[0]).toBeLessThanOrEqual(12_000);
  });
});

describe('retry policy', () => {
  it('retries only safe methods and IDEM requests on transient failures', () => {
    expect(isRetryable({ method: 'GET', idem: false, status: 503 })).toBe(true);
    expect(isRetryable({ method: 'POST', idem: true, status: 'network' })).toBe(true);
    expect(isRetryable({ method: 'POST', idem: false, status: 503 })).toBe(false);
    expect(isRetryable({ method: 'GET', idem: false, status: 500 })).toBe(false);
    expect(isRetryable({ method: 'GET', idem: false, status: 404 })).toBe(false);
  });

  it('delays: server delay plus up to 20 %, else full jitter capped at 30 s', () => {
    expect(retryDelay(0, 1000, () => 1)).toBe(1200);
    expect(retryDelay(0, 1000, () => 0)).toBe(1000);
    expect(retryDelay(10, null, () => 0.999)).toBeLessThan(30_000);
    expect(retryDelay(0, null, () => 0.999)).toBeLessThan(500);
  });

  it('a non-503 resets the 503 count', () => {
    const g = new OperationGate(() => 0);
    g.record('x', 503, 'OVERLOADED', 1000);
    g.record('x', 503, 'OVERLOADED', 1000);
    g.record('x', 200, undefined, null);
    g.record('x', 503, 'OVERLOADED', 1000);
    expect(g.paused('x')).toBeNull();
  });
});

describe('browser transport', () => {
  it('prefixes /api or /id, adds CSRF on writes only, locale and time zone; refreshes CSRF once when refused', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let csrfCalls = 0;
    let refused = false;
    const fake = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/bff/csrf') return Response.json({ csrf_token: `t${++csrfCalls}` });
      if (url.startsWith('/api/v1/me/vehicles') && init.method === 'POST' && !refused) {
        refused = true;
        return problem(403, 'CSRF_FAILED', { reason: 'token' });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const csrf = createCsrfSource(fake);
    const client = createApiClient({ transport: browserTransport({ csrf, fetch: fake, locale: () => 'en' }) });
    await client.api('me.get');
    await client.api('vehicles.create', { body: {} as never });
    await client.api('auth.signin_password', { body: { interaction_id: 'i', email: 'a@b.c', password: 'p' } });
    const api = calls.filter((c) => c.url !== '/bff/csrf');
    const h = (i: number) => new Headers(api[i]!.init.headers);
    expect(api.map((c) => c.url)).toEqual(['/api/v1/me', '/api/v1/me/vehicles', '/api/v1/me/vehicles', '/id/v1/auth/signin']);
    expect(h(0).get('x-csrf-token')).toBeNull();
    expect(h(0).get('accept-language')).toBe('en');
    expect(h(1).get('x-csrf-token')).toBe('t1');
    expect(h(2).get('x-csrf-token')).toBe('t2');
    expect(h(3).get('x-csrf-token')).toBeNull();
    expect(api[0]!.init.credentials).toBe('same-origin');
    expect(csrfCalls).toBe(2);
  });
});
