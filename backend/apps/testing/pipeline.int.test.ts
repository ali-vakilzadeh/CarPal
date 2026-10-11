// S2 acceptance: pipeline tests for the 40 §4.3 common errors that apply
// without business logic, plus transport, headers, idempotency, If-Match,
// cursors, rate limits, load shedding, flags and the response checks. Test
// handlers are bound to real contract operations.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '#libs/audit/index.js';
import { assertVersion } from '#libs/concurrency/index.js';
import { createContractAjv, loadSchemas } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { FlagService } from '#libs/flags/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { createTestApp, type TestApp } from './test-app.js';

const problemSchema = createContractAjv().getSchema(`${loadSchemas().root.$id}#/$defs/Problem`)!;
const calls: Record<string, OperationContext[]> = {};
const record = (op: string, ctx: OperationContext) => (calls[op] ??= []).push(ctx);
let auditWrites = true;

let app: TestApp;
let alice: TestUser;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  app = await createTestApp({
    host: 'api',
    handlers: {
      'reports.create': async (ctx) => {
        record('reports.create', ctx);
        if ((ctx.body as { details?: string }).details === 'slow') await sleep(300);
        return { status: 201, body: { report_id: uuidv7(), status: 'open' } };
      },
      'org.update': (ctx) => {
        record('org.update', ctx);
        assertVersion(ctx.ifMatch, 3);
        throw new Error('not reached in these tests');
      },
      'me.sessions_list': (ctx) => {
        record('me.sessions_list', ctx);
        return { body: ctx.page([], ctx.cursor ? null : { after: 'position-1' }) };
      },
      'me.get': () => ({ body: { not: 'a Me' } }),
      'reviews.mine_withdraw': async (ctx) =>
        ctx.tx(async (scope) => {
          if (auditWrites) await writeAudit(scope, { action: 'review.withdrawn', entityType: 'review', entityId: ctx.params.review_id! });
          return { body: { ok: true } };
        }),
    },
  });
  alice = await app.fixtures.user();
  aliceToken = await app.fixtures.token(alice);
  bobToken = await app.fixtures.token(await app.fixtures.user());
});

afterAll(() => app.close());

const report = { target_type: 'review', target_id: '0190b2d4-7a1c-7c3e-9f00-123456789abc', reason: 'spam' };
const post = (body: unknown, headers: Record<string, string | undefined> = {}, token = aliceToken) =>
  app.request({ method: 'POST', path: '/v1/reports', token, body, headers: { 'idempotency-key': uuidv7(), ...headers } });

function expectProblem(res: { status: number; body: unknown; headers: Record<string, string> }, status: number, code: string) {
  expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  expect(res.headers['content-type']).toBe('application/problem+json');
  expect(problemSchema(res.body), JSON.stringify(problemSchema.errors)).toBe(true);
  expect((res.body as { request_id: string }).request_id).toBe(res.headers['carpal-request-id']);
}

describe('headers on every response (40 §1.4, TR-2, TR-8)', () => {
  it('sends security headers, request id, contract version and no-store; no server banner', async () => {
    const res = await app.request({ path: '/v1/health', client: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers).toMatchObject({
      'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'carpal-contract': '1.0.0',
      'cache-control': 'no-store',
    });
    expect(res.headers.server).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes a UUID CarPal-Request-Id and replaces anything else (log injection)', async () => {
    const id = uuidv7();
    expect((await app.request({ path: '/v1/health', headers: { 'carpal-request-id': id } })).headers['carpal-request-id']).toBe(id);
    const replaced = (await app.request({ path: '/v1/health', headers: { 'carpal-request-id': 'evil\tvalue' } })).headers[
      'carpal-request-id'
    ];
    expect(replaced).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('localizes problem titles by Accept-Language', async () => {
    const res = await app.request({ path: '/v1/nope', headers: { 'accept-language': 'fa-IR,fa;q=0.9' } });
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.headers['content-language']).toBe('fa');
    expect((res.body as { title: string }).title).toBe('پیدا نشد.');
  });
});

describe('router (SEC-AZ-1, SEC-IN-8, TR-6)', () => {
  it('404 for unknown routes, invalid ids, encoded slashes and dot segments', async () => {
    for (const path of [
      '/v1/nope',
      '/v1/jobs/not-an-id',
      '/v1/jobs/..%2F..%2Fetc',
      '/v1/health/',
      '/v1//health',
      `/v1/jobs/${uuidv7().toUpperCase()}`,
    ]) {
      expectProblem(await app.request({ path, token: aliceToken }), 404, 'NOT_FOUND');
    }
  });

  it('405 METHOD_NOT_ALLOWED with Allow for known paths, including HEAD and OPTIONS (no CORS)', async () => {
    const put = await app.request({ method: 'PUT', path: '/v1/health', body: {} });
    expectProblem(put, 405, 'METHOD_NOT_ALLOWED');
    expect(put.headers.allow).toBe('GET');
    expect((await app.request({ method: 'OPTIONS', path: '/v1/health' })).status).toBe(405);
    expect((await app.request({ method: 'HEAD', path: '/v1/health' })).status).toBe(405);
  });
});

describe('transport checks (40 §1.2-1.3, SEC-IN-1/2/4)', () => {
  it('400 MALFORMED_REQUEST: missing or malformed CarPal-Client, method override, GET with a body', async () => {
    expectProblem(await app.request({ path: '/v1/me', token: aliceToken, client: null }), 400, 'MALFORMED_REQUEST');
    expectProblem(await app.request({ path: '/v1/me', token: aliceToken, client: 'cp-mobile/1.0 (ios 17)' }), 400, 'MALFORMED_REQUEST');
    expectProblem(await post(report, { 'x-http-method-override': 'DELETE' }), 400, 'MALFORMED_REQUEST');
    expectProblem(
      await app.request({ path: '/v1/me', token: aliceToken, body: '{}', headers: { 'content-type': 'application/json' } }),
      400,
      'MALFORMED_REQUEST',
    );
  });

  it('400 CLIENT_UPGRADE_REQUIRED below the minimum version', async () => {
    const old = await createTestApp({ host: 'api', env: { CARPAL_CLIENT_MIN_VERSIONS: '{"cp-mobile":"2.0.0"}' } });
    try {
      expectProblem(
        await old.request({ path: '/v1/config/client', token: await old.fixtures.anonymousToken() }),
        400,
        'CLIENT_UPGRADE_REQUIRED',
      );
      expect(
        (
          await old.request({
            path: '/v1/config/client',
            token: await old.fixtures.anonymousToken(),
            client: 'cp-mobile/2.1.0 (android 14)',
          })
        ).status,
      ).toBe(200);
    } finally {
      await old.close();
    }
  });

  it('400 MALFORMED_REQUEST for invalid JSON: syntax, duplicate keys, exponents, __proto__, bad UTF-8, BOM', async () => {
    const raw = (body: string | Buffer) => post(body, { 'content-type': 'application/json' });
    for (const body of [
      '{"target_type":',
      '{"reason":"spam","reason":"fake"}',
      '{"n":1e3}',
      '{"__proto__":{"admin":true}}',
      '{"a":{"constructor":1}}',
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(report))]),
      '{"n":12345678901234567890}',
    ]) {
      expectProblem(await raw(body), 400, 'MALFORMED_REQUEST');
    }
  });

  it('413 PAYLOAD_TOO_LARGE above 64 KiB, deeper than 8 levels or with more than 1,000 keys', async () => {
    expectProblem(await post({ ...report, details: 'x'.repeat(66_000) }), 413, 'PAYLOAD_TOO_LARGE');
    let deep: unknown = 1;
    for (let i = 0; i < 9; i++) deep = { a: deep };
    expectProblem(await post(deep), 413, 'PAYLOAD_TOO_LARGE');
    expectProblem(await post(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, 1]))), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('415 UNSUPPORTED_MEDIA_TYPE for anything but application/json; charset=utf-8', async () => {
    for (const ct of ['text/plain', 'application/json; charset=latin1', 'multipart/form-data; boundary=x', 'application/xml']) {
      expectProblem(await post(JSON.stringify(report), { 'content-type': ct }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    expect((await post(JSON.stringify(report), { 'content-type': 'Application/JSON' })).status).toBe(201);
  });

  it('normalizes text (trim, NFC, Latin digits in numeric strings) and rejects forbidden characters with a pointer', async () => {
    const res = await post({ ...report, details: '  café ۱۲۳  ' });
    expect(res.status).toBe(201);
    expect((calls['reports.create']!.at(-1)!.body as { details: string }).details).toBe('café ۱۲۳');
    const bidi = await post({ ...report, details: `ok ${String.fromCharCode(0x202e)} evil` });
    expectProblem(bidi, 422, 'VALIDATION_FAILED');
    expect((bidi.body as { errors: unknown[] }).errors).toEqual([{ pointer: '/details', code: 'forbidden_character' }]);
    expectProblem(await post({ ...report, details: 'a\u0000b' }), 422, 'VALIDATION_FAILED');
  });
});

describe('authentication (SEC-AU-2/4)', () => {
  it('401 UNAUTHENTICATED without a token, with a bad token, or a token of another client', async () => {
    const none = await app.request({ path: '/v1/me' });
    expectProblem(none, 401, 'UNAUTHENTICATED');
    expect(none.headers['www-authenticate']).toBeDefined();
    expectProblem(await app.request({ path: '/v1/me', token: 'a.b.c' }), 401, 'UNAUTHENTICATED');
    expectProblem(await app.request({ path: '/v1/me', token: aliceToken, client: 'cp-web-portal/1.0.0 (web 1)' }), 401, 'UNAUTHENTICATED');
    expectProblem(await app.request({ path: '/v1/me', token: await app.fixtures.anonymousToken() }), 401, 'UNAUTHENTICATED');
  });
});

describe('validation (SEC-IN-3, SEC-AZ-5)', () => {
  it('422 UNKNOWN_FIELD, READ_ONLY_FIELD and VALIDATION_FAILED with RFC 6901 pointers', async () => {
    const unknown = await post({ ...report, extra: 1 });
    expectProblem(unknown, 422, 'UNKNOWN_FIELD');
    expect((unknown.body as { errors: unknown[] }).errors).toEqual([{ pointer: '/extra', code: 'unknown_field' }]);
    const readOnly = await post({ ...report, status: 'open' });
    expectProblem(readOnly, 422, 'READ_ONLY_FIELD');
    expect((readOnly.body as { errors: unknown[] }).errors).toEqual([{ pointer: '/status', code: 'read_only' }]);
    const invalid = await post({ target_type: 'nope', target_id: 'x', details: '' });
    expectProblem(invalid, 422, 'VALIDATION_FAILED');
    expect((invalid.body as { errors: { pointer: string; code: string }[] }).errors).toEqual(
      expect.arrayContaining([
        { pointer: '/reason', code: 'required' },
        { pointer: '/target_type', code: 'enum' },
        { pointer: '/target_id', code: 'pattern' },
        { pointer: '/details', code: 'too_short', limit: '1' },
      ]),
    );
  });

  it('400 UNKNOWN_QUERY_PARAM for unknown or repeated parameters; query values are typed and defaulted', async () => {
    expectProblem(await app.request({ path: '/v1/me/sessions?foo=1', token: aliceToken }), 400, 'UNKNOWN_QUERY_PARAM');
    expectProblem(await app.request({ path: '/v1/me/sessions?limit=1&limit=2', token: aliceToken }), 400, 'UNKNOWN_QUERY_PARAM');
    const bad = await app.request({ path: '/v1/me/sessions?limit=0', token: aliceToken });
    expectProblem(bad, 422, 'VALIDATION_FAILED');
    expect((bad.body as { errors: unknown[] }).errors).toEqual([{ pointer: '/query/limit', code: 'out_of_range', limit: '1' }]);
    expect((await app.request({ path: '/v1/me/sessions', token: aliceToken })).status).toBe(200);
    expect(calls['me.sessions_list']!.at(-1)!.query).toEqual({ limit: 20 });
    await app.request({ path: '/v1/me/sessions?limit=%DB%B5', token: aliceToken });
    expect(calls['me.sessions_list']!.at(-1)!.query).toEqual({ limit: 5 }); // Persian digit normalized
  });
});

describe('idempotency (SEC-IC-1/2)', () => {
  it('428 without a key, 400 for a malformed key', async () => {
    expectProblem(await post(report, { 'idempotency-key': undefined }), 428, 'IDEMPOTENCY_KEY_REQUIRED');
    expectProblem(await post(report, { 'idempotency-key': 'not-a-uuid' }), 400, 'MALFORMED_REQUEST');
  });

  it('replays the first response for the same key and body, rejects another body, and blocks while running', async () => {
    const key = uuidv7();
    const before = calls['reports.create']?.length ?? 0;
    const first = await post(report, { 'idempotency-key': key });
    const again = await post(report, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(calls['reports.create']!.length).toBe(before + 1);
    expectProblem(await post({ ...report, reason: 'fake' }, { 'idempotency-key': key }), 422, 'IDEMPOTENCY_KEY_REUSED');
    // Keys are per principal: Bob's request with Alice's key is a new request.
    expect((await post(report, { 'idempotency-key': key }, bobToken)).headers['idempotent-replayed']).toBeUndefined();

    const slowKey = uuidv7();
    const slow = post({ ...report, details: 'slow' }, { 'idempotency-key': slowKey });
    await sleep(50);
    expectProblem(await post({ ...report, details: 'slow' }, { 'idempotency-key': slowKey }), 409, 'IDEMPOTENCY_IN_PROGRESS');
    expect((await slow).status).toBe(201);
  });
});

describe('optimistic concurrency (SEC-IC-3/4)', () => {
  it('428 PRECONDITION_REQUIRED without If-Match; 412 VERSION_MISMATCH when stale or malformed', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const patch = (ifMatch?: string) =>
      app.request({ method: 'PATCH', path: `/v1/orgs/${org.id}`, token, body: { name: 'New name' }, headers: { 'if-match': ifMatch } });
    expectProblem(await patch(), 428, 'PRECONDITION_REQUIRED');
    expectProblem(await patch('"v2"'), 412, 'VERSION_MISMATCH');
    expectProblem(await patch('*'), 412, 'VERSION_MISMATCH');
    expect(calls['org.update']!.at(-1)!.ifMatch).toBe(2);
  });
});

describe('signed cursors (40 §3.1 Cursor, §3.3)', () => {
  it('binds the cursor to the caller and the filters (400 CURSOR_MISMATCH otherwise)', async () => {
    const first = await app.request<{ items: unknown[]; next_cursor: string }>({ path: '/v1/me/sessions?limit=5', token: aliceToken });
    expect(first.body.items).toEqual([]);
    const cursor = first.body.next_cursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const next = await app.request({ path: `/v1/me/sessions?cursor=${cursor}&limit=10`, token: aliceToken });
    expect(next.status).toBe(200);
    expect(calls['me.sessions_list']!.at(-1)!.cursor).toEqual({ after: 'position-1' });
    expectProblem(await app.request({ path: `/v1/me/sessions?cursor=${cursor}`, token: bobToken }), 400, 'CURSOR_MISMATCH');
    expectProblem(
      await app.request({ path: `/v1/me/sessions?cursor=${cursor.slice(0, -2)}AA`, token: aliceToken }),
      400,
      'CURSOR_MISMATCH',
    );
  });
});

describe('response checks (dev/test)', () => {
  it('turns a response that violates the contract into 500 INTERNAL without leaking detail', async () => {
    const res = await app.request({ path: '/v1/me', token: aliceToken });
    expectProblem(res, 500, 'INTERNAL');
    expect(res.text).not.toMatch(/not|Me|stack|at /);
  });

  it('requires an audit entry from AUD operations, written in the same transaction', async () => {
    auditWrites = false;
    expectProblem(await app.request({ method: 'DELETE', path: `/v1/me/reviews/${uuidv7()}`, token: aliceToken }), 500, 'INTERNAL');
    auditWrites = true;
    const ok = await app.request({ method: 'DELETE', path: `/v1/me/reviews/${uuidv7()}`, token: aliceToken });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });
});

describe('rate limits and load shedding (SEC-RL)', () => {
  it('429 RATE_LIMITED with CarPal-Retry-After-Ms, Retry-After and retry_after_ms', async () => {
    const limited = await createTestApp({
      host: 'api',
      env: { CARPAL_RATE_LIMIT_SCALE: '1', CARPAL_RATE_LIMITS: '{"public.read":[{"limit":2,"windowMs":60000,"scope":"anon"}]}' },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const ok = await limited.request({ path: '/v1/health' });
        expect(ok.status).toBe(200);
        expect(ok.headers['ratelimit-policy']).toBe('"public.read";q=2;w=60');
      }
      const res = await limited.request({ path: '/v1/health' });
      expectProblem(res, 429, 'RATE_LIMITED');
      const ms = Number(res.headers['carpal-retry-after-ms']);
      expect(ms).toBeGreaterThanOrEqual(100);
      expect((res.body as { retry_after_ms: number }).retry_after_ms).toBe(ms);
      expect(res.headers['retry-after']).toBe(String(Math.ceil(ms / 1000)));
    } finally {
      await limited.close();
    }
  });

  it('503 OVERLOADED when requests in flight exceed the capacity of their priority', async () => {
    const busy = await createTestApp({
      host: 'api',
      env: { CARPAL_MAX_INFLIGHT: '2' },
      handlers: { 'me.get': async () => (await sleep(300), { body: {} }) },
    });
    try {
      const token = await busy.fixtures.token(await busy.fixtures.user());
      const first = busy.request({ path: '/v1/me', token });
      await sleep(50);
      const shed = await busy.request({ path: '/v1/me', token });
      expectProblem(shed, 503, 'OVERLOADED');
      expect(Number(shed.headers['carpal-retry-after-ms'])).toBeGreaterThanOrEqual(1000);
      await first;
    } finally {
      await busy.close();
    }
  });
});

describe('feature flags (FLAG, SEC-AI-6)', () => {
  it('403 FEATURE_DISABLED for release flags and 503 AI_UNAVAILABLE with a retry delay for AI flags', async () => {
    class KillSwitchOn extends FlagService {
      override async isEnabled(key: string) {
        return !key.startsWith('ai.') && key !== 'qna.enabled';
      }
      override async type(key: string) {
        return key.startsWith('ai.') ? ('ai_feature' as const) : ('release' as const);
      }
    }
    const flagged = await createTestApp({
      host: 'api',
      providers: [{ provide: FlagService, useFactory: () => new KillSwitchOn(undefined as never, 'dev', 0) }],
      handlers: { 'triage.start': () => ({ status: 201, body: {} }), 'questions.search': () => ({ body: {} }) },
    });
    try {
      const token = await flagged.fixtures.token(await flagged.fixtures.user());
      const ai = await flagged.request({ method: 'POST', path: '/v1/me/triage-sessions', token, body: {} });
      expectProblem(ai, 503, 'AI_UNAVAILABLE');
      expect(Number(ai.headers['carpal-retry-after-ms'])).toBeGreaterThan(0);
      const qna = await flagged.request({ method: 'POST', path: '/v1/questions/search', token, body: {} });
      expectProblem(qna, 403, 'FEATURE_DISABLED');
    } finally {
      await flagged.close();
    }
  });
});
