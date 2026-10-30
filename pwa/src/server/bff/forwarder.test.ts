import { describe, expect, it } from 'vitest';
import { Browser, decodeProof, problemResponse, testBff, type Recorded } from './test-support';

const apiCalls = (calls: Recorded[]) => calls.filter((c) => c.url.startsWith('http://api.test'));

describe('forwarder (/api/v1)', () => {
  it('gives a guest a pre-session and a DPoP-bound anonymous token, created lazily', async () => {
    const { browser, backend } = await testBff();
    backend.api.handler = (r) =>
      r.url.endsWith('/v1/config/client') ? Response.json({ ok: 1 }, { headers: { 'carpal-request-id': 'r1' } }) : undefined;
    const res = await browser.fetch('/api/v1/config/client', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-cp_sid=/);
    const call = apiCalls(backend.calls)[0]!;
    expect(call.headers.get('authorization')).toMatch(/^DPoP anon-\d+$/);
    expect(call.headers.get('carpal-client')).toBe('cp-web-consumer/0.1.0 (web 1.0)');
    expect(call.headers.get('accept-language')).toBe('en');
    const proof = decodeProof(call.headers.get('dpop')!);
    expect(proof.header).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' });
    expect(proof.claims).toMatchObject({ htm: 'GET', htu: 'https://api.carpal.app/v1/config/client' });
    expect(proof.claims.ath).toBeTruthy();
    // The anonymous grant's proof names the issuer's token endpoint, not the internal host (DI-17).
    const grant = backend.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(decodeProof(grant.headers.get('dpop')!).claims.htu).toBe('https://id.carpal.app/oauth/token');
  });

  it('keeps the same DPoP key across anonymous renewals, so the anonymous principal is stable (DI-17)', async () => {
    const { browser, backend, clock, bff } = await testBff();
    backend.api.handler = () => Response.json({});
    await browser.fetch('/api/v1/config/client');
    clock.now += 16 * 60_000;
    await browser.fetch('/api/v1/config/client');
    expect(backend.anonymousJkts).toHaveLength(2);
    expect(backend.anonymousJkts[0]).toBeTruthy();
    expect(backend.anonymousJkts[1]).toBe(backend.anonymousJkts[0]);
    // Another browser gets another key.
    await new Browser(bff).fetch('/api/v1/config/client');
    expect(backend.anonymousJkts[2]).not.toBe(backend.anonymousJkts[0]);
  });

  it('strips browser headers on the way in and backend headers on the way out', async () => {
    const { browser, backend } = await testBff();
    backend.api.handler = () =>
      new Response('{"items":[]}', {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['etag', '"v3"'],
          ['carpal-poll-after-ms', '5000'],
          ['ratelimit', 'limit=300, remaining=299, reset=60'],
          ['set-cookie', 'evil=1'],
          ['dpop-nonce', 'n'],
          ['server', 'x'],
          ['x-powered-by', 'y'],
        ],
      });
    const res = await browser.fetch('/api/v1/me/vehicles?status=active', {
      headers: {
        cookie: 'other=1',
        'user-agent': 'UA',
        referer: 'https://x',
        'x-forwarded-for': '1.2.3.4',
        'carpal-timezone': 'Asia/Tehran',
        'if-match': '"v1"',
      },
    });
    const sent = apiCalls(backend.calls)[0]!;
    expect(sent.url).toBe('http://api.test/v1/me/vehicles?status=active');
    for (const h of ['cookie', 'user-agent', 'referer', 'x-forwarded-for', 'origin', 'sec-fetch-site'])
      expect(sent.headers.get(h), h).toBeNull();
    expect(sent.headers.get('carpal-timezone')).toBe('Asia/Tehran');
    expect(sent.headers.get('if-match')).toBe('"v1"');
    expect(res.headers.get('etag')).toBe('"v3"');
    expect(res.headers.get('carpal-poll-after-ms')).toBe('5000');
    expect(res.headers.get('ratelimit')).toBe('limit=300, remaining=299, reset=60');
    for (const h of ['dpop-nonce', 'server', 'x-powered-by']) expect(res.headers.get(h), h).toBeNull();
    expect(res.headers.getSetCookie().every((c) => c.startsWith('__Host-cp_sid='))).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('passes retry delays through unchanged (SEC-RL-5)', async () => {
    const { browser, backend } = await testBff();
    backend.api.handler = () => problemResponse(429, 'RATE_LIMITED', { 'carpal-retry-after-ms': '1500', 'retry-after': '2' });
    const res = await browser.fetch('/api/v1/config/client');
    expect(res.status).toBe(429);
    expect(res.headers.get('carpal-retry-after-ms')).toBe('1500');
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('sends the signed-in user token; renews it once on 401 and repeats the request', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    let first = true;
    backend.api.handler = (r) => {
      if (!r.url.endsWith('/v1/me/vehicles')) return undefined;
      if (first) {
        first = false;
        return problemResponse(401, 'UNAUTHENTICATED');
      }
      return Response.json({ id: 'v1' }, { status: 201 });
    };
    const csrf = await browser.csrf();
    const res = await browser.fetch('/api/v1/me/vehicles', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ nickname: 'x' }),
    });
    expect(res.status).toBe(201);
    const posts = apiCalls(backend.calls).filter((c) => c.url.endsWith('/v1/me/vehicles'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers.get('authorization')).not.toBe(posts[1]!.headers.get('authorization'));
    expect(posts.map((p) => p.headers.get('idempotency-key'))).toEqual(['k-1', 'k-1']);
    expect(posts[1]!.body).toBe('{"nickname":"x"}');
    expect(posts[0]!.headers.get('dpop')).toBeNull();
  });

  it('refreshes an expired access token before the call, once for parallel requests', async () => {
    const { browser, backend, clock } = await testBff();
    await browser.signIn(backend);
    backend.api.handler = () => Response.json({});
    clock.now += 6 * 60_000;
    await Promise.all([browser.fetch('/api/v1/me/vehicles'), browser.fetch('/api/v1/me/vehicles'), browser.fetch('/api/v1/me/vehicles')]);
    const refreshes = backend.calls.filter((c) => c.url.endsWith('/oauth/token') && c.body.includes('grant_type=refresh_token'));
    expect(refreshes).toHaveLength(1);
    // The rotated refresh token is the one kept: a second expiry refreshes again without reuse.
    clock.now += 6 * 60_000;
    expect((await browser.fetch('/api/v1/me/vehicles')).status).toBe(200);
    expect(backend.calls.filter((c) => c.body.includes('grant_type=refresh_token'))).toHaveLength(2);
  });

  it('ends the session when the refresh token is refused (invalid_grant)', async () => {
    const { browser, backend, clock } = await testBff();
    await browser.signIn(backend);
    backend.refreshTokens.clear();
    clock.now += 6 * 60_000;
    const res = await browser.fetch('/api/v1/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'SESSION_ENDED' });
    expect((await (await browser.fetch('/bff/session')).json()).signed_in).toBe(false);
  });

  it('refreshes the session display name from me.get and me.update (P9 Profile)', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    backend.api.handler = () => Response.json({ display_name: 'Sara M.', full_name: 'Sara Mohammadi', locale: 'fa' });
    const csrf = await browser.csrf();
    const res = await browser.fetch('/api/v1/me', {
      method: 'PATCH',
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Sara M.' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).display_name).toBe('Sara M.');
    expect((await (await browser.fetch('/bff/session')).json()).user.display_name).toBe('Sara M.');
  });

  it('passes STEP_UP_REQUIRED through with its challenge, without refreshing', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    backend.api.handler = () =>
      problemResponse(401, 'STEP_UP_REQUIRED', {
        'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal2", max_age=600',
      });
    const res = await browser.fetch('/api/v1/me/sessions');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
    expect(res.headers.get('www-authenticate')).toContain('acr_values="aal2"');
    expect(backend.calls.filter((c) => c.body.includes('grant_type=refresh_token'))).toHaveLength(0);
  });

  it('refuses unknown routes, wrong methods, non-canonical paths and oversized bodies without calling the backend', async () => {
    const { browser, backend } = await testBff();
    const csrf = await browser.csrf();
    expect((await browser.fetch('/api/v1/admin/flags')).status).toBe(404);
    expect((await browser.fetch('/api/v1/orgs/0193/locations')).status).toBe(404);
    expect((await browser.fetch('/api/v1/me/%2e%2e/admin')).status).toBe(404);
    expect((await browser.fetch('/api/v2/me')).status).toBe(404);
    const wrong = await browser.fetch('/api/v1/me', { method: 'DELETE', headers: { 'x-csrf-token': csrf } });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toContain('GET');
    expect((await browser.fetch('/api/v1/me', { method: 'OPTIONS' })).status).toBe(405);
    const big = await browser.fetch('/api/v1/me/vehicles', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
      body: 'x'.repeat(65 * 1024),
    });
    expect(big.status).toBe(413);
    expect(apiCalls(backend.calls)).toHaveLength(0);
  });

  it('forwards fleet driver routes (GD-08 b)', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    backend.api.handler = () => Response.json({ items: [] });
    expect((await browser.fetch('/api/v1/orgs/0193aaaa/fleet/vehicles')).status).toBe(200);
    expect((await browser.fetch('/api/v1/orgs/0193aaaa/fleet/members')).status).toBe(404);
  });

  it('enforces CSRF on state changes and refuses cross-site reads', async () => {
    const { browser } = await testBff();
    const csrf = await browser.csrf();
    const post = (headers: Record<string, string>, o: { site?: string; noOrigin?: boolean } = {}) =>
      browser.fetch('/api/v1/me/vehicles', { method: 'POST', headers, body: '{}', ...o });
    expect(await (await post({})).json()).toMatchObject({ code: 'CSRF_FAILED', reason: 'token' });
    expect(await (await post({ 'x-csrf-token': 'wrong' })).json()).toMatchObject({ reason: 'token' });
    expect(await (await post({ 'x-csrf-token': csrf, origin: 'https://evil.example' })).json()).toMatchObject({ reason: 'origin' });
    expect(await (await post({ 'x-csrf-token': csrf }, { noOrigin: true })).json()).toMatchObject({ reason: 'origin' });
    expect(await (await post({ 'x-csrf-token': csrf }, { site: 'same-site' })).json()).toMatchObject({ reason: 'fetch_site' });
    expect((await browser.fetch('/api/v1/me', { site: 'cross-site' })).status).toBe(403);
  });

  it('never sends an access or refresh token to the browser', async () => {
    const { browser, backend, clock } = await testBff();
    backend.api.handler = () => Response.json({ ok: true });
    const seen: string[] = [];
    const record = async (res: Response) => {
      seen.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), await res.text());
    };
    await record(await browser.fetch('/api/v1/config/client'));
    const login = await browser.fetch('/bff/login?return_to=/en');
    await record(login.clone());
    const loc = new URL(login.headers.get('location')!);
    const code = backend.issueCode({ nonce: loc.searchParams.get('nonce')! });
    await record(await browser.fetch(`/bff/oauth/callback?code=${code}&state=${loc.searchParams.get('state')}&iss=https://id.carpal.app`));
    await record(await browser.fetch('/bff/session'));
    clock.now += 6 * 60_000;
    await record(await browser.fetch('/api/v1/me/vehicles'));
    const all = seen.join('\n');
    expect(all).not.toMatch(/\b(at|anon)-\d+\b/);
    expect(all).not.toMatch(/cprt_/);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });
});
