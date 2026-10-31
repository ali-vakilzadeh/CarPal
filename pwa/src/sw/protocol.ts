// What the service worker and the pages share (P12.T2): cache names, the messages they exchange and the snapshot
// header. No DOM or worker globals here: the page bundle (features/pwa) and the worker bundle (src/sw/sw.ts) both
// import it, and the unit tests run it in node.

/** Hashed build files (/_next/static), the design-system files, icons and manifests: never user data. */
export const STATIC_CACHE = 'cp-static';
/** The offline pages of both languages and their files, fetched without cookies when the worker installs. */
export const SHELL_CACHE = 'cp-shell';
/** Public pages, stale-while-revalidate. Their HTML carries the header's session view, so it is wiped on logout. */
export const PAGES_CACHE = 'cp-pages';
/** Prefix of the signed-in user's cache: private pages (garage, appointments, driver views) and API snapshots. */
export const USER_CACHE_PREFIX = 'cp-user-';
/** The worker's own small state (last known user, locale), kept in Cache Storage so it survives restarts. */
export const META_CACHE = 'cp-meta';

/** Caches that may hold private data: removed on logout and whenever another user signs in. */
export function isPrivateCache(name: string): boolean {
  return name.startsWith(USER_CACHE_PREFIX) || name === PAGES_CACHE;
}

/** The user cache of one account. Ids are opaque UUIDs; anything else is reduced to safe characters. */
export function userCacheName(userId: string): string {
  return `${USER_CACHE_PREFIX}${userId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
}

/** Response header the worker adds when it answers from an offline snapshot: when the copy was saved (ISO time). */
export const SNAPSHOT_HEADER = 'carpal-offline-snapshot';

/** Inside the user cache: the list of saved pages the offline page shows (W-SYS-01). */
export const SAVED_PAGES_KEY = '/__carpal/saved-pages.json';
export interface SavedPage {
  /** Path and query of the page. */
  url: string;
  /** The page's <title>. */
  title: string;
  /** ISO time the copy was saved. */
  savedAt: string;
}

/** Messages from a page to the worker. */
export type PageMessage =
  /** The page's session view: the worker keeps private caches for this user only (null = signed out). */
  | { type: 'cp:session'; userId: string | null; locale: string }
  /** The page moved (client-side) to a page of an offline section: keep a copy of its document too. */
  | { type: 'cp:keep'; url: string }
  /** Logout: drop every private cache now. */
  | { type: 'cp:logout' }
  /** The page accepted an update: activate the waiting worker. */
  | { type: 'cp:skip-waiting' }
  /** Version check (tests and the settings Help section). */
  | { type: 'cp:version' };

/** Messages from the worker to pages. */
export type WorkerMessage = { type: 'cp:version'; version: string } | { type: 'cp:caches-cleared' };

/** Settings the /sw.js route puts in front of the worker bundle (self.__CARPAL_SW__). */
export interface WorkerConfig {
  /** Changes with every build of the worker or the app; a new value is a new worker (the update flow). */
  version: string;
  /** Where notifications of a business (organization_context_id) open (DI-16). */
  portalUrl: string;
  /** Locales with an offline page. */
  locales: readonly string[];
}

export function isPageMessage(v: unknown): v is PageMessage {
  if (!v || typeof v !== 'object') return false;
  const type = (v as { type?: unknown }).type;
  return type === 'cp:session' || type === 'cp:keep' || type === 'cp:logout' || type === 'cp:skip-waiting' || type === 'cp:version';
}
