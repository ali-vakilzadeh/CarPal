// The CarPal service worker (P12.T2/T3). Hand-written, no library (decision recorded in pwa/dev_plan.json, P12):
// the rules are few and specific (user-scoped private caches, no BFF responses, a cookie-free offline shell), and a
// library such as Workbox would add its own runtime and conventions for little gain. tools/build-sw.mjs bundles this
// file with esbuild into src/sw/generated/bundle.ts; the /sw.js route serves it behind a small config prefix.
//
//   install   the offline pages of every locale and the files they reference, fetched WITHOUT cookies (so no
//             session view is ever stored in the shared shell); a first install takes control at once;
//   activate  removes the caches of earlier versions (shell, public pages) and claims the open pages;
//   message   the pages report the signed-in user (cp:session) — a different user or a sign-out wipes every private
//             cache —, logout (cp:logout), an accepted update (cp:skip-waiting) and version checks;
//   fetch     the rules of routes.ts; snapshots and private pages are stored only for the user /bff/session names;
//   push      shows the notification; a click opens or focuses the page it belongs to.
import { clickTarget, parsePush } from './push';
import {
  META_CACHE,
  PAGES_CACHE,
  SAVED_PAGES_KEY,
  SHELL_CACHE,
  SNAPSHOT_HEADER,
  STATIC_CACHE,
  USER_CACHE_PREFIX,
  isPageMessage,
  isPrivateCache,
  userCacheName,
  type SavedPage,
  type WorkerConfig,
} from './protocol';
import { assetUrlsOf, classify, localeOfPath, offlinePath, titleOf, type Strategy } from './routes';
import type { ExtendableEvent, FetchEvent, WorkerScope } from './worker-types';

declare const self: WorkerScope & { __CARPAL_SW__?: WorkerConfig };

const config: WorkerConfig = self.__CARPAL_SW__ ?? { version: 'dev', portalUrl: 'https://portal.carpal.app', locales: ['fa', 'en'] };
const SHELL = `${SHELL_CACHE}-${config.version}`;
const STATE_KEY = '/__carpal/state.json';
const MAX_STATIC = 400;
const MAX_PAGES = 40;
const MAX_SAVED = 30;
/** How long a /bff/session answer counts as current for storing private copies. */
const SESSION_FRESH_MS = 30_000;

interface State {
  userId: string | null;
  locale: string;
}

let state: State | null = null;
let sessionCheckedAt = 0;
let sessionCheck: Promise<string | null> | null = null;
/** Pages kept lately (path → time), so a page is not fetched again for a client-side move right after its load. */
const kept = new Map<string, number>();
const KEEP_AGAIN_MS = 5 * 60_000;

async function loadState(): Promise<State> {
  if (state) return state;
  const res = await (await self.caches.open(META_CACHE)).match(STATE_KEY);
  state = res ? ((await res.json().catch(() => null)) as State | null) : null;
  state ??= { userId: null, locale: config.locales[0] ?? 'fa' };
  return state;
}

async function saveState(next: State): Promise<void> {
  state = next;
  await (
    await self.caches.open(META_CACHE)
  ).put(STATE_KEY, new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } }));
}

/** Removes every private cache (user copies and the public pages). */
async function wipePrivate(): Promise<void> {
  const names = await self.caches.keys();
  await Promise.all(names.filter(isPrivateCache).map((n) => self.caches.delete(n)));
}

/** The signed-in user changed (or signed out): only that user's copies may stay. */
async function setUser(userId: string | null, locale?: string): Promise<void> {
  const s = await loadState();
  const changed = s.userId !== userId;
  // Every other user's copies go, and the public pages too: their HTML carries the header's session view.
  if (changed) await wipePrivate();
  else if (userId) {
    const names = await self.caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith(USER_CACHE_PREFIX) && n !== userCacheName(userId)).map((n) => self.caches.delete(n)),
    );
  }
  if (changed || (locale && locale !== s.locale)) await saveState({ userId, locale: locale ?? s.locale });
}

function userOfSession(body: unknown): string | null {
  const b = body as { signed_in?: boolean; user?: { id?: string } | null } | null;
  return b?.signed_in && typeof b.user?.id === 'string' ? b.user.id : null;
}

/**
 * The user the BFF says is signed in, checked at most every 30 s (a session that changed since — another account
 * signed in, an expiry — is noticed before anything is stored for the wrong user). Offline: the last known user.
 */
async function verifiedUser(): Promise<string | null> {
  if (Date.now() - sessionCheckedAt < SESSION_FRESH_MS) return (await loadState()).userId;
  sessionCheck ??= self
    .fetch('/bff/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const user = userOfSession(await res.json());
      sessionCheckedAt = Date.now();
      await setUser(user);
      return user;
    })
    .finally(() => {
      sessionCheck = null;
    });
  return sessionCheck.catch(async () => (await loadState()).userId);
}

async function trim(cacheName: string, max: number): Promise<void> {
  const cache = await self.caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

const storable = (res: Response) => res.ok && res.status === 200 && res.type === 'basic' && !res.redirected;
const isHtml = (res: Response) => (res.headers.get('content-type') ?? '').includes('text/html');

/** A stored copy, marked with the time it was saved. */
function asSnapshot(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set(SNAPSHOT_HEADER, res.headers.get('date') ? new Date(res.headers.get('date')!).toISOString() : '');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Stores a fresh response with its saving time in the Date header (snapshots show "saved at"). */
async function putWithDate(cache: Cache, req: Request | string, res: Response): Promise<void> {
  const headers = new Headers(res.headers);
  headers.set('date', new Date().toUTCString());
  await cache.put(req, new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers }));
}

async function shellPage(locale: string): Promise<Response | undefined> {
  const shell = await self.caches.open(SHELL);
  return (await shell.match(offlinePath(locale))) ?? (await shell.match(offlinePath(config.locales[0] ?? 'fa')));
}

async function precacheShell(): Promise<void> {
  const shell = await self.caches.open(SHELL);
  for (const locale of config.locales) {
    const path = offlinePath(locale);
    const res = await self.fetch(path, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`offline page ${path}: ${res.status}`);
    const html = await res.clone().text();
    await shell.put(path, res);
    const assets = assetUrlsOf(html);
    await Promise.all(
      assets.map(async (url) => {
        if (await shell.match(url)) return;
        const a = await self.fetch(url, { credentials: 'omit' }).catch(() => null);
        if (a?.ok) await shell.put(url, a);
      }),
    );
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const hit = (await self.caches.match(req)) ?? undefined;
  if (hit) return hit;
  const res = await self.fetch(req);
  if (storable(res)) {
    const copy = res.clone();
    void self.caches.open(STATIC_CACHE).then(async (c) => {
      await c.put(req, copy);
      await trim(STATIC_CACHE, MAX_STATIC);
    });
  }
  return res;
}

async function staleWhileRevalidate(e: FetchEvent, cacheName: string, max: number, html: boolean): Promise<Response> {
  const req = e.request;
  const cache = await self.caches.open(cacheName);
  const hit = await cache.match(req);
  const update = self
    .fetch(req)
    .then(async (res) => {
      if (storable(res) && (!html || isHtml(res))) {
        await cache.put(req, res.clone());
        await trim(cacheName, max);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    e.waitUntil(update);
    return hit;
  }
  const res = await update;
  if (res) return res;
  return html ? ((await shellPage(localeOfPath(new URL(req.url).pathname, config.locales, 'fa'))) ?? Response.error()) : Response.error();
}

/** Network first; the copy goes to the signed-in user's cache. Offline: that user's copy. */
async function networkFirstPrivate(e: FetchEvent, kind: 'snapshot' | 'page'): Promise<Response> {
  const req = e.request;
  const url = new URL(req.url);
  try {
    const res = await self.fetch(req);
    if (url.pathname === '/bff/session' && res.ok) {
      // The session read itself names the user: switch caches at once when it changed.
      const copy = res.clone();
      const user = userOfSession(
        await res
          .clone()
          .json()
          .catch(() => null),
      );
      sessionCheckedAt = Date.now();
      e.waitUntil(
        setUser(user).then(async () => {
          if (user) await putWithDate(await self.caches.open(userCacheName(user)), req, copy);
        }),
      );
      return res;
    }
    if (storable(res) && (kind === 'snapshot' || isHtml(res))) {
      const copy = res.clone();
      e.waitUntil(
        (async () => {
          const user = await verifiedUser();
          if (!user) return;
          const cache = await self.caches.open(userCacheName(user));
          if (kind === 'page') {
            kept.set(`${url.pathname}${url.search}`, Date.now());
            const html = await copy.clone().text();
            await putWithDate(cache, req, copy);
            await rememberPage(cache, { url: `${url.pathname}${url.search}`, title: titleOf(html), savedAt: new Date().toISOString() });
          } else await putWithDate(cache, req, copy);
        })(),
      );
    }
    return res;
  } catch {
    const s = await loadState();
    // One copy per URL in the user's cache: Next.js's Vary list (RSC headers) must not hide it from a reload.
    const hit = s.userId ? await (await self.caches.open(userCacheName(s.userId))).match(req, { ignoreVary: true }) : undefined;
    if (hit) return asSnapshot(hit);
    if (kind === 'page') return (await shellPage(localeOfPath(url.pathname, config.locales, s.locale))) ?? Response.error();
    return Response.error();
  }
}

/**
 * A page reached by a client-side navigation was never loaded as a document, so a reload offline would miss it:
 * fetch its document once (same cookies) and keep it like a visited page. Only pages of the offline sections.
 */
async function keepPage(path: string): Promise<void> {
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;
  const strategy = classify({ url, origin: self.location.origin, method: 'GET', mode: 'navigate', rsc: false, locales: config.locales });
  if (strategy !== 'private-page') return;
  const key = `${url.pathname}${url.search}`;
  if (Date.now() - (kept.get(key) ?? 0) < KEEP_AGAIN_MS) return;
  kept.set(key, Date.now());
  const user = await verifiedUser();
  if (!user) return;
  const res = await self.fetch(url.href, { credentials: 'same-origin', headers: { accept: 'text/html' } }).catch(() => null);
  if (!res || !storable(res) || !isHtml(res)) return;
  const cache = await self.caches.open(userCacheName(user));
  const html = await res.clone().text();
  await putWithDate(cache, url.href, res);
  await rememberPage(cache, { url: key, title: titleOf(html), savedAt: new Date().toISOString() });
}

async function rememberPage(cache: Cache, page: SavedPage): Promise<void> {
  const res = await cache.match(SAVED_PAGES_KEY);
  const list = res ? (((await res.json().catch(() => [])) as SavedPage[]) ?? []) : [];
  const next = [page, ...list.filter((p) => p.url !== page.url)].slice(0, MAX_SAVED);
  await cache.put(SAVED_PAGES_KEY, new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } }));
}

async function networkOrOffline(req: Request): Promise<Response> {
  try {
    return await self.fetch(req);
  } catch {
    const s = await loadState();
    return (await shellPage(localeOfPath(new URL(req.url).pathname, config.locales, s.locale))) ?? Response.error();
  }
}

function handle(e: FetchEvent, strategy: Strategy): Promise<Response> | null {
  switch (strategy) {
    case 'static-cache-first':
      return cacheFirst(e.request);
    case 'static-swr':
    case 'public-api-swr':
      return staleWhileRevalidate(e, STATIC_CACHE, MAX_STATIC, false);
    case 'public-page':
      return staleWhileRevalidate(e, PAGES_CACHE, MAX_PAGES, true);
    case 'snapshot':
      return networkFirstPrivate(e, 'snapshot');
    case 'private-page':
      return networkFirstPrivate(e, 'page');
    case 'private-page-network':
      return networkOrOffline(e.request);
    case 'network':
      return null;
  }
}

self.addEventListener('install', (e: ExtendableEvent) => {
  e.waitUntil(
    (async () => {
      await precacheShell();
      // The first worker takes control at once; later versions wait until a page accepts the update.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(
        names.filter((n) => (n.startsWith(`${SHELL_CACHE}-`) && n !== SHELL) || n === PAGES_CACHE).map((n) => self.caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  const m = e.data;
  if (!isPageMessage(m)) return;
  if (m.type === 'cp:skip-waiting') e.waitUntil(self.skipWaiting());
  else if (m.type === 'cp:version') e.source?.postMessage({ type: 'cp:version', version: config.version });
  else if (m.type === 'cp:logout')
    e.waitUntil(
      (async () => {
        await wipePrivate();
        await saveState({ ...(await loadState()), userId: null });
        sessionCheckedAt = 0;
        e.source?.postMessage({ type: 'cp:caches-cleared' });
      })(),
    );
  else if (m.type === 'cp:session') e.waitUntil(setUser(m.userId, config.locales.includes(m.locale) ? m.locale : undefined));
  else if (m.type === 'cp:keep') e.waitUntil(keepPage(m.url).catch(() => undefined));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const strategy = classify({
    url: new URL(req.url),
    origin: self.location.origin,
    method: req.method,
    mode: req.mode,
    rsc: req.headers.get('rsc') === '1',
    locales: config.locales,
  });
  const res = handle(e, strategy);
  if (res) e.respondWith(res);
});

self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      const { locale } = await loadState();
      const p = parsePush(e.data ? e.data.text() : null, locale);
      await self.registration.showNotification(p.title, {
        body: p.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        lang: locale,
        dir: locale === 'fa' ? 'rtl' : 'ltr',
        ...(p.notificationId ? { tag: p.notificationId } : {}),
        data: { target: clickTarget(p, { locale, portalUrl: config.portalUrl }) },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data as { target?: string } | null)?.target ?? `/${config.locales[0] ?? 'fa'}/notifications`;
  e.waitUntil(
    (async () => {
      const absolute = new URL(target, self.location.origin);
      if (absolute.origin === self.location.origin) {
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const same = open.find((c) => new URL(c.url).origin === self.location.origin);
        if (same) {
          await same.focus();
          await same.navigate(absolute.href).catch(() => self.clients.openWindow(absolute.href));
          return;
        }
      }
      await self.clients.openWindow(absolute.href);
    })(),
  );
});
