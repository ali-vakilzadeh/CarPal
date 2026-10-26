import { describe, expect, it } from 'vitest';
import { readResumeCookie, restartUrl, resumeUrl } from './auth-proxy';
import { ISSUER, ORIGIN, testBff } from './test-support';

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('pending intents (GD-06)', () => {
  it('survive sign-in, are listed in the session view and replay once', async () => {
    const { browser, backend } = await testBff();
    const csrf = await browser.csrf();
    const saved = await browser.fetch('/bff/intents', {
      method: 'POST',
      ...json({ type: 'follow', target: 'org:0193', return_to: '/fa/shop/reza-auto', draft: { note: 'hi' } }),
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    });
    expect(saved.status).toBe(201);
    const { intent_id } = await saved.json();

    await browser.signIn(backend, { returnTo: '/fa/shop/reza-auto' });
    const session = await (await browser.fetch('/bff/session')).json();
    expect(session.pending_intents).toEqual([{ id: intent_id, type: 'follow', target: 'org:0193', return_to: '/fa/shop/reza-auto' }]);

    // The CSRF token rotated with the session.
    const csrf2 = await browser.csrf();
    expect(csrf2).not.toBe(csrf);
    const consume = () => browser.fetch(`/bff/intents/${intent_id}/consume`, { method: 'POST', headers: { 'x-csrf-token': csrf2 } });
    const first = await consume();
    expect(await first.json()).toEqual({
      id: intent_id,
      type: 'follow',
      target: 'org:0193',
      return_to: '/fa/shop/reza-auto',
      draft: { note: 'hi' },
    });
    expect((await consume()).status).toBe(404);
  });

  it('expire after 30 minutes and are capped in size, count and shape', async () => {
    const { browser, clock } = await testBff();
    const csrf = await browser.csrf();
    const save = (body: unknown) =>
      browser.fetch('/bff/intents', { method: 'POST', body: JSON.stringify(body), headers: { 'x-csrf-token': csrf } });
    expect((await save({ type: 'follow', return_to: '/fa', draft: 'x'.repeat(9000) })).status).toBe(413);
    expect((await save({ type: 'Bad Type', return_to: '/fa' })).status).toBe(400);
    expect((await save({ type: 'follow', return_to: 'https://evil.example/' })).status).toBe(400);
    // The context line for the hosted sign-in is plain text of at most 160 characters (P4).
    expect((await save({ type: 'follow', return_to: '/fa', label: 'x'.repeat(161) })).status).toBe(400);
    expect((await save({ type: 'follow', return_to: '/fa', label: 42 })).status).toBe(400);
    for (let i = 0; i < 7; i++) expect((await save({ type: 'follow', target: String(i), return_to: '/fa' })).status).toBe(201);
    const listed = (await (await browser.fetch('/bff/session')).json()).pending_intents;
    expect(listed.map((i: { target: string }) => i.target)).toEqual(['2', '3', '4', '5', '6']);
    clock.now += 31 * 60_000;
    expect((await (await browser.fetch('/bff/session')).json()).pending_intents).toEqual([]);
  });

  it('need the CSRF token', async () => {
    const { browser } = await testBff();
    await browser.csrf();
    expect((await browser.fetch('/bff/intents', { method: 'POST', body: '{}' })).status).toBe(403);
  });
});

describe('/bff/csrf and /bff/session', () => {
  it('csrf creates the pre-session once and returns the same token for it', async () => {
    const { browser, store } = await testBff();
    const a = await browser.csrf();
    const b = await browser.csrf();
    expect(a).toBe(b);
    expect(store.size).toBe(1);
  });

  it('a session view never creates a session', async () => {
    const { browser, store } = await testBff();
    const res = await browser.fetch('/bff/session');
    expect(await res.json()).toEqual({ signed_in: false, user: null, locale: null, pending_intents: [] });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('unknown BFF paths are 404', async () => {
    const { browser } = await testBff();
    expect((await browser.fetch('/bff/tokens')).status).toBe(404);
  });
});

describe('/id proxy (GD-05 dev topology)', () => {
  it('forwards authorize to the auth host with only the interaction cookie, and passes only that cookie back', async () => {
    const { browser, backend } = await testBff();
    await browser.csrf();
    browser.cookies.set('__Host-cp_ia', 'ia-0');
    const res = await browser.fetch('/id/oauth/authorize?client_id=cp-web-consumer&state=s');
    expect(res.status).toBe(302);
    const sent = backend.calls.find((c) => c.url.startsWith('http://auth.test/oauth/authorize'))!;
    expect(sent.url).toBe('http://auth.test/oauth/authorize?client_id=cp-web-consumer&state=s');
    expect(sent.headers.get('cookie')).toBe('__Host-cp_ia=ia-0');
    const query = Buffer.from('client_id=cp-web-consumer&state=s').toString('base64url');
    expect(res.headers.getSetCookie()).toEqual([
      '__Host-cp_ia=ia-1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800',
      // P4: which authorize request this interaction belongs to (the hosted sign-in re-requests it on completion).
      `__Host-cp_iar=ia-1.${query}; Path=/; Secure; SameSite=Lax; HttpOnly; Max-Age=1800`,
    ]);
    // The issuer URL of the hosted sign-in becomes the same-origin /id path.
    expect(res.headers.get('location')).toBe(`${ORIGIN}/id/signin?interaction_id=ia-1`);
  });

  it('clears the resume cookie when authorize answers the client (code or error)', async () => {
    const { browser, backend } = await testBff();
    backend.authorize.handler = () =>
      new Response(null, { status: 302, headers: { location: `${ORIGIN}/bff/oauth/callback?code=c1&state=s` } });
    browser.cookies.set('__Host-cp_iar', 'ia-1.x');
    const res = await browser.fetch('/id/oauth/authorize?state=s');
    expect(res.headers.getSetCookie()).toEqual(['__Host-cp_iar=; Path=/; Secure; SameSite=Lax; HttpOnly; Max-Age=0']);
    expect(browser.cookies.has('__Host-cp_iar')).toBe(false);
  });

  it('reads the resume cookie back: the authorize URL without prompt, and the restart for this BFF or other clients', () => {
    const q =
      'response_type=code&client_id=cp-web-consumer&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fbff%2Foauth%2Fcallback&state=st&nonce=n&code_challenge=c&code_challenge_method=S256&acr_values=aal2&prompt=login&ui_locales=fa';
    const cookie = `__Host-cp_iar=ia-1.${Buffer.from(q).toString('base64url')}`;
    expect(readResumeCookie(cookie, 'ia-2')).toBeNull();
    expect(readResumeCookie('other=1', 'ia-1')).toBeNull();
    expect(readResumeCookie('__Host-cp_iar=ia-1.%%%', 'ia-1')).toBeNull();
    const info = readResumeCookie(cookie, 'ia-1')!;
    const resume = new URL(resumeUrl(info), ORIGIN);
    expect(resume.pathname).toBe('/id/oauth/authorize');
    expect(resume.searchParams.get('prompt')).toBeNull();
    expect(resume.searchParams.get('acr_values')).toBe('aal2');
    expect(resume.searchParams.get('state')).toBe('st');
    expect(restartUrl(info, { origin: ORIGIN })).toBe('/bff/login/restart?state=st');
    // Another client's sign-in starts again with its own authorize request (a new interaction).
    const mobile = readResumeCookie(
      `__Host-cp_iar=ia-1.${Buffer.from(q.replace('localhost%3A3000', 'carpal.app')).toString('base64url')}`,
      'ia-1',
    )!;
    expect(restartUrl(mobile, { origin: ORIGIN })).toMatch(/^\/id\/oauth\/authorize\?.*&prompt=login$/);
    expect(restartUrl(null, { origin: ORIGIN })).toBe('/bff/login');
  });

  it('forwards /v1/auth/* with CarPal-Client and refuses cross-origin posts', async () => {
    const { browser, backend } = await testBff();
    const ok = await browser.fetch('/id/v1/auth/signin', {
      method: 'POST',
      body: '{"interaction_id":"x"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(200);
    const sent = backend.calls.find((c) => c.url === 'http://auth.test/v1/auth/signin')!;
    expect(sent.headers.get('carpal-client')).toBe('cp-web-consumer/0.1.0 (web 1.0)');
    expect(sent.body).toBe('{"interaction_id":"x"}');
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

  it('leaves redirects to other hosts alone', async () => {
    const { rewriteLocation } = await import('./auth-proxy');
    const d = { config: { origin: ORIGIN, authUrl: 'http://auth.test' } as never, issuer: async () => ISSUER };
    expect(await rewriteLocation('http://localhost:3000/bff/oauth/callback?code=1', d)).toBe(
      'http://localhost:3000/bff/oauth/callback?code=1',
    );
    expect(await rewriteLocation('http://auth.test/oauth/authorize?x=1', d)).toBe(`${ORIGIN}/id/oauth/authorize?x=1`);
    expect(await rewriteLocation('https://id.carpal.app.evil.example/x', d)).toBe('https://id.carpal.app.evil.example/x');
    // Dev/E2E: the registered https callback of an http PWA comes back to this origin's callback (OQ-10).
    const dev = {
      ...d,
      config: { origin: ORIGIN, authUrl: 'http://auth.test', redirectUri: 'https://localhost:3000/bff/oauth/callback' } as never,
    };
    expect(await rewriteLocation('https://localhost:3000/bff/oauth/callback?code=1&state=s', dev)).toBe(
      'http://localhost:3000/bff/oauth/callback?code=1&state=s',
    );
    expect(await rewriteLocation('https://localhost:3000/bff/oauth/callbackx', dev)).toBe('https://localhost:3000/bff/oauth/callbackx');
  });
});

describe('server-rendering credentials (cp-ssr, DI-14 fallback)', () => {
  it('caches the cp-ssr token until shortly before expiry and keeps one anonymous key', async () => {
    const { bff, backend, clock } = await testBff();
    const a = await bff.ssr.ssr();
    const b = await bff.ssr.ssr();
    expect(a.accessToken).toBe(b.accessToken);
    expect(a.kind).toBe('ssr');
    clock.now += 5 * 60_000;
    expect((await bff.ssr.ssr()).accessToken).not.toBe(a.accessToken);
    const anon1 = await bff.ssr.anonymous();
    const anon2 = await bff.ssr.anonymous(true);
    expect(anon1.dpopKey).toEqual(anon2.dpopKey);
    expect(backend.anonymousJkts[0]).toBe(backend.anonymousJkts[1]);
  });
});
