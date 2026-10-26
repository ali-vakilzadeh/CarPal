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
  /**
   * The registered redirect URI when it differs from <origin>/bff/oauth/callback. Dev and E2E only: the backend
   * accepts https redirect URIs only (DI-24), so a PWA served on http://localhost registers the https URL and the test
   * browser maps that one hop back to http (OQ-10: no local TLS).
   */
  redirectUri?: string;
}

export const DEFAULT_LIFETIMES = { sessionIdleMs: 12 * 3_600_000, sessionAbsoluteMs: 7 * 24 * 3_600_000 } as const;

export const SESSION_COOKIE = '__Host-cp_sid';
/** The auth host's interaction cookie (40 §6.2); the only cookie the /id proxy passes to the auth host. */
export const INTERACTION_COOKIE = '__Host-cp_ia';
/**
 * Set by the /id proxy next to the interaction cookie: the interaction id and the authorize query it came from, so the
 * hosted sign-in can re-request that authorize URL when the interaction is complete (BA-12). Same lifetime (30 min).
 */
export const RESUME_COOKIE = '__Host-cp_iar';
/** Set by the hosted sign-in when "Keep me signed in" is off; read and cleared by the OAuth callback (P4.T2). */
export const KEEP_COOKIE = 'cp_keep';
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
