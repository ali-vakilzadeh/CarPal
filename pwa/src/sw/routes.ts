// Which caching rule a request gets (P12.T2). Pure: the worker passes what it knows about the request, the tests call
// it directly. The rules:
//   - only same-origin GETs are ever answered from a cache; everything else goes to the network untouched;
//   - build files under /_next/static are content-hashed: cache first;
//   - design-system files, icons and manifests: stale-while-revalidate;
//   - the public taxonomy read (names of brands, symptoms …): stale-while-revalidate — it holds no user data;
//   - API snapshots: the signed-in garage, appointments and driver reads and /bff/session, network first into the
//     user's cache (offline they answer from the last copy). Every other BFF or API response is never stored: they
//     are no-store and may be private;
//   - page navigations: the private garage / appointments / driver pages network first into the user's cache; other
//     private pages network only; public pages stale-while-revalidate; offline without a copy → the offline page.

export type Strategy =
  'network' | 'static-cache-first' | 'static-swr' | 'public-api-swr' | 'snapshot' | 'private-page' | 'private-page-network' | 'public-page';

export interface RequestFacts {
  url: URL;
  /** The worker's own origin. */
  origin: string;
  method: string;
  /** Request.mode: 'navigate' for page loads. */
  mode: string;
  /** The RSC header Next.js sends for client navigations and prefetches (data, not documents). */
  rsc?: boolean;
  locales: readonly string[];
}

/** Signed-in sections whose pages are kept for offline use (Docs/22 W-SYS-01: garage, appointments; P12.T4 driver). */
export const OFFLINE_SECTIONS = new Set(['garage', 'appointments', 'drive']);

/**
 * Private sections (mirrors PRIVATE_SECTIONS of src/server/security-headers.ts, which may not be imported here):
 * pages that are never stored unless listed in OFFLINE_SECTIONS.
 */
export const PRIVATE_PAGE_SECTIONS = new Set([
  'home',
  'garage',
  'help',
  'appointments',
  'review',
  'settings',
  'notifications',
  'saved',
  'activity',
  'onboarding',
  'login',
  'signup',
  'drive',
]);

/** Public pages that depend on the query or the visitor's position: always from the network. */
const UNCACHED_PUBLIC_SECTIONS = new Set(['search', 'map', 'dev-kit', 'system', 'offline']);

/**
 * API reads that may be stored as offline snapshots (paths below /api). The garage and appointments of the user,
 * their plan line, memberships (driver views) and the assigned fleet vehicles and appointments of a driver.
 */
const SNAPSHOT_PATHS = [
  /^\/v1\/me\/vehicles(?:\/|$)/,
  /^\/v1\/me\/appointments(?:\/|$)/,
  /^\/v1\/me\/subscription$/,
  /^\/v1\/me\/memberships$/,
  /^\/v1\/orgs\/[^/]+\/fleet\/vehicles(?:\/|$)/,
  /^\/v1\/orgs\/[^/]+\/fleet\/appointments(?:\/|$)/,
];

const PUBLIC_API_PATHS = [/^\/v1\/taxonomy\/nodes$/];

export function isSnapshotApiPath(apiPath: string): boolean {
  return SNAPSHOT_PATHS.some((r) => r.test(apiPath));
}

export function classify(r: RequestFacts): Strategy {
  if (r.method !== 'GET' || r.url.origin !== r.origin) return 'network';
  const path = r.url.pathname;

  if (path.startsWith('/_next/static/')) return 'static-cache-first';
  if (path.startsWith('/_next/')) return 'network';
  if (path.startsWith('/ds/') || path.startsWith('/icons/') || path.startsWith('/manifests/') || path === '/icon.svg') return 'static-swr';
  if (path === '/sw.js') return 'network';

  if (path === '/bff/session') return 'snapshot';
  if (path.startsWith('/api/')) {
    const apiPath = path.slice('/api'.length);
    if (PUBLIC_API_PATHS.some((p) => p.test(apiPath))) return 'public-api-swr';
    if (isSnapshotApiPath(apiPath)) return 'snapshot';
    return 'network';
  }
  if (path.startsWith('/bff/') || path.startsWith('/id/') || path === '/id' || path.startsWith('/l/')) return 'network';

  if (r.mode !== 'navigate' || r.rsc) return 'network';
  const [first, second] = path.split('/').slice(1);
  if (!first || !r.locales.includes(first)) return 'network';
  if (second && PRIVATE_PAGE_SECTIONS.has(second)) return OFFLINE_SECTIONS.has(second) ? 'private-page' : 'private-page-network';
  if (second && UNCACHED_PUBLIC_SECTIONS.has(second)) return 'network';
  // Public pages with a query (filters, ?city=, ?theme=) are not kept: one copy per path.
  if (r.url.search) return 'network';
  return 'public-page';
}

/** The locale of a page path, or the fallback. */
export function localeOfPath(path: string, locales: readonly string[], fallback: string): string {
  const first = path.split('/')[1];
  return first && locales.includes(first) ? first : fallback;
}

/** The offline page of a locale (precached when the worker installs). */
export function offlinePath(locale: string): string {
  return `/${locale}/offline`;
}

/** Same-origin build and design-system files a page's HTML references (precached with the offline pages). */
export function assetUrlsOf(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/(?:_next\/static|ds)\/[^"?#]+)"/g)) out.add(m[1]!);
  // Lazy chunks named only inside the inline flight data.
  for (const m of html.matchAll(/(\/_next\/static\/chunks\/[A-Za-z0-9_\-./]+\.(?:js|css))/g)) out.add(m[1]!);
  return [...out];
}

/** The <title> of a page (the saved-pages list of the offline page). */
export function titleOf(html: string): string {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  const raw = m?.[1]?.trim() ?? '';
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}
