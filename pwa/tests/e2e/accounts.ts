// E2E helpers for accounts (P4.T8, GD-16): the lite backend's mail outbox reader and a user factory. Users are fresh
// @test.carpal.app addresses; the factory creates and verifies them directly on the auth host (an interaction of
// its own, never completed), so a test can start signed out with a known password.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';

export const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
export const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const OUTBOX = join(import.meta.dirname, '..', '..', '..', 'backend', '.data', 'outbox-mail.jsonl');
const CLIENT = 'cp-web-consumer/0.1.0 (web 1.0)';
const PORT = Number(process.env.CARPAL_E2E_PORT ?? 3100);

export async function backendUp(request: APIRequestContext): Promise<boolean> {
  return (await request.get(`${API}/v1/health`).catch(() => null))?.ok() ?? false;
}

export function newEmail(prefix = 'p4'): string {
  return `${prefix}-${randomUUID()}@test.carpal.app`;
}

interface OutboxMail {
  at: string;
  to: string;
  template: string;
  variables: Record<string, string>;
}

/** The newest mail of `template` to `to` written after `since` (ISO time); polls the lite outbox for up to 10 s. */
export async function readMail(to: string, template: string, since: string): Promise<OutboxMail> {
  let found: OutboxMail | undefined;
  await expect
    .poll(
      () => {
        const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse();
        found = lines.map((l) => JSON.parse(l) as OutboxMail).find((m) => m.to === to && m.template === template && m.at >= since);
        return !!found;
      },
      { timeout: 10_000, message: `${template} mail to ${to}` },
    )
    .toBe(true);
  return found!;
}

export const now = () => new Date().toISOString();

/** The one-time code mailed to `email` after `since`. */
export async function mailedCode(email: string, since: string): Promise<string> {
  return (await readMail(email, 'identity.otp_code', since)).variables.code!;
}

/** The token of a link mail (verification "ev", reset "pr"). */
export async function mailedLinkToken(email: string, template: 'identity.email_verification' | 'identity.password_reset', since: string) {
  return (await readMail(email, template, since)).variables.link!.split('#')[1]!;
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

/** A verified account with a password, created directly on the auth host (lite mode needs no attestation). */
export async function createUser(
  request: APIRequestContext,
  o: { email?: string; password?: string; fullName?: string; locale?: 'en' | 'fa' } = {},
): Promise<{ email: string; password: string }> {
  const email = o.email ?? newEmail();
  const password = o.password ?? `winter tyres ${randomBytes(4).toString('hex')}`;
  const verifier = b64(randomBytes(32));
  const authorize = new URL(`${AUTH}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: 'cp-web-consumer',
    redirect_uri: `https://localhost:${PORT}/bff/oauth/callback`,
    scope: 'openid offline_access',
    state: b64(randomBytes(24)),
    nonce: b64(randomBytes(24)),
    code_challenge: b64(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }))
    authorize.searchParams.set(k, v);
  const toSignin = await request.get(authorize.toString(), { maxRedirects: 0, headers: { 'carpal-client': CLIENT } });
  expect(toSignin.status(), await toSignin.text()).toBe(302);
  const interaction = new URL(toSignin.headers().location!).searchParams.get('interaction_id')!;
  const post = (path: string, data: unknown) =>
    request.post(`${AUTH}${path}`, { data, headers: { 'carpal-client': CLIENT, 'idempotency-key': randomUUID() } });

  const since = now();
  const signup = await post('/v1/auth/signup', {
    interaction_id: interaction,
    full_name: o.fullName ?? 'Sara Example',
    email,
    password,
    locale: o.locale ?? 'en',
    terms_version: '2026-10',
    privacy_policy_version: '2026-10',
  });
  expect(signup.status(), await signup.text()).toBe(202);
  const verify = await post('/v1/auth/email/verify', { token: await mailedLinkToken(email, 'identity.email_verification', since) });
  expect(verify.status(), await verify.text()).toBe(200);
  return { email, password };
}
