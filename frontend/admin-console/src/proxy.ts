// Runs before routing on page paths (see config.matcher), adapted from pwa/src/proxy.ts (AC1.T5):
//   - security headers on every page: a per-request CSP nonce (Next.js reads it from the request's
//     Content-Security-Policy header and puts it on its scripts), Trusted Types, no framing, no-store, noindex;
//   - the UI language (GD-05, no locale segment): cpa_locale cookie, else Accept-Language, else the deployment
//     default; passed to server components as the x-carpal-locale request header;
//   - ?lang=fa|en and ?theme=light|sun|dark|auto store the choice in a cookie and redirect to the same page without
//     the parameter (work without JavaScript; the avatar menu of AC4 uses the same links).
import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, LOCALE_HEADER, isLocale, negotiateLocale } from './lib/i18n/locales';
import { ONE_YEAR_S, THEME_COOKIE, isTheme } from './lib/theme';
import { serverEnv } from './server/env';
import { createNonce, pageSecurityHeaders } from './server/security-headers';

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
    hsts: https && env.CARPAL_ADMIN_ENV === 'prod',
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

  const locale = negotiateLocale(
    request.headers.get('accept-language'),
    request.cookies.get(LOCALE_COOKIE)?.value,
    env.CARPAL_ADMIN_DEFAULT_LOCALE,
  );
  // The request carries the CSP too: Next.js takes the nonce from it while rendering (Next.js CSP guide).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', headers['content-security-policy']!);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(LOCALE_HEADER, locale);
  return secure(NextResponse.next({ request: { headers: requestHeaders } }), headers);
}

export const config = {
  // Page paths only: not the BFF and API routes (/bff, /api; AC3), Next.js internals, the design-system files (/ds)
  // or any file with an extension.
  matcher: ['/((?!(?:api|bff)(?:/|$)|_next/|ds/|.*\\.[A-Za-z0-9]+$).*)'],
};
