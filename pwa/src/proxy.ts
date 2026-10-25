// Runs before routing on page paths (see config.matcher):
//   - security headers on every page (P2.T8, GD-15): a per-request CSP nonce (Next.js reads it from the request's
//     Content-Security-Policy header and puts it on its scripts), Trusted Types, COOP/CORP, Permissions-Policy …;
//     private pages (signed-in tools, /id, /l) also get no-store and noindex;
//   - locale routing (P1.T8) on everything but /id and /l: a path without a locale prefix is redirected to
//     /<locale>/<path> (remembered cookie, Accept-Language, region default); ?theme=light|sun|dark|auto stores the
//     theme choice and redirects; the locale is passed to server components as the x-carpal-locale request header;
//   - system pages with a real status (P3.T8): maintenance mode (CARPAL_PWA_MAINTENANCE) answers every localized page
//     with the 503 page; demo builds expose /<locale>/dev-kit/status/<kind> to exercise the status rewrite.
import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALES, isLocale, negotiateLocale } from './lib/i18n/locales';
import { THEME_COOKIE, isTheme } from './lib/theme';
import { serverEnv } from './server/env';
import { createNonce, isPrivatePage, originsOf, pageSecurityHeaders } from './server/security-headers';
import { MAINTENANCE_UNTIL_HEADER, SYSTEM_HEADER, maintenanceOf, systemRewrite } from './server/system-status';
import { isSystemKind } from './lib/system';

const ONE_YEAR_S = 365 * 24 * 60 * 60;

function securityHeaders(nonce: string): Record<string, string> {
  const env = serverEnv();
  const https = env.CARPAL_PWA_ORIGIN.startsWith('https://');
  return pageSecurityHeaders({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    https,
    hsts: https && env.CARPAL_ENV === 'prod',
    mediaOrigins: originsOf(env.CARPAL_STORAGE_URL),
    tileOrigins: originsOf(env.CARPAL_PWA_MAP_STYLE_URL),
  });
}

function secure(response: NextResponse, headers: Record<string, string>, privatePage: boolean): NextResponse {
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  if (privatePage) {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const url = request.nextUrl;
  const isSecure = url.protocol === 'https:';
  const first = url.pathname.split('/')[1];
  const nonce = createNonce();
  const headers = securityHeaders(nonce);
  const privatePage = isPrivatePage(url.pathname, LOCALES);

  // The request carries the CSP too: Next.js takes the nonce from it while rendering (Next.js CSP guide).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', headers['content-security-policy']!);
  requestHeaders.set('x-nonce', nonce);
  // Only the proxy marks system-page rewrites.
  requestHeaders.delete(SYSTEM_HEADER);
  requestHeaders.delete(MAINTENANCE_UNTIL_HEADER);

  if (first === 'id' || first === 'l') return secure(NextResponse.next({ request: { headers: requestHeaders } }), headers, true);

  if (!isLocale(first)) {
    const locale = negotiateLocale(request.headers.get('accept-language'), request.cookies.get(LOCALE_COOKIE)?.value);
    const target = url.clone();
    target.pathname = `/${locale}${url.pathname === '/' ? '' : url.pathname}`;
    const response = NextResponse.redirect(target, 307);
    response.headers.set('Vary', 'Accept-Language, Cookie');
    response.headers.set('Cache-Control', 'private, no-store');
    return secure(response, headers, false);
  }

  const theme = url.searchParams.get('theme');
  if (theme !== null) {
    const target = url.clone();
    target.searchParams.delete('theme');
    const response = NextResponse.redirect(target, 303);
    if (isTheme(theme)) response.cookies.set(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', secure: isSecure, maxAge: ONE_YEAR_S });
    else if (theme === 'auto') response.cookies.set(THEME_COOKIE, '', { path: '/', sameSite: 'lax', secure: isSecure, maxAge: 0 });
    response.headers.set('Cache-Control', 'private, no-store');
    return secure(response, headers, privatePage);
  }

  const env = serverEnv();
  const maintenance = maintenanceOf(env.CARPAL_PWA_MAINTENANCE);
  if (maintenance.active)
    return secure(systemRewrite(request, first, 'maintenance', requestHeaders, { until: maintenance.until }), headers, true);
  if (env.CARPAL_PWA_DEMO) {
    const demo = /^\/[a-z]{2}\/dev-kit\/status\/([a-z-]+)$/.exec(url.pathname);
    if (demo && isSystemKind(demo[1]) && demo[1] !== 'suspended') {
      const until = demo[1] === 'maintenance' ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
      return secure(systemRewrite(request, first, demo[1], requestHeaders, { until }), headers, true);
    }
  }

  requestHeaders.set('x-carpal-locale', first);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (request.cookies.get(LOCALE_COOKIE)?.value !== first) {
    response.cookies.set(LOCALE_COOKIE, first, { path: '/', sameSite: 'lax', secure: isSecure, maxAge: ONE_YEAR_S });
  }
  return secure(response, headers, privatePage);
}

export const config = {
  // Page paths only: not the BFF and API (/api, /bff), the auth-host proxy (/id/oauth, /id/v1, /id/.well-known),
  // Next.js internals, the design-system files (/ds) or any file with an extension. The hosted sign-in pages (/id/…)
  // and link pages (/l/…) are matched for their security headers.
  matcher: ['/((?!(?:api|bff)(?:/|$)|id/(?:oauth|v1|\\.well-known)(?:/|$)|_next/|ds/|.*\\.[A-Za-z0-9]+$).*)'],
};
