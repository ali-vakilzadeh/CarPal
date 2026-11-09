// Admin BFF configuration (AC3.T1). Adapted from pwa/src/server/bff/config.ts (GD-03): one client (cp-web-admin), one
// backend audience (admin-api), staff lifetimes, and cookie names of its own. Passed in by the host
// (src/server/bff-runtime.ts builds it from the console environment); nothing here reads process.env, so the BFF can
// move to backend/api-gateway or a shared package unchanged.

export interface BffConfig {
  /** Public origin of the console, e.g. http://localhost:3200 (Origin check, redirect URI). */
  origin: string;
  /** Internal base URLs of the backend hosts (no trailing slash). */
  adminApiUrl: string;
  authUrl: string;
  /** Audience URL of the admin-api host (DPoP htu; backend CARPAL_ADMIN_API_AUDIENCE). */
  adminApiAudience: string;
  clientId: 'cp-web-admin';
  /** Semver of this console build, sent in CarPal-Client. */
  clientVersion: string;
  /** Enabled UI locales; the first is the default. */
  locales: readonly string[];
  /** Cookie that holds the staff member's language choice (src/lib/i18n/locales.ts LOCALE_COOKIE). */
  localeCookie: string;
  /** cp-web-admin lifetimes (backend libs/auth CLIENTS): refresh 30 min idle, 8 h absolute (GD-03). */
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  /**
   * The registered redirect URI when it differs from <origin>/bff/oauth/callback. Dev and E2E only (OQ-11): the
   * backend registers https URIs only, so the /id proxy maps the https callback back to this http origin.
   */
  redirectUri?: string;
}

export const DEFAULT_LIFETIMES = { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 8 * 3_600_000 } as const;

/**
 * The console's own cookie names. They differ from the PWA's (__Host-cp_sid, __Host-cp_iar) because cookies are not
 * scoped by port: in development both apps run on localhost and would otherwise overwrite each other's session.
 */
export const SESSION_COOKIE = '__Host-cpa_sid';
/** The auth host's interaction cookie (40 §6.2; its name is the backend's); the only cookie the /id proxy passes on. */
export const INTERACTION_COOKIE = '__Host-cp_ia';
/** Set by the /id proxy next to the interaction cookie: the authorize query that started it (resume after sign-in). */
export const RESUME_COOKIE = '__Host-cpa_iar';
/** Largest request body the BFF accepts (the backend's MAX_BODY_BYTES is 64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;
/** Access tokens are refreshed this long before they expire. */
export const REFRESH_SKEW_MS = 30_000;

export function clientHeader(clientId: string, version: string): string {
  return `${clientId}/${version} (web 1.0)`;
}

export function redirectUri(config: Pick<BffConfig, 'origin' | 'redirectUri'>): string {
  return config.redirectUri ?? `${config.origin}/bff/oauth/callback`;
}
