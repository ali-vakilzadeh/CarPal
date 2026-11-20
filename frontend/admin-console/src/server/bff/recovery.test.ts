// AC10b.T3: the /id proxy keeps the staff recovery request handle server-side. The browser never sees it: the start
// answers an empty body and an HttpOnly cookie, the later calls get the handle put back on their way to the auth host,
// and an ended or unknown request drops it. The completion's answer (the new recovery codes) passes through as it came.
import { describe, expect, it } from 'vitest';
import { createBff } from './index';
import { LiteRecoveryStore, RECOVERY_COOKIE, RECOVERY_PATHS, withHandle } from './recovery';
import { LiteSessionStore } from './session/store';
import { Browser, problemResponse, testConfig } from './test-support';

const HANDLE = 'h'.repeat(43);

function setup(
  statusAnswer: () => Response = () =>
    Response.json({ status: 'awaiting_approvals', password_forgotten: false, approvals: 0, expires_at: '2026-11-21T10:00:00Z' }),
) {
  const seen: { path: string; body: Record<string, unknown> | null; cookie: string | null }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const text = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
    seen.push({
      path: u.pathname,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      cookie: new Headers(init?.headers).get('cookie'),
    });
    switch (u.pathname) {
      case RECOVERY_PATHS.start:
        return Response.json({ request_handle: HANDLE }, { status: 202 });
      case RECOVERY_PATHS.verify:
        return Response.json({ status: 'awaiting_approvals', password_forgotten: false, approvals: 0, expires_at: '2026-11-21T10:00:00Z' });
      case RECOVERY_PATHS.status:
        return statusAnswer();
      case RECOVERY_PATHS.options:
        return Response.json({ challenge: 'c' });
      case RECOVERY_PATHS.complete:
        return Response.json({ next: 'mfa', mfa_methods: ['webauthn'], recovery_codes: ['AAAA-BBBB-CCCC-DDDD-EEEE'] });
      default:
        return problemResponse(404, 'NOT_FOUND');
    }
  }) as typeof globalThis.fetch;
  const recovery = new LiteRecoveryStore();
  const bff = createBff({ config: testConfig(), store: new LiteSessionStore({ sweepMs: 0 }), recoveryStore: recovery, fetch });
  const browser = new Browser(bff);
  browser.cookies.set('__Host-cp_ia', 'ia-1');
  const post = (path: string, body: unknown) =>
    browser.fetch(`/id${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { seen, recovery, browser, post };
}

describe('staff recovery handle (AC10b.T3)', () => {
  it('keeps the handle out of the browser and puts it back on the next calls', async () => {
    const { seen, recovery, browser, post } = setup();
    const start = await post(RECOVERY_PATHS.start, {
      interaction_id: 'ia-1',
      email: 'sara@staff.carpals.test',
      password: 'pw',
      password_forgotten: false,
      recovery_code: 'AAAA-BBBB-CCCC-DDDD-EEEE',
    });
    expect(start.status).toBe(202);
    expect(await start.text()).toBe('{}');
    const setCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${RECOVERY_COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Max-Age=86400/);
    expect(setCookie).not.toContain(HANDLE);
    expect(recovery.size).toBe(1);

    await post(RECOVERY_PATHS.verify, { interaction_id: 'ia-1', code: '123456', request_handle: 'x'.repeat(43) });
    const verify = seen.find((s) => s.path === RECOVERY_PATHS.verify)!;
    // The stored handle wins over anything the browser sends under that name.
    expect(verify.body).toEqual({ interaction_id: 'ia-1', code: '123456', request_handle: HANDLE });
    expect(verify.cookie).toBe('__Host-cp_ia=ia-1');

    const status = await post(RECOVERY_PATHS.status, {});
    expect(status.status).toBe(200);
    expect(seen.at(-1)!.body).toEqual({ request_handle: HANDLE });
    expect(browser.cookies.has(RECOVERY_COOKIE)).toBe(true);

    await post(RECOVERY_PATHS.options, { interaction_id: 'ia-1' });
    expect(seen.at(-1)!.body).toEqual({ interaction_id: 'ia-1', request_handle: HANDLE });

    const done = await post(RECOVERY_PATHS.complete, { interaction_id: 'ia-1', attestation: { id: 'k' } });
    expect(seen.at(-1)!.body).toEqual({ interaction_id: 'ia-1', attestation: { id: 'k' } });
    expect(((await done.json()) as { recovery_codes: string[] }).recovery_codes).toEqual(['AAAA-BBBB-CCCC-DDDD-EEEE']);
    expect(browser.cookies.has(RECOVERY_COOKIE)).toBe(false);
    expect(recovery.size).toBe(0);
  });

  it('answers 404 without a request on file and never calls the auth host', async () => {
    const { seen, post } = setup();
    const res = await post(RECOVERY_PATHS.status, {});
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('drops the handle when the request ended or the auth host does not know it', async () => {
    for (const answer of [
      () => Response.json({ status: 'rejected', password_forgotten: false, approvals: 1, expires_at: '2026-11-21T10:00:00Z' }),
      () => problemResponse(404, 'NOT_FOUND'),
    ]) {
      const { recovery, browser, post } = setup(answer);
      await post(RECOVERY_PATHS.start, {
        interaction_id: 'ia-1',
        email: 'a@b.cd',
        password_forgotten: true,
        recovery_code: 'AAAA-BBBB-CCCC-DDDD-EEEE',
      });
      expect(recovery.size).toBe(1);
      await post(RECOVERY_PATHS.status, {});
      expect(recovery.size).toBe(0);
      expect(browser.cookies.has(RECOVERY_COOKIE)).toBe(false);
    }
  });

  it('refuses a cross-site recovery call (CSRF) like every /id state change', async () => {
    const { seen, browser } = setup();
    const res = await browser.fetch(`/id${RECOVERY_PATHS.start}`, {
      method: 'POST',
      site: 'cross-site',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('withHandle keeps the body and refuses what is not a JSON object', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(JSON.parse(new TextDecoder().decode(withHandle(enc('{"code":"1"}'), HANDLE)!))).toEqual({ code: '1', request_handle: HANDLE });
    expect(withHandle(enc('[1]'), HANDLE)).toBeNull();
    expect(withHandle(enc('not json'), HANDLE)).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(withHandle(new Uint8Array(0), HANDLE)!))).toEqual({ request_handle: HANDLE });
  });
});
