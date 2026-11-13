// AC3.T7 unit tests of the forwarder (/api/v1/admin/*) against the fake backend: allowlist, header hygiene, purpose and
// reason headers, CSRF, DPoP-bound calls, token renewal, single-flight refresh and the session's idle and absolute end.
import { describe, expect, it } from 'vitest';
import { REASON_HEADER } from './forwarder';
import { AUDIENCE, decodeProof, problemResponse, testBff, type TestBff } from './test-support';

const UUID = '0193a5b0-0000-7000-8000-00000000000a';
const MIN = 60_000;

async function signedIn(): Promise<TestBff & { csrf: string }> {
  const t = await testBff();
  t.backend.api.handler = (r) => (r.url.startsWith('http://admin.test/v1/admin/flags') ? Response.json({ items: [] }) : undefined);
  const cb = await t.browser.signIn(t.backend);
  expect(cb.status).toBe(303);
  return { ...t, csrf: await t.browser.csrf() };
}

const adminCalls = (t: TestBff) => t.backend.calls.filter((c) => c.url.startsWith('http://admin.test/') && !c.url.endsWith('/v1/admin/me'));

describe('forwarder: allowlist and session', () => {
  it('refuses unknown routes, consumer paths, wrong methods, non-canonical paths and oversized bodies without calling the backend', async () => {
    const t = await signedIn();
    const before = t.backend.calls.length;
    const post = { method: 'POST', headers: { 'x-csrf-token': t.csrf } };
    expect((await t.browser.fetch('/api/v1/me')).status).toBe(404);
    expect((await t.browser.fetch('/api/v1/config/client')).status).toBe(404);
    expect((await t.browser.fetch('/api/v1/admin/nothing')).status).toBe(404);
    expect((await t.browser.fetch('/api/v2/admin/flags')).status).toBe(404);
    expect((await t.browser.fetch('/api')).status).toBe(404);
    expect((await t.browser.fetch('/api/v1/admin//flags')).status).toBe(404);
    const wrong = await t.browser.fetch('/api/v1/admin/flags', post);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    const big = await t.browser.fetch(`/api/v1/admin/flags/x`, { ...post, method: 'PATCH', body: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const res = await t.browser.fetch('/api/v1/me');
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(t.backend.calls.length).toBe(before);
  });

  it('answers 401 UNAUTHENTICATED without a staff session, before any backend call', async () => {
    const t = await testBff();
    const res = await t.browser.fetch('/api/v1/admin/flags');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(t.backend.calls).toHaveLength(0);
  });

  it('enforces CSRF, Origin and Sec-Fetch-Site on writes and refuses cross-site reads', async () => {
    const t = await signedIn();
    const patch = (headers: Record<string, string>, extra: { site?: string } = {}) =>
      t.browser.fetch('/api/v1/admin/flags/featured.enabled', { method: 'PATCH', body: '{}', headers, ...extra });
    const reason = async (res: Response) => ((await res.json()) as { reason: string }).reason;
    const noToken = await patch({});
    expect(noToken.status).toBe(403);
    expect(await reason(noToken)).toBe('token');
    expect(await reason(await patch({ 'x-csrf-token': 'wrong' }))).toBe('token');
    expect(await reason(await patch({ 'x-csrf-token': t.csrf, origin: 'https://evil.example' }))).toBe('origin');
    expect(await reason(await patch({ 'x-csrf-token': t.csrf }, { site: 'same-site' }))).toBe('fetch_site');
    expect((await t.browser.fetch('/api/v1/admin/flags', { site: 'cross-site' })).status).toBe(403);
    expect(adminCalls(t)).toHaveLength(0);
    t.backend.api.handler = () => Response.json({ key: 'featured.enabled' });
    expect((await patch({ 'x-csrf-token': t.csrf, 'content-type': 'application/json' })).status).toBe(200);
  });
});

describe('forwarder: what reaches admin-api and what comes back', () => {
  it('sends the DPoP-bound token with a proof for the admin-api audience, and only allowlisted headers', async () => {
    const t = await signedIn();
    t.backend.api.handler = () =>
      new Response('{"items":[]}', {
        headers: {
          'content-type': 'application/json',
          etag: '"v3"',
          'carpal-contract': '1.4.0',
          'carpal-request-id': 'r-1',
          'set-cookie': 'upstream=1',
          'dpop-nonce': 'n1',
          server: 'carpal',
          'x-powered-by': 'x',
        },
      });
    const res = await t.browser.fetch('/api/v1/admin/flags?limit=5', {
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.8',
        'carpal-timezone': 'Europe/Berlin',
        'user-agent': 'Mozilla/5.0',
        'x-forwarded-for': '1.2.3.4',
        authorization: 'Bearer stolen',
        'carpal-client': 'evil/1.0',
      },
    });
    expect(res.status).toBe(200);
    const sent = adminCalls(t).at(-1)!;
    expect(sent.url).toBe('http://admin.test/v1/admin/flags?limit=5');
    const token = /^DPoP (at-\d+)$/.exec(sent.headers.get('authorization')!)![1]!;
    const proof = decodeProof(sent.headers.get('dpop')!);
    expect(proof.claims).toMatchObject({ htm: 'GET', htu: `${AUDIENCE}/v1/admin/flags` });
    expect(proof.claims.ath).toBeTruthy();
    expect(proof.header.jwk).not.toHaveProperty('d');
    expect(sent.headers.get('carpal-client')).toBe('cp-web-admin/0.1.0 (web 1.0)');
    expect(sent.headers.get('accept-language')).toBe('en');
    expect(sent.headers.get('carpal-timezone')).toBe('Europe/Berlin');
    for (const h of ['cookie', 'user-agent', 'x-forwarded-for', 'origin', 'sec-fetch-site']) expect(sent.headers.get(h), h).toBeNull();
    expect(t.backend.boundTo.get(token)).toBeTruthy();

    expect(res.headers.get('etag')).toBe('"v3"');
    expect(res.headers.get('carpal-contract')).toBe('1.4.0');
    for (const h of ['set-cookie', 'dpop-nonce', 'server', 'x-powered-by']) expect(res.headers.get(h), h).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it("uses the staff member's language and time zone when the browser sends none", async () => {
    const t = await signedIn();
    await t.browser.fetch('/api/v1/admin/flags');
    const sent = adminCalls(t).at(-1)!;
    expect(sent.headers.get('accept-language')).toBe('en');
    expect(sent.headers.get('carpal-timezone')).toBe('Asia/Tehran');
  });

  it('passes the purpose (GD-10) only to PURP operations and only in the kind:<uuid> format', async () => {
    const t = await signedIn();
    t.backend.api.handler = () => Response.json({});
    const purpose = `case:${UUID}`;
    await t.browser.fetch(`/api/v1/admin/users/${UUID}`, { headers: { 'carpal-access-purpose': purpose } });
    expect(adminCalls(t).at(-1)!.headers.get('carpal-access-purpose')).toBe(purpose);
    // Not a PURP operation: dropped.
    await t.browser.fetch('/api/v1/admin/flags', { headers: { 'carpal-access-purpose': purpose } });
    expect(adminCalls(t).at(-1)!.headers.get('carpal-access-purpose')).toBeNull();
    const before = adminCalls(t).length;
    for (const bad of ['case:1', 'ticket:' + UUID, `case:${UUID}0`, `case:${UUID.toUpperCase()}`]) {
      const res = await t.browser.fetch(`/api/v1/admin/users/${UUID}`, { headers: { 'carpal-access-purpose': bad } });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe('purpose');
    }
    expect(adminCalls(t)).toHaveLength(before);
    // Missing: the backend answers PURPOSE_REQUIRED (passed through).
    t.backend.api.handler = () => problemResponse(400, 'PURPOSE_REQUIRED');
    const missing = await t.browser.fetch(`/api/v1/admin/users/${UUID}`);
    expect(((await missing.json()) as { code: string }).code).toBe('PURPOSE_REQUIRED');
  });

  it('passes CarPal-Reason only on DELETE operations that take a reason, as one printable line', async () => {
    const t = await signedIn();
    t.backend.api.handler = () => Response.json({ ok: true });
    const del = (reason: string) =>
      t.browser.fetch(`/api/v1/admin/taxonomy/synonyms/${UUID}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': t.csrf, 'carpal-reason': reason },
      });
    expect((await del('Duplicate%20of%20%D8%A8')).status).toBe(200);
    expect(adminCalls(t).at(-1)!.headers.get('carpal-reason')).toBe('Duplicate%20of%20%D8%A8');
    expect((await del('x'.repeat(2001))).status).toBe(400);
    expect(REASON_HEADER.test('a\nb')).toBe(false);
    // A body reason operation never gets the header.
    await t.browser.fetch('/api/v1/admin/flags/featured.enabled', {
      method: 'PATCH',
      body: '{"reason":"x"}',
      headers: { 'x-csrf-token': t.csrf, 'carpal-reason': 'header' },
    });
    expect(adminCalls(t).at(-1)!.headers.get('carpal-reason')).toBeNull();
  });

  it('passes Idempotency-Key, If-Match and the body; retry and poll delays come back unchanged (SEC-RL-5)', async () => {
    const t = await signedIn();
    t.backend.api.handler = () =>
      problemResponse(429, 'RATE_LIMITED', { 'retry-after': '3', 'carpal-retry-after-ms': '2500', 'carpal-poll-after-ms': '1000' });
    const res = await t.browser.fetch('/api/v1/admin/flags/featured.enabled', {
      method: 'PATCH',
      body: '{"value":true,"reason":"pilot"}',
      headers: { 'x-csrf-token': t.csrf, 'content-type': 'application/json', 'idempotency-key': UUID, 'if-match': '"v3"' },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('carpal-retry-after-ms')).toBe('2500');
    expect(res.headers.get('retry-after')).toBe('3');
    const sent = adminCalls(t).at(-1)!;
    expect(sent.body).toBe('{"value":true,"reason":"pilot"}');
    expect(sent.headers.get('idempotency-key')).toBe(UUID);
    expect(sent.headers.get('if-match')).toBe('"v3"');
    expect(sent.headers.get('content-type')).toBe('application/json');
  });

  it('never sends an access or refresh token to the browser', async () => {
    const t = await signedIn();
    const seen: string[] = [];
    const record = async (res: Response) => seen.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), await res.text());
    await record(await t.browser.fetch('/bff/session'));
    await record(await t.browser.fetch('/api/v1/admin/flags'));
    await record(await t.browser.fetch('/api/v1/admin/me'));
    await record(await t.browser.fetch('/bff/csrf'));
    const all = seen.join('\n');
    expect(all).not.toMatch(/at-\d+|cprt_\d+|eyJ/);
    // The session cookie, and the staff member's language set at the first sign-in (AC4, GD-05; no secret).
    expect([...t.browser.cookies.keys()].sort()).toEqual(['__Host-cpa_sid', 'cpa_locale']);
  });
});

describe('forwarder: tokens and the session lifetime', () => {
  it('renews the token once on a 401 and repeats the request', async () => {
    const t = await signedIn();
    let first = true;
    t.backend.api.handler = (r) => {
      if (!r.url.endsWith('/v1/admin/flags')) return undefined;
      if (first) {
        first = false;
        return problemResponse(401, 'UNAUTHENTICATED');
      }
      return Response.json({ items: [] });
    };
    const res = await t.browser.fetch('/api/v1/admin/flags');
    expect(res.status).toBe(200);
    const flags = adminCalls(t).filter((c) => c.url.endsWith('/v1/admin/flags'));
    expect(flags).toHaveLength(2);
    expect(flags[0]!.headers.get('authorization')).not.toBe(flags[1]!.headers.get('authorization'));
  });

  it('ends the session when the API still refuses a freshly refreshed token', async () => {
    const t = await signedIn();
    t.backend.api.handler = (r) => (r.url.endsWith('/v1/admin/flags') ? problemResponse(401, 'UNAUTHENTICATED') : undefined);
    const res = await t.browser.fetch('/api/v1/admin/flags');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('SESSION_ENDED');
    expect(((await (await t.browser.fetch('/bff/session')).json()) as { signed_in: boolean }).signed_in).toBe(false);
  });

  it('passes STEP_UP_REQUIRED through with its challenge, without refreshing', async () => {
    const t = await signedIn();
    const challenge = 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600';
    t.backend.api.handler = () => problemResponse(401, 'STEP_UP_REQUIRED', { 'www-authenticate': challenge });
    const refreshes = () => t.backend.calls.filter((c) => c.body.includes('grant_type=refresh_token')).length;
    const before = refreshes();
    const res = await t.browser.fetch(`/api/v1/admin/flags/featured.enabled`, {
      method: 'PATCH',
      body: '{}',
      headers: { 'x-csrf-token': t.csrf },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(challenge);
    expect(refreshes()).toBe(before);
  });

  it('refreshes an expired access token before the call, once for parallel requests (single flight)', async () => {
    const t = await signedIn();
    t.clock.now += 5 * MIN;
    const results = await Promise.all(Array.from({ length: 6 }, () => t.browser.fetch('/api/v1/admin/flags')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(t.backend.calls.filter((c) => c.body.includes('grant_type=refresh_token'))).toHaveLength(1);
    const refresh = t.backend.calls.find((c) => c.body.includes('grant_type=refresh_token'))!;
    // The refresh is DPoP-bound to the session key (backend GD-06) and re-reads admin.staff_me.
    expect(decodeProof(refresh.headers.get('dpop')!).claims.htu).toBe('https://id.carpals.ir/oauth/token');
    expect(t.backend.calls.filter((c) => c.url.endsWith('/v1/admin/me')).length).toBeGreaterThanOrEqual(2);
  });

  it('ends the session when the refresh token is refused (invalid_grant)', async () => {
    const t = await signedIn();
    t.backend.refreshTokens.clear();
    t.clock.now += 5 * MIN;
    const res = await t.browser.fetch('/api/v1/admin/flags');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('SESSION_ENDED');
  });

  it('idles out after 30 minutes without an API call; API calls keep it alive; /bff/session does not', async () => {
    const t = await signedIn();
    for (let i = 0; i < 4; i++) {
      t.clock.now += 25 * MIN;
      expect((await t.browser.fetch('/api/v1/admin/flags')).status).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      t.clock.now += 20 * MIN;
      await t.browser.fetch('/bff/session');
    }
    const res = await t.browser.fetch('/api/v1/admin/flags');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('ends after 8 hours whatever the activity', async () => {
    const t = await signedIn();
    t.backend.tokenLifetimeS = 3600 * 24;
    let status = 200;
    let minutes = 0;
    while (status === 200 && minutes < 10 * 60) {
      t.clock.now += 20 * MIN;
      minutes += 20;
      status = (await t.browser.fetch('/api/v1/admin/flags')).status;
    }
    expect(status).toBe(401);
    expect(minutes).toBeGreaterThan(7 * 60);
    expect(minutes).toBeLessThanOrEqual(8 * 60 + 20);
  });

  it('keeps the session view in step with admin.staff_me (roles granted or revoked meanwhile)', async () => {
    const t = await signedIn();
    const view = async () => (await (await t.browser.fetch('/bff/session')).json()) as { staff: { roles: string[] } };
    expect((await view()).staff.roles).toEqual(['ADM', 'CRV']);
    t.backend.staffRoles.set('01937000-0000-7000-8000-000000000001', ['platform_moderator']);
    expect((await t.browser.fetch('/api/v1/admin/me')).status).toBe(200);
    expect((await view()).staff.roles).toEqual(['MOD']);
  });
});
