// P12.T2/T3: the service worker's pure rules — which requests are cached and how, cache names and the private-cache
// set wiped at logout, the offline shell's asset list, push payloads and click targets — and the committed bundle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVATE_SECTIONS } from '@/server/security-headers';
import { PAGES_CACHE, SHELL_CACHE, STATIC_CACHE, isPageMessage, isPrivateCache, userCacheName } from './protocol';
import { clickTarget, parsePush, safePath } from './push';
import { OFFLINE_SECTIONS, PRIVATE_PAGE_SECTIONS, assetUrlsOf, classify, isSnapshotApiPath, localeOfPath, titleOf } from './routes';
import { SW_BUNDLE, SW_BUNDLE_HASH } from './generated/bundle';

const ORIGIN = 'https://carpal.app';
const LOCALES = ['fa', 'en'] as const;
const req = (path: string, o: { method?: string; mode?: string; rsc?: boolean; origin?: string } = {}) =>
  classify({
    url: new URL(path, o.origin ?? ORIGIN),
    origin: ORIGIN,
    method: o.method ?? 'GET',
    mode: o.mode ?? 'cors',
    rsc: o.rsc ?? false,
    locales: LOCALES,
  });
const nav = (path: string) => req(path, { mode: 'navigate' });

describe('service worker routes', () => {
  it('never answers other methods or other origins from a cache', () => {
    expect(req('/api/v1/me/vehicles', { method: 'POST' })).toBe('network');
    expect(req('/fa/garage', { method: 'POST', mode: 'navigate' })).toBe('network');
    expect(req('/x.png', { origin: 'https://media.carpal-usercontent.app' })).toBe('network');
  });

  it('caches hashed build files first and revalidates design-system files, icons and manifests', () => {
    expect(req('/_next/static/chunks/app-123.js')).toBe('static-cache-first');
    expect(req('/_next/image?url=x')).toBe('network');
    expect(req('/ds/tokens.css')).toBe('static-swr');
    expect(req('/icons/icon-192.png')).toBe('static-swr');
    expect(req('/manifests/fa.webmanifest')).toBe('static-swr');
    expect(req('/sw.js')).toBe('network');
  });

  it('stores only the explicit API snapshots (garage, appointments, driver reads, the session) and never other BFF answers', () => {
    expect(req('/bff/session')).toBe('snapshot');
    for (const p of [
      '/api/v1/me/vehicles',
      '/api/v1/me/vehicles/0193/issues?limit=20',
      '/api/v1/me/appointments?group=upcoming',
      '/api/v1/me/appointments/0193/history',
      '/api/v1/me/subscription',
      '/api/v1/me/memberships?status=active',
      '/api/v1/orgs/0193/fleet/vehicles',
      '/api/v1/orgs/0193/fleet/appointments?vehicle_id=1',
    ])
      expect(req(p), p).toBe('snapshot');
    for (const p of [
      '/api/v1/me',
      '/api/v1/me/notifications',
      '/api/v1/me/consents',
      '/api/v1/me/data-requests',
      '/api/v1/orgs/0193/fleet/approvals',
      '/api/v1/orgs/0193/fleet/dashboard',
      '/bff/csrf',
      '/bff/intents',
      '/id/v1/auth/signin',
      '/l/ci',
    ])
      expect(req(p), p).toBe('network');
    expect(isSnapshotApiPath('/v1/me/vehicles-extra')).toBe(false);
  });

  it('revalidates the public taxonomy read (names of brands and symptoms; no user data)', () => {
    expect(req('/api/v1/taxonomy/nodes?type=vehicle_brand')).toBe('public-api-swr');
  });

  it('keeps garage, appointments and driver pages per user, other private pages from the network, public pages stale-while-revalidate', () => {
    expect(nav('/fa/garage')).toBe('private-page');
    expect(nav('/en/garage/0193/issues')).toBe('private-page');
    expect(nav('/fa/appointments/0193')).toBe('private-page');
    expect(nav('/fa/drive/0193/0194')).toBe('private-page');
    for (const p of ['/fa/settings/security', '/fa/notifications', '/fa/home', '/fa/help', '/fa/activity'])
      expect(nav(p), p).toBe('private-page-network');
    expect(nav('/fa')).toBe('public-page');
    expect(nav('/en/shop/reza-auto')).toBe('public-page');
    expect(nav('/fa/search?q=brakes')).toBe('network');
    expect(nav('/fa/map')).toBe('network');
    expect(nav('/fa/offline')).toBe('network');
    expect(nav('/fa/shop/reza-auto?theme=dark')).toBe('network');
    expect(nav('/de/garage')).toBe('network');
    // RSC data of client navigations is never stored.
    expect(req('/fa/garage', { mode: 'navigate', rsc: true })).toBe('network');
    expect(req('/fa/garage')).toBe('network');
  });

  it('treats every private section of the security headers as private (no private page is ever kept as public)', () => {
    for (const s of PRIVATE_SECTIONS) expect(PRIVATE_PAGE_SECTIONS.has(s), s).toBe(true);
    for (const s of OFFLINE_SECTIONS) expect(PRIVATE_PAGE_SECTIONS.has(s)).toBe(true);
  });

  it('finds the build and design-system files of the offline page, its title and locale', () => {
    const html =
      '<html><head><title>You&#x27;re offline · CarPal</title><link rel="stylesheet" href="/ds/tokens.css"/>' +
      '<script src="/_next/static/chunks/main-1.js" async=""></script><link href="/_next/static/css/app.css" rel="stylesheet"/>' +
      '<script>self.__next_f.push([1,"0:[\\"/_next/static/chunks/lazy-9.js\\"]"])</script><img src="https://x.test/a.png"/></head></html>';
    expect(assetUrlsOf(html).sort()).toEqual([
      '/_next/static/chunks/lazy-9.js',
      '/_next/static/chunks/main-1.js',
      '/_next/static/css/app.css',
      '/ds/tokens.css',
    ]);
    expect(titleOf(html)).toBe("You're offline · CarPal");
    expect(localeOfPath('/en/garage', LOCALES, 'fa')).toBe('en');
    expect(localeOfPath('/xx', LOCALES, 'fa')).toBe('fa');
  });
});

describe('service worker caches and messages', () => {
  it('wipes user caches and public pages at logout, keeps build files and the shell', () => {
    expect(isPrivateCache(userCacheName('0193-a'))).toBe(true);
    expect(isPrivateCache(PAGES_CACHE)).toBe(true);
    expect(isPrivateCache(STATIC_CACHE)).toBe(false);
    expect(isPrivateCache(`${SHELL_CACHE}-v1`)).toBe(false);
    expect(userCacheName('../evil id')).toBe('cp-user-evilid');
  });

  it('accepts only its own page messages', () => {
    expect(isPageMessage({ type: 'cp:session', userId: 'u', locale: 'fa' })).toBe(true);
    expect(isPageMessage({ type: 'cp:logout' })).toBe(true);
    expect(isPageMessage({ type: 'other' })).toBe(false);
    expect(isPageMessage('cp:logout')).toBe(false);
  });
});

describe('web push in the worker', () => {
  it('reads the backend push payload and falls back to a generic line in the user’s language', () => {
    const p = parsePush(
      JSON.stringify({
        title: 'Reza Auto proposed a time',
        body: 'Tue 10:00',
        data: { notification_id: 'n1', template_key: 'appointment.alternative_proposed' },
      }),
      'en',
    );
    expect(p).toMatchObject({
      title: 'Reza Auto proposed a time',
      body: 'Tue 10:00',
      notificationId: 'n1',
      templateKey: 'appointment.alternative_proposed',
    });
    expect(parsePush(null, 'fa')).toMatchObject({ title: 'کارپال', notificationId: null });
    expect(parsePush('plain text', 'en')).toMatchObject({ title: 'CarPal', body: 'plain text' });
    expect(parsePush('{"title":42}', 'en').title).toBe('CarPal');
  });

  it('opens the notification on the notifications page, a business one in the portal, and only same-origin paths', () => {
    const o = { locale: 'fa', portalUrl: 'https://portal.carpal.app' };
    expect(clickTarget({ notificationId: 'n 1', organizationContextId: null, url: null }, o)).toBe('/fa/notifications?open=n%201');
    expect(clickTarget({ notificationId: null, organizationContextId: null, url: null }, o)).toBe('/fa/notifications');
    expect(clickTarget({ notificationId: 'n1', organizationContextId: 'org', url: '/fa/x' }, o)).toBe('https://portal.carpal.app');
    expect(clickTarget(parsePush(JSON.stringify({ data: { url: '/fa/appointments/1' } }), 'fa'), o)).toBe('/fa/appointments/1');
    expect(safePath('//evil.test')).toBeNull();
    expect(safePath('https://evil.test')).toBeNull();
    expect(safePath('/\\evil')).toBeNull();
  });
});

describe('the committed worker bundle', () => {
  it('is a self-contained script with the hash of its text (pnpm sw:check keeps it in step with src/sw)', async () => {
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(SW_BUNDLE).digest('hex').slice(0, 16)).toBe(SW_BUNDLE_HASH);
    expect(SW_BUNDLE).not.toMatch(/\bimport\s|\brequire\(/);
    expect(SW_BUNDLE).toContain('__CARPAL_SW__');
    expect(readFileSync(join(process.cwd(), 'src', 'sw', 'generated', 'bundle.ts'), 'utf8')).toContain('GENERATED');
  });
});
