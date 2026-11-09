// AC3 (T4, T6): the BFF through the real Next.js route adapters of the production build. No backend is needed: these
// answers come from the BFF itself (the full sign-in runs in src/server/bff/bff.int.test.ts against the backend).
import { expect, test } from '@playwright/test';

test('/api answers only admin operations, as problem+json with the BFF headers', async ({ request }) => {
  for (const path of ['/api/v1/me', '/api/v1/config/client', '/api/v1/admin/nothing', '/api/anything']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['content-type']).toBe('application/problem+json');
  }
  const signedOut = await request.get('/api/v1/admin/flags');
  expect(signedOut.status()).toBe(401);
  expect((await signedOut.json()).code).toBe('UNAUTHENTICATED');
  const h = signedOut.headers();
  expect(h['cache-control']).toBe('no-store');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
});

test('a write without a CSRF token is refused before anything else', async ({ request, baseURL }) => {
  const res = await request.patch('/api/v1/admin/flags/featured.enabled', {
    data: { enabled: true, reason: 'e2e' },
    headers: { origin: baseURL!, 'sec-fetch-site': 'same-origin' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'CSRF_FAILED' });
});

test('/bff/session never creates a session; /bff/csrf creates one browser-session cookie', async ({ request }) => {
  const view = await request.get('/bff/session');
  expect(await view.json()).toEqual({
    signed_in: false,
    staff: null,
    locale: null,
    idle_expires_at: null,
    expires_at: null,
    pending_intents: [],
    server_time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });
  expect(view.headers()['set-cookie']).toBeUndefined();
  const csrf = await request.get('/bff/csrf');
  expect((await csrf.json()).csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const cookie = csrf.headers()['set-cookie']!;
  expect(cookie).toMatch(/^__Host-cpa_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict; HttpOnly$/);
});

test('/bff/login starts the aal3 sign-in on the console origin', async ({ request, baseURL }) => {
  const res = await request.get('/bff/login?return_to=%2Fflags', { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const location = new URL(res.headers()['location']!);
  expect(`${location.origin}${location.pathname}`).toBe(`${baseURL}/id/oauth/authorize`);
  expect(location.searchParams.get('client_id')).toBe('cp-web-admin');
  expect(location.searchParams.get('acr_values')).toBe('aal3');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
});
