// CSRF (SEC-WEB-3): every state-changing BFF request needs X-CSRF-Token (the session's synchronizer token),
// Sec-Fetch-Site: same-origin and an Origin equal to the app origin. Safe requests are refused when the browser says
// they come from another site (defence in depth; the SameSite=Strict cookie already keeps the session out of them).
import { timingSafeEqual } from './crypto';
import type { SessionRecord } from './session/types';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfFailure = 'origin' | 'fetch_site' | 'token' | 'no_session';

export function checkSameOrigin(request: Request, origin: string): CsrfFailure | null {
  const site = request.headers.get('sec-fetch-site');
  if (SAFE_METHODS.has(request.method)) return site === 'cross-site' || site === 'same-site' ? 'fetch_site' : null;
  if (request.headers.get('origin') !== origin) return 'origin';
  if (site !== 'same-origin') return 'fetch_site';
  return null;
}

export function checkCsrf(request: Request, origin: string, session: SessionRecord | null): CsrfFailure | null {
  const sameOrigin = checkSameOrigin(request, origin);
  if (sameOrigin || SAFE_METHODS.has(request.method)) return sameOrigin;
  if (!session) return 'no_session';
  const token = request.headers.get('x-csrf-token');
  return token && timingSafeEqual(token, session.csrf) ? null : 'token';
}
