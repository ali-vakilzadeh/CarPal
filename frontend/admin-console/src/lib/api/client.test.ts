// AC3.T7 unit tests of the typed admin client: purpose and reason handling, idempotency, ETags, the 202 outcomes,
// problem mapping (STEP_UP_REQUIRED, SELF_APPROVAL_FORBIDDEN, PURPOSE_REQUIRED, VERSION_MISMATCH), retries and polling.
import { describe, expect, it, vi } from 'vitest';
import { browserTransport, createCsrfSource } from './browser';
import { createApiClient, pollUntil, purposeOf, reasonHeader, type TransportRequest } from './client';
import { ApiProblem } from './problem';

const UUID = '0193a5b0-0000-7000-8000-00000000000a';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code, title: code, status, request_id: 'r1' }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

function setup(answer: (req: TransportRequest, n: number) => Response | Promise<Response>) {
  const seen: TransportRequest[] = [];
  const sleeps: number[] = [];
  const onSessionEnded = vi.fn();
  const api = createApiClient({
    transport: async (req) => {
      seen.push({ ...req, headers: new Headers(req.headers) });
      return answer(req, seen.length);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    onSessionEnded,
  });
  return { api, seen, sleeps, onSessionEnded };
}

describe('admin client: request shape', () => {
  it('fills the path and query and sends the purpose of a PURP read (GD-10)', async () => {
    const { api, seen } = setup(() => json({ id: UUID }));
    await api.api('admin.user_get', { path: { user_id: UUID }, purpose: purposeOf('case', UUID) });
    expect(seen[0]!.path).toBe(`/v1/admin/users/${UUID}`);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('carpal-access-purpose')).toBe(`case:${UUID}`);
    await api.api('admin.flags_list', { query: { cursor: 'c1' } } as never);
    expect(seen[1]!.search).toBe('?cursor=c1');
    expect(seen[1]!.headers.get('carpal-access-purpose')).toBeNull();
  });

  it('refuses a PURP read without a valid purpose before sending (PURPOSE_REQUIRED)', async () => {
    const { api, seen } = setup(() => json({}));
    await expect(api.api('admin.user_get', { path: { user_id: UUID } })).rejects.toMatchObject({
      code: 'PURPOSE_REQUIRED',
      purposeRequired: true,
    });
    await expect(api.api('admin.user_get', { path: { user_id: UUID }, purpose: 'case:nope' })).rejects.toMatchObject({
      code: 'PURPOSE_REQUIRED',
    });
    expect(seen).toHaveLength(0);
  });

  it('sends the reason of a DELETE as CarPal-Reason (percent-encoded when not ASCII) and of other writes in the body', async () => {
    const { api, seen } = setup(() => json({ ok: true }));
    await api.api('admin.synonym_delete', { path: { synonym_id: UUID }, reason: 'تکراری است' });
    expect(seen[0]!.headers.get('carpal-reason')).toBe(encodeURIComponent('تکراری است'));
    expect(seen[0]!.body).toBeUndefined();
    await api.api('admin.synonym_delete', { path: { synonym_id: UUID }, reason: 'Duplicate\nentry' });
    expect(seen[1]!.headers.get('carpal-reason')).toBe('Duplicate entry');
    await api.api('admin.user_status', { path: { user_id: UUID }, body: { status: 'suspended' } as never, reason: 'Fraud report' });
    expect(JSON.parse(seen[2]!.body!)).toEqual({ status: 'suspended', reason: 'Fraud report' });
    expect(seen[2]!.headers.get('carpal-reason')).toBeNull();
    // A reason already in the body wins.
    await api.api('admin.user_status', { path: { user_id: UUID }, body: { status: 'active', reason: 'Body' }, reason: 'Arg' });
    expect(JSON.parse(seen[3]!.body!).reason).toBe('Body');
    expect(reasonHeader('100% sure')).toBe('100%25%20sure');
  });

  it('adds an Idempotency-Key to IDEM writes and keeps it across automatic retries', async () => {
    const { api, seen, sleeps } = setup((_, n) =>
      n === 1 ? problem(503, 'OVERLOADED', { 'carpal-retry-after-ms': '1000' }) : json({ id: UUID }, 201),
    );
    await api.api('admin.taxonomy_node_create', { body: { reason: 'new brand' } as never });
    expect(seen).toHaveLength(2);
    const key = seen[0]!.headers.get('idempotency-key');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.headers.get('idempotency-key')).toBe(key);
    expect(sleeps).toEqual([1000]);
  });

  it('never retries a non-IDEM write', async () => {
    const { api, seen } = setup(() => problem(503, 'OVERLOADED'));
    await expect(api.api('admin.user_status', { path: { user_id: UUID }, body: { status: 'active', reason: 'x' } })).rejects.toBeInstanceOf(
      ApiProblem,
    );
    expect(seen).toHaveLength(1);
  });

  it('sends If-Match on ETAG writes from the argument or the ETag cache', async () => {
    const { api, seen } = setup(() => json({}, 200, { etag: '"v4"' }));
    await api.api('admin.taxonomy_node_update', { path: { node_id: UUID }, body: { reason: 'x' } as never, ifMatch: '"v3"' });
    expect(seen[0]!.headers.get('if-match')).toBe('"v3"');
    await api.api('admin.taxonomy_node_update', { path: { node_id: UUID }, body: { reason: 'x' } as never });
    expect(seen[1]!.headers.get('if-match')).toBe('"v4"');
  });
});

describe('admin client: outcomes and problems', () => {
  it('act(): applied, pending four-eyes change (202 PendingChange) or accepted job (202 Job)', async () => {
    const change = {
      change_id: UUID,
      op_id: 'admin.flag_update',
      summary: 'kill switch off',
      requested_by_display: 'Sara',
      requested_at: '2026-11-09T10:00:00Z',
      reason: 'x',
      status: 'pending',
      expires_at: '2026-11-10T10:00:00Z',
    };
    const job = { id: UUID, kind: 'data_export', status: 'queued', created_at: 'x', updated_at: 'x', version: 1, expires_at: 'x' };
    const answers = [json({ key: 'k', enabled: true }), json(change, 202), json(job, 202, { 'carpal-poll-after-ms': '1500' })];
    const { api } = setup(() => answers.shift()!);
    const body = { reason: 'pilot' } as never;
    expect(await api.act('admin.flag_update', { path: { key: 'k' }, body })).toMatchObject({ kind: 'applied', data: { key: 'k' } });
    expect(await api.act('admin.flag_update', { path: { key: 'k' }, body })).toMatchObject({
      kind: 'pending',
      change: { change_id: UUID },
    });
    expect(await api.act('admin.dsr_export', { path: { request_id: UUID }, body: { reason: 'r' }, purpose: `dsr:${UUID}` })).toMatchObject({
      kind: 'accepted',
      job: { status: 'queued' },
      pollAfterMs: 1500,
    });
  });

  it('maps STEP_UP_REQUIRED with its challenge, separation of duties and version preconditions', async () => {
    const answers = [
      problem(401, 'STEP_UP_REQUIRED', {
        'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600',
      }),
      problem(403, 'SELF_APPROVAL_FORBIDDEN'),
      problem(412, 'VERSION_MISMATCH'),
      problem(428, 'PRECONDITION_REQUIRED'),
      problem(403, 'FORBIDDEN'),
    ];
    const { api, onSessionEnded } = setup(() => answers.shift()!);
    const decide = () =>
      api.api('admin.four_eyes_decide', { path: { change_id: UUID }, body: { decision: 'approve', reason: 'ok' } as never });
    const e1 = (await decide().catch((e: unknown) => e)) as ApiProblem;
    expect(e1.stepUp).toEqual({ acrValues: 'aal3', maxAgeS: 600 });
    expect(onSessionEnded).not.toHaveBeenCalled();
    expect(((await decide().catch((e: unknown) => e)) as ApiProblem).selfApproval).toBe(true);
    expect(((await decide().catch((e: unknown) => e)) as ApiProblem).preconditionFailed).toBe(true);
    expect(((await decide().catch((e: unknown) => e)) as ApiProblem).preconditionFailed).toBe(true);
    expect(((await decide().catch((e: unknown) => e)) as ApiProblem).forbidden).toBe(true);
  });

  it('reports a session that ended (401 SESSION_ENDED or UNAUTHENTICATED)', async () => {
    const answers = [problem(401, 'SESSION_ENDED'), problem(401, 'UNAUTHENTICATED')];
    const { api, onSessionEnded } = setup(() => answers.shift()!);
    await expect(api.api('admin.flags_list')).rejects.toMatchObject({ signedOut: true });
    await expect(api.api('admin.flags_list')).rejects.toMatchObject({ signedOut: true });
    expect(onSessionEnded).toHaveBeenCalledTimes(2);
  });

  it('pollUntil waits what the server asks and stops when done or after maxPolls', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const read = async () => ({ data: ++n, pollAfterMs: n === 1 ? 1500 : null });
    expect(await pollUntil(read, (d) => d >= 3, { sleep: async (ms) => void sleeps.push(ms), fallbackMs: 700 })).toBe(3);
    expect(sleeps).toEqual([1500, 700]);
    await expect(
      pollUntil(
        async () => ({ data: 0, pollAfterMs: null }),
        () => false,
        { maxPolls: 2, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'POLL_TIMEOUT',
    });
  });
});

describe('browser transport', () => {
  it('calls /api with CSRF on writes, the page language and no-store; fetches a new CSRF token once when refused', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let csrfN = 0;
    const doFetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/bff/csrf') return json({ csrf_token: `t${++csrfN}` });
      const token = new Headers(init.headers).get('x-csrf-token');
      if (init.method === 'POST' && token === 't1') return json({ code: 'CSRF_FAILED', reason: 'token' }, 403);
      return json({ ok: true });
    }) as typeof fetch;
    const transport = browserTransport({ csrf: createCsrfSource(doFetch), locale: () => 'en', fetch: doFetch });
    const get = await transport({ opId: 'admin.flags_list', method: 'GET', path: '/v1/admin/flags', search: '', headers: new Headers() });
    expect(get.status).toBe(200);
    expect(calls[0]!.url).toBe('/api/v1/admin/flags');
    expect(new Headers(calls[0]!.init.headers).get('x-csrf-token')).toBeNull();
    expect(new Headers(calls[0]!.init.headers).get('accept-language')).toBe('en');
    expect(calls[0]!.init.cache).toBe('no-store');
    const post = await transport({
      opId: 'admin.user_status',
      method: 'POST',
      path: `/v1/admin/users/${UUID}/status`,
      search: '',
      headers: new Headers(),
      body: '{}',
    });
    expect(post.status).toBe(200);
    const posts = calls.filter((c) => c.init.method === 'POST').map((c) => new Headers(c.init.headers).get('x-csrf-token'));
    expect(posts).toEqual(['t1', 't2']);
  });
});
