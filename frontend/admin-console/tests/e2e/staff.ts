// E2E helpers for signed-in suites (AC4.T8): a fresh staff account per test (backend `pnpm dev:staff create`, dev
// only), the emailed code from the backend's outbox, Chrome's virtual authenticator as a device-bound security key
// (CDP WebAuthn: ctap2 over USB, user verification, resident keys, no backup flags = not synced), and the sign-in
// through the console's own pages. Needs backend `pnpm dev` with the console's settings (README "End-to-end tests").
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';

const BACKEND = join(import.meta.dirname, '..', '..', '..', '..', 'backend');
const OUTBOX = join(BACKEND, '.data', 'outbox-mail.jsonl');
export const STAFF_PASSWORD = 'admin-console-e2e-password';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';

export async function requireBackend(): Promise<void> {
  const ok = await fetch(`${AUTH}/.well-known/openid-configuration`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!ok) throw new Error(`backend not reachable at ${AUTH}: run \`pnpm dev\` in backend/ (README "End-to-end tests")`);
}

let counter = 0;

/** A new staff account with these roles (and no passkey yet). */
export function createStaff(roles: string[], o: { locale?: 'en' | 'fa'; name?: string } = {}): string {
  const email = `e2e-${roles.join('-').toLowerCase()}-${Date.now()}-${process.pid}-${counter++}@staff.carpals.test`;
  const tsx = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  execFileSync(
    process.execPath,
    [
      tsx,
      '--conditions=source',
      'tools/db/staff-cli.ts',
      'create',
      '--email',
      email,
      '--name',
      o.name ?? `E2E ${roles.join(' ')}`,
      '--roles',
      roles.join(','),
      '--locale',
      o.locale ?? 'en',
      '--password',
      STAFF_PASSWORD,
    ],
    { cwd: BACKEND, stdio: 'pipe', env: { ...process.env, CARPAL_STRICT_AUTH: '0' } },
  );
  return email;
}

/** The latest sign-in code mailed to `to` (backend lite writes mail to .data/outbox-mail.jsonl). */
export async function lastCode(to: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      () => {
        if (!existsSync(OUTBOX)) return undefined;
        for (const line of readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse()) {
          const m = JSON.parse(line) as { to: string; template: string; variables: { code?: string } };
          if (m.to === to && m.template === 'identity.otp_code' && m.variables.code) return (code = m.variables.code);
        }
        return undefined;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return code!;
}

/** A device-bound security key in this page's browser (Chrome's virtual authenticator). */
export async function addSecurityKey(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

export interface SignInLabels {
  email: string;
  password: string;
  continue: string;
  code: string;
  create: string;
  useKey: string;
}

export const EN: SignInLabels = {
  email: 'Work email',
  password: 'Password',
  continue: 'Continue',
  code: 'Code from the email',
  create: 'Create security key',
  useKey: 'Use security key',
};

export const FA: SignInLabels = {
  email: 'ایمیل کاری',
  password: 'گذرواژه',
  continue: 'ادامه',
  code: 'کد ایمیل',
  create: 'ساخت کلید امنیتی',
  useKey: 'استفاده از کلید امنیتی',
};

/**
 * On the sign-in page: password, the first security key when the account has none (emailed code + the browser's key
 * prompt), then the key; waits until the browser is back in the console.
 */
export async function signInOnPage(page: Page, email: string, o: { enrol: boolean; labels?: SignInLabels }): Promise<void> {
  const l = o.labels ?? EN;
  await page.waitForURL(/\/id\/signin\?/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel(l.email).fill(email);
  await page.getByLabel(l.password).fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: l.continue, exact: true }).click();
  // Strict mode: the password step solves a proof of work first (a few seconds, longer when several browsers run).
  if (o.enrol) {
    const code = page.getByLabel(l.code);
    await code.waitFor({ timeout: 60_000 });
    await code.fill(await lastCode(email));
    await page.getByRole('button', { name: l.create }).click();
  }
  await page.getByRole('button', { name: l.useKey }).click({ timeout: 60_000 });
  await page.waitForURL((u) => !u.pathname.startsWith('/id/') && !u.pathname.startsWith('/bff/'), { timeout: 60_000 });
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
}

/** A new account with these roles, signed in from `path` (enrols its key on the way). */
export async function signInAs(context: BrowserContext, page: Page, roles: string[], o: { path?: string; locale?: 'en' | 'fa' } = {}) {
  const email = createStaff(roles, o.locale ? { locale: o.locale } : {});
  await addSecurityKey(context, page);
  await page.goto(o.path ?? '/');
  await signInOnPage(page, email, { enrol: true, ...(o.locale === 'fa' ? { labels: FA } : {}) });
  return email;
}

/** The section names in the left navigation. */
export async function navSections(page: Page, label = 'Console sections'): Promise<string[]> {
  return page.getByRole('navigation', { name: label }).getByRole('link').allTextContents();
}
