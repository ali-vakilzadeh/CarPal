// Runs before routing on page paths (see config.matcher), adapted from pwa/src/proxy.ts (AC1.T5):
//   - security headers on every page: a per-request CSP nonce (Next.js reads it from the request's
//     Content-Security-Policy header and puts it on its scripts), Trusted Types, no framing, no-store, noindex;
//   - the UI language (GD-05, no locale segment): cpa_locale cookie, else Accept-Language, else the deployment
//     default; passed to server components as the x-carpal-locale request header;
//   - ?lang=fa|en and ?theme=light|sun|dark|auto store the choice in a cookie and redirect to the same page without
//     the parameter (work without JavaScript; the avatar menu of AC4 uses the same links);
//   - the sign-in pages (/id/…) speak the language the authorize request named (ui_locales), as the PWA's do;
//   - the page's path and query go to server components as x-carpal-path, so the console layout can send a signed-out
//     browser to the sign-in and back to the same page (AC4).
import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_HEADER, PATH_HEADER, isLocale, negotiateLocale } from './lib/i18n/locales';
import { ONE_YEAR_S, THEME_COOKIE, isTheme } from './lib/theme';
import { serverEnv } from './server/env';
import { createNonce, originsOf, pageSecurityHeaders } from './server/security-headers';

function secure(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const env = serverEnv();
  const url = request.nextUrl;
  const isSecure = url.protocol === 'https:';
  const nonce = createNonce();
  const https = env.CARPAL_ADMIN_ORIGIN.startsWith('https://');
  const headers = pageSecurityHeaders({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    https,
    // The media viewer of moderation cases (AC8) shows signed display copies from the storage host.
    mediaOrigins: originsOf(env.CARPAL_STORAGE_URL),
    // The map of the Locations tab (AC9) loads its style and tiles from the map style host when one is set.
    mapOrigins: originsOf(env.CARPAL_ADMIN_MAP_STYLE_URL),
    // OQ-11 (answered 2026-11-09): outside dev every page opens over https only. env.ts refuses an http origin there;
    // HSTS keeps browsers on https (nginx answers port 80 with a redirect, AC11).
    hsts: https && env.CARPAL_ADMIN_ENV !== 'dev',
  });

  const lang = url.searchParams.get('lang');
  const theme = url.searchParams.get('theme');
  if (lang !== null || theme !== null) {
    const target = url.clone();
    target.searchParams.delete('lang');
    target.searchParams.delete('theme');
    const response = NextResponse.redirect(target, 303);
    const cookie = { path: '/', sameSite: 'lax' as const, secure: isSecure, maxAge: ONE_YEAR_S };
    if (isLocale(lang)) response.cookies.set(LOCALE_COOKIE, lang, cookie);
    if (isTheme(theme)) response.cookies.set(THEME_COOKIE, theme, cookie);
    else if (theme === 'auto') response.cookies.set(THEME_COOKIE, '', { ...cookie, maxAge: 0 });
    return secure(response, headers);
  }

  const uiLocales = url.pathname.startsWith('/id/') ? url.searchParams.get('ui_locales') : null;
  const locale = isLocale(uiLocales)
    ? uiLocales
    : negotiateLocale(request.headers.get('accept-language'), request.cookies.get(LOCALE_COOKIE)?.value, env.CARPAL_ADMIN_DEFAULT_LOCALE);
  // The request carries the CSP too: Next.js takes the nonce from it while rendering (Next.js CSP guide).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', headers['content-security-policy']!);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(LOCALE_HEADER, locale);
  requestHeaders.set(PATH_HEADER, `${url.pathname}${url.search}`);
  return secure(NextResponse.next({ request: { headers: requestHeaders } }), headers);
}

export const config = {
  // Page paths only: not the BFF and API routes (/bff, /api) or the proxied auth-host endpoints (/id/oauth, /id/v1,
  // /id/.well-known), which set their own headers (src/server/bff/http.ts, AC3.T6); not Next.js internals, the
  // design-system files (/ds) or any file with an extension. The sign-in pages under /id (AC4) are pages and match.
  matcher: ['/((?!(?:api|bff)(?:/|$)|id/(?:oauth|v1|\\.well-known)(?:/|$)|_next/|ds/|.*\\.[A-Za-z0-9]+$).*)'],
};
