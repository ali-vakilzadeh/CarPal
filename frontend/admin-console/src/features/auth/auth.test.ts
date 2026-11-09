// AC4.T1 unit tests: the sign-in's auth client (paths through the /id proxy, proof of work on demand) and the mapping
// of auth errors to what the page shows.
import { describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api/problem';
import { authPath, createAuthClient } from './auth-client';
import { authOutcome, DEFAULT_LOCK_MS, isSigninOutcome, outcomeMessage, SIGNIN_OUTCOMES } from './problems';

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, ...extra }), { status, headers: { 'content-type': 'application/problem+json' } });

describe('auth client', () => {
  it('calls the auth operations through the /id proxy', () => {
    expect(authPath('auth.signin_password')).toBe('/id/v1/auth/signin');
    expect(authPath('auth.passkey_enrol_options')).toBe('/id/v1/auth/passkey-enrolment/options');
    expect(authPath('auth.passkey_enrol')).toBe('/id/v1/auth/passkey-enrolment');
    expect(authPath('auth.webauthn_options')).toBe('/id/v1/auth/webauthn/options');
    expect(authPath('auth.mfa_verify')).toBe('/id/v1/auth/mfa/verify');
  });

  it('sends JSON with the page language and returns the answer', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ next: 'enrol_passkey' }));
    const auth = createAuthClient({ fetch: fetch as unknown as typeof globalThis.fetch, locale: () => 'fa' });
    const next = await auth.call('auth.signin_password', { interaction_id: 'ia', email: 'a@b.test', password: 'pw' });
    expect(next).toEqual({ next: 'enrol_passkey' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/id/v1/auth/signin');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ interaction_id: 'ia', email: 'a@b.test', password: 'pw' });
    const h = new Headers(init!.headers);
    expect(h.get('accept-language')).toBe('fa');
    expect(h.get('carpal-pow')).toBeNull();
  });

  it('solves a proof of work once when the auth host asks for one (strict mode, SEC-BF-7)', async () => {
    const fetch = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(problem(403, 'ATTESTATION_REQUIRED'))
      .mockResolvedValueOnce(Response.json({ next: 'mfa', mfa_methods: ['webauthn'] }));
    const solvePow = vi.fn(async () => 'challenge.42');
    const auth = createAuthClient({ fetch: fetch as unknown as typeof globalThis.fetch, solvePow });
    await expect(auth.call('auth.signin_password', { interaction_id: 'ia', email: 'a@b.test', password: 'pw' })).resolves.toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    expect(solvePow).toHaveBeenCalledWith('signin');
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('carpal-pow')).toBe('challenge.42');
  });

  it('never solves a proof of work for an operation without ATT, and maps failures to ApiProblem', async () => {
    const fetch = vi.fn(async () => problem(403, 'ATTESTATION_REQUIRED'));
    const solvePow = vi.fn(async () => 'x');
    const auth = createAuthClient({ fetch: fetch as unknown as typeof globalThis.fetch, solvePow });
    const err = await auth.call('auth.mfa_verify', { interaction_id: 'ia', method: 'webauthn' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).code).toBe('ATTESTATION_REQUIRED');
    expect(solvePow).not.toHaveBeenCalled();
  });

  it('maps a network failure to NETWORK', async () => {
    const auth = createAuthClient({
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof globalThis.fetch,
    });
    const err = (await auth.call('auth.webauthn_options', { interaction_id: 'ia', purpose: 'mfa' }).catch((e: unknown) => e)) as ApiProblem;
    expect(err.code).toBe('NETWORK');
  });
});

describe('auth outcomes', () => {
  const p = (status: number, code: string, retryAfterMs?: number) =>
    new ApiProblem(status, { code }, retryAfterMs !== undefined ? { retryAfterMs } : {});

  it('expired interactions, pauses and the network gate are steps of their own', () => {
    expect(authOutcome(p(410, 'LINK_EXPIRED'))).toEqual({ kind: 'expired' });
    expect(authOutcome(p(429, 'RATE_LIMITED', 90_000))).toEqual({ kind: 'locked', retryAfterMs: 90_000 });
    expect(authOutcome(p(429, 'RATE_LIMITED'))).toEqual({ kind: 'locked', retryAfterMs: DEFAULT_LOCK_MS });
    // A 403 that is not one of the console's own refusals: the gate in front of admin.<DOMAIN> (DI-04, OQ-02).
    expect(authOutcome(p(403, 'HTTP_403'))).toEqual({ kind: 'gate' });
    expect(authOutcome(p(403, 'CSRF_FAILED'))).toEqual({ kind: 'message', message: 'admin.signin.errors.generic' });
  });

  it('keeps wrong credentials enumeration-safe and names the device-bound rule', () => {
    expect(authOutcome(p(401, 'INVALID_CREDENTIALS'), 'admin.signin.errors.invalid')).toEqual({
      kind: 'message',
      message: 'admin.signin.errors.invalid',
    });
    expect(authOutcome(p(422, 'CODE_INVALID'), 'admin.signin.errors.codeWrong')).toEqual({
      kind: 'message',
      message: 'admin.signin.errors.codeWrong',
    });
    expect(authOutcome(p(422, 'PASSKEY_NOT_DEVICE_BOUND'))).toEqual({ kind: 'message', message: 'admin.signin.errors.notDeviceBound' });
    expect(authOutcome(p(0, 'NETWORK'))).toEqual({ kind: 'message', message: 'admin.signin.errors.network' });
    expect(authOutcome(new Error('x'))).toEqual({ kind: 'message', message: 'admin.signin.errors.generic' });
  });

  it('has a message for every callback outcome of the BFF', () => {
    for (const o of SIGNIN_OUTCOMES) expect(outcomeMessage(o)).toBe(`admin.signin.outcome.${o}`);
    expect(isSigninOutcome('not_staff')).toBe(true);
    expect(isSigninOutcome('anything')).toBe(false);
  });
});
