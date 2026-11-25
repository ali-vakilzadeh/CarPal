// AC11.T4/T5: the security half of the pilot E2E suite (`pnpm e2e:pilot` runs every test tagged @pilot: the sign-in,
// the exchange rate, the kill switch, the Path 2 approval, report → case → action, verification, the deletion by
// four-eyes, and these). Against backend `pnpm dev` in strict mode (README "End-to-end tests").
//  - Every route class answers with the headers SEC-WEB and GD-12 ask for: pages, the BFF, the API forwarder, 404s.
//  - After a signed-in walk through the pilot's screens, the browser holds no token and no personal data: one
//    HttpOnly session cookie, preference cookies, localStorage keys of src/lib/prefs.ts only (no values with an email
//    or a JWT), no sessionStorage, no IndexedDB, no service worker (GD-12, SEC-ADM-7).
import { expect, test } from '@playwright/test';
import { requireBackend, signInAs } from './staff';
import { gotoReady } from './support';

test.describe.configure({ timeout: 180_000 });

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function expectApiHeaders(h: Record<string, string>, where: string) {
  expect(h['cache-control'], where).toBe('no-store');
  expect(h['x-content-type-options'], where).toBe('nosniff');
  expect(h['x-frame-options'], where).toBe('DENY');
  expect(h['content-security-policy'], where).toContain("default-src 'none'");
  expect(h['x-robots-tag'], where).toContain('noindex');
}

function expectPageHeaders(h: Record<string, string>, where: string) {
  expect(h['cache-control'], where).toBe('private, no-store');
  expect(h['x-content-type-options'], where).toBe('nosniff');
  expect(h['x-frame-options'], where).toBe('DENY');
  expect(h['referrer-policy'], where).toBe('no-referrer');
  expect(h['cross-origin-opener-policy'], where).toBe('same-origin');
  expect(h['content-security-policy'], where).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy'], where).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy'], where).toContain("object-src 'none'");
}

test('every route class answers with its security headers (AC11.T5) @pilot', async ({ request }) => {
  for (const path of ['/id/signin', '/id/signed-out']) expectPageHeaders((await request.get(path)).headers(), path);
  // A console page without a session redirects to the sign-in; the redirect carries the page headers too.
  const redirect = await request.get('/approvals', { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expectPageHeaders(redirect.headers(), '/approvals (redirect)');
  for (const [path, status] of [
    ['/bff/session', 200],
    ['/bff/csrf', 200],
    ['/api/v1/admin/me', 401],
    ['/api/v1/admin/not-an-operation', 404],
    ['/api/v1/users/me', 404],
  ] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(status);
    expectApiHeaders(res.headers(), path);
  }
});

test('after a signed-in walk the browser holds no token and no personal data (AC11.T5) @pilot', async ({ context, page }) => {
  await requireBackend();
  await signInAs(context, page, ['ADM']);
  for (const path of ['/', '/rates', '/flags', '/approvals', '/recoveries', '/staff', '/security', '/audit']) {
    const res = await gotoReady(page, path);
    expect(res?.status(), path).toBe(200);
    expectPageHeaders(res!.headers(), path);
  }

  // The session view names the staff member and the session's end, never a token or a key.
  const session = await page.evaluate(async () => (await fetch('/bff/session')).text());
  expect(session).toContain('"signed_in":true');
  expect(session).not.toMatch(JWT);
  expect(session).not.toMatch(/access_token|refresh_token|id_token|dpop|"d":/i);

  const cookies = await context.cookies();
  const sid = cookies.find((c) => c.name === '__Host-cpa_sid');
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  for (const c of cookies) {
    expect(['__Host-cpa_sid', '__Host-cpa_rcv', 'cpa_locale', 'cpa_theme'], `cookie ${c.name}`).toContain(c.name);
    expect(c.value, c.name).not.toMatch(JWT);
    expect(decodeURIComponent(c.value), c.name).not.toMatch(EMAIL);
  }

  // This test reads the browser's storage to prove it holds nothing it should not (GD-12), so the lint ban on these
  // globals does not apply here.
  /* eslint-disable no-restricted-globals */
  const storage = await page.evaluate(async () => {
    const dump = (s: Storage) =>
      Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)!).map((k) => [k, s.getItem(k) ?? '']));
    const databases = 'databases' in indexedDB ? (await indexedDB.databases()).map((d) => d.name) : [];
    const workers = (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0;
    return { local: dump(localStorage), session: dump(sessionStorage), databases, workers };
  });
  /* eslint-enable no-restricted-globals */
  for (const [key, value] of Object.entries(storage.local)) {
    expect(key, 'localStorage key (src/lib/prefs.ts only)').toMatch(/^cpa\./);
    expect(value, key).not.toMatch(JWT);
    expect(value, key).not.toMatch(EMAIL);
  }
  expect(storage.session).toEqual({});
  expect(storage.databases).toEqual([]);
  expect(storage.workers).toBe(0);
});
