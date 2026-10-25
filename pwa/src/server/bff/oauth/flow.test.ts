import { describe, expect, it } from 'vitest';
import { ISSUER, ORIGIN, testBff } from '../test-support';
import { safeReturnTo } from './flow';

describe('safeReturnTo', () => {
  it.each([
    ['/en/garage?tab=docs#x', '/en/garage?tab=docs#x'],
    ['//evil.example/x', '/fa'],
    ['/\\evil.example', '/fa'],
    ['https://evil.example/', '/fa'],
    ['javascript:alert(1)', '/fa'],
    ['/en/a\nb', '/fa'],
    ['/bff/logout', '/fa'],
    ['/api/v1/me', '/fa'],
    ['/id/oauth/authorize?x', '/fa'],
    [null, '/fa'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnTo(input, ORIGIN, '/fa')).toBe(expected);
  });
});

describe('/bff/login', () => {
  it('starts authorization code + PKCE through the same-origin /id proxy and sets the session cookie', async () => {
    const { browser } = await testBff();
    const res = await browser.fetch('/bff/login?return_to=%2Fen%2Fgarage');
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ORIGIN}/id/oauth/authorize`);
    const q = Object.fromEntries(loc.searchParams);
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: 'cp-web-consumer',
      redirect_uri: `${ORIGIN}/bff/oauth/callback`,
      scope: 'openid offline_access',
      code_challenge_method: 'S256',
      ui_locales: 'en',
    });
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.acr_values).toBeUndefined();
    expect(q.prompt).toBeUndefined();
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-cp_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict; HttpOnly; Max-Age=604800$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('asks for step-up with acr_values and prompt=login (BA-11)', async () => {
    const { browser } = await testBff();
    const loc = new URL((await browser.fetch('/bff/login?step_up=aal2&return_to=/fa/settings')).headers.get('location')!);
    expect(loc.searchParams.get('acr_values')).toBe('aal2');
    expect(loc.searchParams.get('prompt')).toBe('login');
    expect(loc.searchParams.get('ui_locales')).toBe('fa');
  });

  it('refuses other methods', async () => {
    const { browser } = await testBff();
    expect((await browser.fetch('/bff/login', { method: 'POST' })).status).toBe(405);
  });
});

describe('/bff/oauth/callback', () => {
  it('exchanges the code, verifies the ID token, rotates the session id and returns to the page', async () => {
    const { browser, backend } = await testBff();
    await browser.fetch('/bff/csrf');
    const before = browser.cookies.get('__Host-cp_sid');
    const res = await browser.signIn(backend, { returnTo: '/en/garage' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/garage');
    const after = browser.cookies.get('__Host-cp_sid');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    const token = backend.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/bff/oauth/callback`);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.headers.get('carpal-client')).toBe('cp-web-consumer/0.1.0 (web 1.0)');

    const session = await (await browser.fetch('/bff/session')).json();
    expect(session).toEqual({
      signed_in: true,
      user: { id: 'user-1', display_name: 'Sara', acr: 'aal1', auth_time: expect.any(Number) },
      locale: 'en',
      pending_intents: [],
    });
    expect(JSON.stringify(session)).not.toMatch(/at-|cprt_|eyJ/);
  });

  it('the old session id no longer works after sign-in (no fixation)', async () => {
    const { browser, backend, bff } = await testBff();
    await browser.fetch('/bff/csrf');
    const before = browser.cookies.get('__Host-cp_sid')!;
    await browser.signIn(backend);
    const stale = await bff.handle(new Request(`${ORIGIN}/bff/session`, { headers: { cookie: `__Host-cp_sid=${before}` } }));
    expect((await stale.json()).signed_in).toBe(false);
  });

  it('rejects an unknown state, a wrong issuer and an ID token with another nonce', async () => {
    const { browser, backend } = await testBff();
    const login = new URL((await browser.fetch('/bff/login?return_to=/en')).headers.get('location')!);
    const state = login.searchParams.get('state')!;
    const nonce = login.searchParams.get('nonce')!;

    const wrongState = await browser.fetch(`/bff/oauth/callback?code=${backend.issueCode({ nonce })}&state=nope`);
    expect(wrongState.headers.get('location')).toBe('/en?signin=state');

    const wrongIss = await browser.fetch(
      `/bff/oauth/callback?code=${backend.issueCode({ nonce })}&state=${state}&iss=https://evil.example`,
    );
    expect(wrongIss.headers.get('location')).toBe('/en?signin=issuer');
    // The state was used up by the failed attempt.
    const reused = await browser.fetch(`/bff/oauth/callback?code=${backend.issueCode({ nonce })}&state=${state}&iss=${ISSUER}`);
    expect(reused.headers.get('location')).toBe('/en?signin=state');

    const login2 = new URL((await browser.fetch('/bff/login?return_to=/en')).headers.get('location')!);
    backend.idTokenNonce = 'another-nonce';
    const badNonce = await browser.fetch(
      `/bff/oauth/callback?code=${backend.issueCode({ nonce: login2.searchParams.get('nonce')! })}&state=${login2.searchParams.get('state')}&iss=${ISSUER}`,
    );
    expect(badNonce.headers.get('location')).toBe('/en?signin=failed');
    expect((await (await browser.fetch('/bff/session')).json()).signed_in).toBe(false);
  });

  it('maps a cancelled sign-in and a missing session', async () => {
    const { browser, bff } = await testBff();
    const login = new URL((await browser.fetch('/bff/login?return_to=/fa/garage')).headers.get('location')!);
    const cancelled = await browser.fetch(`/bff/oauth/callback?error=access_denied&state=${login.searchParams.get('state')}`);
    expect(cancelled.headers.get('location')).toBe('/fa/garage?signin=cancelled');
    const noSession = await bff.handle(new Request(`${ORIGIN}/bff/oauth/callback?code=x&state=y`));
    expect(noSession.headers.get('location')).toBe('/fa?signin=expired');
  });

  it('a step-up that did not reach the asked level is refused and its tokens revoked', async () => {
    const { browser, backend } = await testBff();
    const res = await browser.signIn(backend, { returnTo: '/en/settings', stepUp: 'aal2', acr: 'aal1' });
    expect(res.headers.get('location')).toBe('/en/settings?signin=step_up');
    expect(backend.revoked).toHaveLength(1);
  });

  it('a step-up replaces the previous sign-in and revokes its refresh token', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    const first = [...backend.refreshTokens][0]!;
    const res = await browser.signIn(backend, { stepUp: 'aal2', acr: 'aal2' });
    expect(res.headers.get('location')).toBe('/en/garage');
    expect(backend.revoked).toEqual([first]);
    expect((await (await browser.fetch('/bff/session')).json()).user.acr).toBe('aal2');
  });
});

describe('/bff/logout', () => {
  it('needs CSRF, revokes the refresh token, drops the session and clears the cookie', async () => {
    const { browser, backend } = await testBff();
    await browser.signIn(backend);
    expect((await browser.fetch('/bff/logout', { method: 'POST' })).status).toBe(403);
    const csrf = await browser.csrf();
    const res = await browser.fetch('/bff/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-cp_sid=; .*Max-Age=0/);
    expect(backend.revoked).toHaveLength(1);
    expect(backend.revoked[0]).toMatch(/^cprt_/);
    expect((await (await browser.fetch('/bff/session')).json()).signed_in).toBe(false);
  });
});
