// Shared steps of the P13 key-flow suites (key-flows.spec.ts, journey.spec.ts): the dictionaries (every label comes
// from shared/i18n, so one step serves EN and FA), the hosted sign-in, a BFF call from the page, the cp-ssr token, the
// lite index wait, a second car brand that only this run's shop covers, and the shop's appointment moves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, AUTH } from './accounts';
import type { SeededProvider } from './businesses';

export type Locale = 'en' | 'fa';
export const SSR = 'cp-ssr/0.1.0 (web 1.0)';

const DICTS: Record<Locale, Record<string, unknown>> = {
  en: JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', 'en.json'), 'utf8')),
  fa: JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', 'fa.json'), 'utf8')),
};

/** The UI string of `key` in `locale`, with {{vars}} filled in (numbers as they are; use digits() for FA digits). */
export function say(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  const v = key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], DICTS[locale]);
  if (typeof v !== 'string') throw new Error(`no ${locale} string ${key}`);
  return v.replace(/\{\{\s*(\w+)(?:,\s*\w+)?\s*\}\}/g, (_, name: string) => String(vars[name] ?? `{{${name}}}`));
}

/** The text before the first {{placeholder}} (for strings that name a business or a date). */
export const lead = (locale: Locale, key: string) => say(locale, key).split('{{')[0]!.trim();

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const digits = (locale: Locale, s: string | number) =>
  locale === 'fa' ? String(s).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!) : String(s);

export async function ssrToken(request: APIRequestContext): Promise<string> {
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  return `${token_type} ${access_token}`;
}

export async function nodes(request: APIRequestContext, type: string, o: { parent?: string; locale?: Locale; limit?: number } = {}) {
  const res = await request.get(`${API}/v1/taxonomy/nodes?type=${type}&limit=${o.limit ?? 50}${o.parent ? `&parent_id=${o.parent}` : ''}`, {
    headers: { authorization: await ssrToken(request), 'carpal-client': SSR, 'accept-language': o.locale ?? 'en' },
  });
  return ((await res.json()) as { items: { id: string; slug: string; parent_id: string | null; name: { text: string } }[] }).items;
}

/**
 * A random model (and its brand) outside the first brand, which the P5/P6 shops cover: each run's Help Me shop is then
 * the only specialist for its car among the shops earlier runs left in the lite dev database (P13; a fixed brand let
 * those shops outrank the fresh one).
 */
export async function rareCar(request: APIRequestContext): Promise<{ brand: string; model: string }> {
  const first = (await nodes(request, 'vehicle_brand'))[0]?.id;
  const models = (await nodes(request, 'vehicle_model', { limit: 100 })).filter((m) => m.parent_id && m.parent_id !== first);
  if (!models.length) throw new Error('no vehicle models outside the first brand');
  const m = models[Math.floor(Math.random() * models.length)]!;
  return { brand: m.parent_id!, model: m.id };
}

/** Polls search.run until the shop is found for the text (the lite index sweeps every minute, BA-33). */
export async function waitIndexed(request: APIRequestContext, orgId: string, text: string, locale: Locale = 'en') {
  const auth = await ssrToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.post(`${API}/v1/search`, {
          data: { query_text: text, search_mode: 'all', entry_point: 'search_box', location: { mode: 'chosen_city', city_key: 'tehran' } },
          headers: { authorization: auth, 'carpal-client': SSR, 'accept-language': locale },
        });
        const body = (await res.json()) as { results?: { organization: { id: string } }[] };
        return (body.results ?? []).some((r) => r.organization.id === orgId);
      },
      { timeout: 150_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
}

/** The hosted sign-in from wherever the page sent the browser; a fresh account then skips the onboarding. */
export async function hostedSignIn(
  page: Page,
  locale: Locale,
  user: { email: string; password: string },
  o: { onboarding?: boolean } = {},
) {
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel(say(locale, 'auth.signin.identifier')).fill(user.email);
  await page.getByRole('button', { name: say(locale, 'auth.signin.methodPassword') }).click();
  await page.getByLabel(say(locale, 'auth.signin.password'), { exact: true }).fill(user.password);
  await page.getByRole('button', { name: say(locale, 'auth.signin.continue') }).click();
  if (o.onboarding === false) return;
  await page.waitForURL(new RegExp(`/${locale}/onboarding\\?next=`));
  await page.getByRole('link', { name: say(locale, 'onboarding.finishLater') }).click();
}

export async function signIn(page: Page, locale: Locale, user: { email: string; password: string }) {
  await page.goto(`/${locale}/login`);
  await hostedSignIn(page, locale, user);
  await page.waitForURL(new RegExp(`/${locale}(/home)?$`));
}

/** A BFF call from the page (CSRF token, idempotency key), like the typed client makes it. */
export async function bff(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
      const res = await fetch(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    { method, path, body },
  );
}

/** The shop moves an appointment (confirm, check in, start, complete) through its organization route. */
export async function shopMoves(shop: SeededProvider, appointmentId: string, body: Record<string, unknown>) {
  const r = await shop.api.call('POST', `/v1/orgs/${shop.id}/provider/appointments/${appointmentId}/transitions`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/**
 * Unpublishes a run's shop when its suite ends (P13): shops that collect completed visits and verified reviews in the
 * key-flow suites would otherwise outrank the next runs' fresh shops in the Help Me recommendations of the shared lite
 * database.
 */
export async function retire(shop: SeededProvider | undefined) {
  if (!shop) return;
  const r = await shop.api.call('POST', `/v1/orgs/${shop.id}/provider/unpublish`).catch(() => null);
  if (r && r.status >= 300) console.warn(`unpublish ${shop.name}: ${r.status}`);
}

/** Confirm (in 30 minutes, inside the check-in window), check in, start and complete. */
export async function shopCompletes(shop: SeededProvider, appointmentId: string) {
  const start = new Date(Date.now() + 30 * 60_000);
  start.setSeconds(0, 0);
  await shopMoves(shop, appointmentId, { to: 'confirmed', confirmed_start_at: start.toISOString(), estimated_duration_minutes: 60 });
  await shopMoves(shop, appointmentId, { to: 'checked_in' });
  await shopMoves(shop, appointmentId, { to: 'in_progress' });
  await shopMoves(shop, appointmentId, { to: 'completed' });
}

/** "Near me" on the location chip: the location consent, then the browser's (mocked) position. */
export async function nearMe(page: Page, locale: Locale) {
  await page.getByRole('button', { name: new RegExp(lead(locale, 'search.location.change')) }).click();
  await page.getByRole('button', { name: say(locale, 'search.location.nearMe') }).click();
  const allow = page.getByRole('button', { name: say(locale, 'search.location.allow') });
  if (await allow.isVisible().catch(() => false)) await allow.click();
}

/** Clicks the n-of-5 star label in a rating group (the radio itself is visually hidden). */
export async function rate(page: Page, locale: Locale, group: string, n: number) {
  await page
    .getByRole('group', { name: group })
    .locator('label')
    .filter({ hasText: say(locale, 'reviews.form.starsOf', { value: digits(locale, n) }) })
    .click();
}

/**
 * A point in south-west Tehran, away from businesses.ts tehranPoint() where every other suite seeds its shops (P13): the
 * lite dev database keeps every run's shops, and the Help Me ranking near the browser must still find this run's shop.
 */
export function quietPoint(): { lat: number; lng: number } {
  return { lat: Math.round((35.58 + Math.random() * 0.06) * 1e6) / 1e6, lng: Math.round((51.22 + Math.random() * 0.08) * 1e6) / 1e6 };
}

/** Every URL the page requests or navigates to (BFF calls included). */
export function recordUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('framenavigated', (f) => urls.push(f.url()));
  return urls;
}
