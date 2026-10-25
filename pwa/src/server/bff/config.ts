// BFF configuration, passed in by the host (src/server/bff-runtime.ts builds it from the PWA environment). Nothing
// here reads process.env, so the BFF can move to backend/api-gateway unchanged (GD-03, BA-23).

export interface BffConfig {
  /** Public origin of the PWA, e.g. http://localhost:3000 (Origin check, redirect URI, cookie scope). */
  origin: string;
  /** Internal base URLs of the backend hosts (no trailing slash). */
  apiUrl: string;
  authUrl: string;
  /** Audience URL of the API host (DPoP htu in strict mode; backend CARPAL_API_AUDIENCE). */
  apiAudience: string;
  clientId: 'cp-web-consumer';
  ssrClientId: 'cp-ssr';
  /** Semver of this PWA build, sent in CarPal-Client. */
  clientVersion: string;
  /** Backend strict mode (CARPAL_STRICT_AUTH=1): PoW on the anonymous grant up front; DPoP everywhere a token is bound. */
  strict: boolean;
  /** Enabled UI locales; the first is the default. */
  locales: readonly string[];
  /** Lifetimes of cp-web-consumer (backend libs/auth CLIENTS): refresh 12 h idle, 7 days absolute. */
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
}

export const DEFAULT_LIFETIMES = { sessionIdleMs: 12 * 3_600_000, sessionAbsoluteMs: 7 * 24 * 3_600_000 } as const;

export const SESSION_COOKIE = '__Host-cp_sid';
/** The auth host's interaction cookie (40 §6.2); the only cookie the /id proxy passes to the auth host. */
export const INTERACTION_COOKIE = '__Host-cp_ia';
/** Largest request body the BFF accepts (the backend's MAX_BODY_BYTES is 64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;
/** Access tokens are refreshed this long before they expire. */
export const REFRESH_SKEW_MS = 30_000;

export function clientHeader(clientId: string, version: string): string {
  return `${clientId}/${version} (web 1.0)`;
}

export function redirectUri(config: Pick<BffConfig, 'origin'>): string {
  return `${config.origin}/bff/oauth/callback`;
}
