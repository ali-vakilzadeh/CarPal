// AC3.T7 unit tests of the OAuth client (/bff/login, /bff/reauth, /bff/oauth/callback, /bff/logout), the session view,
// pending actions and the /id proxy, against the fake auth host and admin-api.
import { describe, expect, it } from 'vitest';
import { readResumeCookie, restartUrl, resumeUrl } from './auth-proxy';
import { safeReturnTo } from './oauth/flow';
import { ISSUER, ORIGIN, STAFF_ID, testBff } from './test-support';

type View = {
  signed_in: boolean;
  staff: { id: string; display_name: string; roles: string[]; locale: string; acr: string } | null;
  locale: string | null;
  idle_expires_at: string | null;
  expires_at: string | null;
  pending_intents: { id: string; type: string }[];
};
const MIN = 60_000;

describe('safeReturnTo', () => {
  it.each([
    ['/queue?tab=mine#top', '/queue?tab=mine#top'],
    ['/', '/'],
    ['https://evil.example/x', '/'],
    ['//evil.example/x', '/'],
    ['/\\evil.example', '/'],
    ['/bff/logout', '/'],
    ['/api/v1/admin/me', '/'],
    ['/id/signin', '/'],
    ['/identity', '/identity'],
    ['/x\ny', '/'],
    [null, '/'],
  ])('%s → %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN)).toBe(expected);
  });
});

describe('/bff/login', () => {
  it('starts code + PKCE at aal3 through the same-origin /id proxy and sets a browser-session cookie', async () => {
    const { browser } = await testBff();
    const res = await browser.fetch('/bff/login?return_to=%2Fflags', { headers: { 'accept-language': 'en-GB,en;q=0.9' } });
    expect(res.status).toBe(303);
    const u = new URL(res.headers.get('location')!);
    expect(`${u.origin}${u.pathname}`).toBe(`${ORIGIN}/id/oauth/authorize`);
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: 'cp-web-admin',
      redirect_uri: `${ORIGIN}/bff/oauth/callback`,
      scope: 'openid offline_access',
      code_challenge_method: 'S256',
      acr_values: 'aal3',
      ui_locales: 'en',
    });
    expect(q.prompt).toBeUndefined();
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-cpa_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict; HttpOnly$/);
  });

  it('takes the language from the console cookie first, and uses the registered redirect URI in dev', async () => {
    const { browser } = await testBff({ redirectUri: 'https://localhost:3200/bff/oauth/callback' });
    browser.cookies.set('cpa_locale', 'fa');
    const res = await browser.fetch('/bff/login', { headers: { 'accept-language': 'en' } });
    const q = new URL(res.headers.get('location')!).searchParams;
    expect(q.get('ui_locales')).toBe('fa');
    expect(q.get('redirect_uri')).toBe('https://localhost:3200/bff/oauth/callback');
  });

  it('refuses other methods', async () => {
    const { browser } = await testBff();
    expect((await browser.fetch('/bff/login', { method: 'POST' })).status).toBe(405);
  });
});

describe('/bff/oauth/callback', () => {
  it('exchanges the code (DPoP-bound), demands aal3, loads admin.staff_me, rotates the session and returns to the page', async () => {
    const { browser, backend } = await testBff();
    await browser.csrf();
    const pre = browser.cookies.get('__Host-cpa_sid');
    const res = await browser.signIn(backend, { returnTo: '/flags' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/flags');
    expect(browser.cookies.get('__Host-cpa_sid')).not.toBe(pre);
    const token = backend.calls.find((c) => c.body.includes('grant_type=authorization_code'))!;
    expect(token.headers.get('dpop')).toBeTruthy();
    expect(new URLSearchParams(token.body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = (await (await browser.fetch('/bff/session')).json()) as View;
    expect(view).toMatchObject({
      signed_in: true,
      staff: { id: STAFF_ID, display_name: 'Sara Staff', roles: ['ADM', 'CRV'], locale: 'en', acr: 'aal3' },
      locale: 'en',
    });
    expect(Date.parse(view.idle_expires_at!) - Date.now()).toBeGreaterThan(29 * MIN);
    expect(Date.parse(view.expires_at!) - Date.now()).toBeGreaterThan(7.9 * 60 * MIN);
  });

  it("sets the staff member's language cookie at sign-in, but never over a language this browser chose (GD-05)", async () => {
    const first = await testBff();
    const res = await first.browser.signIn(first.backend);
    expect(res.headers.getSetCookie()).toContain('cpa_locale=en; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(first.browser.cookies.get('cpa_locale')).toBe('en');

    const chosen = await testBff();
    chosen.browser.cookies.set('cpa_locale', 'fa');
    const again = await chosen.browser.signIn(chosen.backend);
    expect(again.headers.getSetCookie().some((c) => c.startsWith('cpa_locale='))).toBe(false);
    expect(chosen.browser.cookies.get('cpa_locale')).toBe('fa');
  });

  it('the pre-session id no longer works after sign-in (no fixation)', async () => {
    const { browser, backend, bff } = await testBff();
    await browser.csrf();
    const pre = browser.cookies.get('__Host-cpa_sid')!;
    await browser.signIn(backend);
    const old = await bff.handle(new Request(`${ORIGIN}/bff/session`, { headers: { cookie: `__Host-cpa_sid=${pre}` } }));
    expect(((await old.json()) as View).signed_in).toBe(false);
  });

  it('refuses a sign-in below aal3 and revokes its tokens', async () => {
    const { browser, backend } = await testBff();
    const res = await browser.signIn(backend, { acr: 'aal2', returnTo: '/flags' });
    expect(res.headers.get('location')).toBe('/flags?signin=step_up');
    expect(backend.revoked).toHaveLength(1);
    expect(((await (await browser.fetch('/bff/session')).json()) as View).signed_in).toBe(false);
  });

  it('refuses an account without a staff role (admin.staff_me 403) and revokes its tokens', async () => {
    const { browser, backend } = await testBff();
    backend.staffRoles.set('01937000-0000-7000-8000-0000000000ff', []);
    const res = await browser.signIn(backend, { sub: '01937000-0000-7000-8000-0000000000ff' });
    expect(res.headers.get('location')).toBe('/queue?signin=not_staff');
    expect(backend.revoked).toHaveLength(1);
  });

  it('rejects an unknown state, a wrong issuer, a used state and an ID token with another nonce', async () => {
    const { browser, backend } = await testBff();
    const login = await browser.fetch('/bff/login?return_to=%2Fflags');
    const q = new URL(login.headers.get('location')!).searchParams;
    const code = backend.issueCode({ nonce: q.get('nonce')! });
    expect((await browser.fetch(`/bff/oauth/callback?code=${code}&state=nope`)).headers.get('location')).toBe('/?signin=state');
    expect(
      (await browser.fetch(`/bff/oauth/callback?code=${code}&state=${q.get('state')}&iss=https://evil.example`)).headers.get('location'),
    ).toBe('/flags?signin=issuer');
    expect((await browser.fetch(`/bff/oauth/callback?code=${code}&state=${q.get('state')}`)).headers.get('location')).toBe(
      '/?signin=state',
    );
    const again = new URL((await browser.fetch('/bff/login')).headers.get('location')!).searchParams;
    backend.idTokenNonce = 'other';
    const c2 = backend.issueCode({ nonce: again.get('nonce')! });
    expect((await browser.fetch(`/bff/oauth/callback?code=${c2}&state=${again.get('state')}&iss=${ISSUER}`)).headers.get('location')).toBe(
      '/?signin=failed',
    );
  });

  it('maps a cancelled sign-in and a missing pre-session', async () => {
    const { browser } = await testBff();
    const login = await browser.fetch('/bff/login?return_to=%2Fflags');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    expect((await browser.fetch(`/bff/oauth/callback?error=access_denied&state=${state}`)).headers.get('location')).toBe(
      '/flags?signin=cancelled',
    );
    browser.cookies.clear();
    expect((await browser.fetch(`/bff/oauth/callback?code=x&state=y`)).headers.get('location')).toBe('/?signin=expired');
  });
});

describe('/bff/reauth (step-up, GD-11)', () => {
  it('asks for a new authentication (prompt=login) at aal3 and keeps the saved action', async () => {
    const { browser, backend, clock } = await testBff();
    await browser.signIn(backend);
    const csrf = await browser.csrf();
    const saved = await browser.fetch('/bff/intents', {
      method: 'POST',
      body: JSON.stringify({ type: 'flags.update', target: 'featured.enabled', return_to: '/flags', draft: { value: false } }),
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
    });
    expect(saved.status).toBe(201);
    const { intent_id } = (await saved.json()) as { intent_id: string };
    const start = await browser.fetch(`/bff/reauth?return_to=%2Fflags&intent=${intent_id}`);
    const q = new URL(start.headers.get('location')!).searchParams;
    expect(q.get('prompt')).toBe('login');
    expect(q.get('acr_values')).toBe('aal3');
    const code = backend.issueCode({ nonce: q.get('nonce')!, authTime: Math.floor(clock.now / 1000) });
    const back = await browser.fetch(`/bff/oauth/callback?code=${code}&state=${q.get('state')}&iss=${ISSUER}`);
    expect(back.headers.get('location')).toBe('/flags');
    // The first sign-in's refresh token is revoked; the action replays once.
    expect(backend.revoked).toHaveLength(1);
    const csrf2 = await browser.csrf();
    const consume = () => browser.fetch(`/bff/intents/${intent_id}/consume`, { method: 'POST', headers: { 'x-csrf-token': csrf2 } });
    const first = await consume();
    expect(await first.json()).toMatchObject({
      type: 'flags.update',
      target: 'featured.enabled',
      return_to: '/flags',
      draft: { value: false },
    });
    expect((await consume()).status).toBe(404);
  });

  it('refuses a step-up without a new authentication, or by another staff member, and keeps the first session', async () => {
    const { browser, backend, clock } = await testBff();
    await browser.signIn(backend);
    clock.now += 10 * MIN;
    const stale = await browser.signIn(backend, { reauth: true, authTime: Math.floor(clock.now / 1000) - 600, returnTo: '/flags' });
    expect(stale.headers.get('location')).toBe('/flags?signin=step_up');
    const other = await browser.signIn(backend, {
      reauth: true,
      sub: '01937000-0000-7000-8000-000000000002',
      authTime: Math.floor(clock.now / 1000),
      returnTo: '/flags',
    });
    expect(other.headers.get('location')).toBe('/flags?signin=account');
    expect(backend.revoked).toHaveLength(2);
    const view = (await (await browser.fetch('/bff/session')).json()) as View;
    expect(view.signed_in).toBe(true);
    expect(view.staff!.id).toBe(STAFF_ID);
  });

  it('starting a step-up does not count as activity', async () => {
    const { browser, backend, clock } = await testBff();
    await browser.signIn(backend);
    const idle1 = ((await (await browser.fetch('/bff/session')).json()) as View).idle_expires_at;
    clock.now += 5 * MIN;
    await browser.fetch('/bff/reauth?return_to=%2Fflags');
    expect(((await (await browser.fetch('/bff/session')).json()) as View).idle_expires_at).toBe(idle1);
  });

  it('restart: an expired sign-in starts again with the same return path; unknown states go home', async () => {
    const { browser } = await testBff();
    const first = await browser.fetch('/bff/login?return_to=%2Fflags');
    const state = new URL(first.headers.get('location')!).searchParams.get('state')!;
    const again = await browser.fetch(`/bff/login/restart?state=${state}`);
    expect(again.status).toBe(303);
    const newState = new URL(again.headers.get('location')!).searchParams.get('state');
    expect(newState).not.toBe(state);
    expect(new URL((await browser.fetch('/bff/login/restart?state=nope')).headers.get('location')!).searchParams.get('acr_values')).toBe(
      'aal3',
    );
  });
});

describe('/bff/logout, /bff/session, /bff/csrf', () => {
  it('logout needs CSRF, revokes the refresh token, drops the session and clears the cookie', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    expect((await browser.fetch('/bff/logout', { method: 'POST' })).status).toBe(403);
    const csrf = await browser.csrf();
    const res = await browser.fetch('/bff/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(backend.revoked).toHaveLength(1);
    expect(((await (await browser.fetch('/bff/session')).json()) as View).signed_in).toBe(false);
    expect((await browser.fetch('/bff/logout', { method: 'GET' })).status).toBe(405);
  });

  it('a session view never creates a session and carries no token; csrf creates one pre-session', async () => {
    const { browser, store } = await testBff();
    const view = (await (await browser.fetch('/bff/session')).json()) as View;
    expect(view).toEqual({
      signed_in: false,
      staff: null,
      locale: null,
      idle_expires_at: null,
      expires_at: null,
      pending_intents: [],
      server_time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown as string,
    });
    expect(store.size).toBe(0);
    const a = await browser.csrf();
    expect(await browser.csrf()).toBe(a);
    expect(store.size).toBe(1);
  });

  it('pending actions need a staff session, CSRF, a same-origin return path, and a bounded size', async () => {
    const { browser, backend } = await testBff();
    const csrf = await browser.csrf();
    const post = (body: string, token = csrf) =>
      browser.fetch('/bff/intents', { method: 'POST', body, headers: { 'x-csrf-token': token, 'content-type': 'application/json' } });
    expect((await post('{"type":"x.y","return_to":"/flags"}')).status).toBe(401);
    await browser.signIn(backend);
    const token = await browser.csrf();
    expect((await post('{"type":"x.y","return_to":"/flags"}', 'wrong')).status).toBe(403);
    expect((await post('{"type":"x.y","return_to":"https://evil.example/"}', token)).status).toBe(400);
    expect((await post('{"type":"X","return_to":"/flags"}', token)).status).toBe(400);
    expect((await post(JSON.stringify({ type: 'x.y', return_to: '/flags', draft: 'x'.repeat(9000) }), token)).status).toBe(413);
    expect((await post('{"type":"x.y","return_to":"/flags"}', token)).status).toBe(201);
  });

  it('unknown BFF paths are 404 problem+json with no-store', async () => {
    const { browser } = await testBff();
    const res = await browser.fetch('/bff/nothing');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('/id proxy', () => {
  it('forwards authorize with only the interaction cookie, and passes back only that cookie and the resume cookie', async () => {
    const { browser, backend } = await testBff();
    await browser.csrf();
    browser.cookies.set('__Host-cp_ia', 'ia-0');
    const res = await browser.fetch('/id/oauth/authorize?client_id=cp-web-admin&state=s');
    expect(res.status).toBe(302);
    const sent = backend.calls.find((c) => c.url.startsWith('http://auth.test/oauth/authorize'))!;
    expect(sent.headers.get('cookie')).toBe('__Host-cp_ia=ia-0');
    const query = Buffer.from('client_id=cp-web-admin&state=s').toString('base64url');
    expect(res.headers.getSetCookie()).toEqual([
      '__Host-cp_ia=ia-1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800',
      `__Host-cpa_iar=ia-1.${query}; Path=/; Secure; SameSite=Lax; HttpOnly; Max-Age=1800`,
    ]);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/id/signin?interaction_id=ia-1`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forwards the staff passkey enrolment and the sign-in steps with CarPal-Client, and refuses cross-origin posts', async () => {
    const { browser, backend } = await testBff();
    for (const path of [
      '/id/v1/auth/signin',
      '/id/v1/auth/passkey-enrolment/options',
      '/id/v1/auth/passkey-enrolment',
      '/id/v1/auth/mfa/verify',
    ]) {
      const ok = await browser.fetch(path, {
        method: 'POST',
        body: '{"interaction_id":"x"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(ok.status, path).toBe(200);
    }
    expect(backend.calls.find((c) => c.url === 'http://auth.test/v1/auth/signin')!.headers.get('carpal-client')).toBe(
      'cp-web-admin/0.1.0 (web 1.0)',
    );
    const foreign = await browser.fetch('/id/v1/auth/signin', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
  });

  it('keeps the token and revocation endpoints server-side, and unknown paths 404', async () => {
    const { browser } = await testBff();
    expect((await browser.fetch('/id/oauth/token', { method: 'POST', body: 'grant_type=client_credentials' })).status).toBe(404);
    expect((await browser.fetch('/id/oauth/revoke', { method: 'POST', body: 'token=x' })).status).toBe(404);
    expect((await browser.fetch('/id/v1/auth/nothing', { method: 'POST' })).status).toBe(404);
    expect((await browser.fetch('/id/.well-known/openid-configuration')).status).toBe(200);
  });

  it("reads the resume cookie back, and restarts this BFF's own sign-ins at /bff/login/restart", () => {
    const q =
      'response_type=code&client_id=cp-web-admin&redirect_uri=http%3A%2F%2Flocalhost%3A3200%2Fbff%2Foauth%2Fcallback&state=st&nonce=n&code_challenge=c&code_challenge_method=S256&acr_values=aal3&prompt=login&ui_locales=fa';
    const cookie = `__Host-cpa_iar=ia-1.${Buffer.from(q).toString('base64url')}`;
    expect(readResumeCookie(cookie, 'ia-2')).toBeNull();
    expect(readResumeCookie(`__Host-cp_iar=ia-1.${Buffer.from(q).toString('base64url')}`, 'ia-1')).toBeNull();
    const info = readResumeCookie(cookie, 'ia-1')!;
    const resume = new URL(resumeUrl(info), ORIGIN);
    expect(resume.searchParams.get('prompt')).toBeNull();
    expect(resume.searchParams.get('acr_values')).toBe('aal3');
    expect(restartUrl(info, { origin: ORIGIN })).toBe('/bff/login/restart?state=st');
  });

  it('maps the registered https callback back to the http dev origin (OQ-11)', async () => {
    const { rewriteLocation } = await import('./auth-proxy');
    const dev = {
      config: { origin: ORIGIN, authUrl: 'http://auth.test', redirectUri: 'https://localhost:3200/bff/oauth/callback' } as never,
      issuer: async () => ISSUER,
    };
    expect(await rewriteLocation('https://localhost:3200/bff/oauth/callback?code=1&state=s', dev)).toBe(
      'http://localhost:3200/bff/oauth/callback?code=1&state=s',
    );
    expect(await rewriteLocation(`${ISSUER}/signin?interaction_id=x`, dev)).toBe(`${ORIGIN}/id/signin?interaction_id=x`);
    expect(await rewriteLocation('https://id.carpals.ir.evil.example/x', dev)).toBe('https://id.carpals.ir.evil.example/x');
  });
});
