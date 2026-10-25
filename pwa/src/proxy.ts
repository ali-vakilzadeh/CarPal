// Locale routing (P1.T8). Runs before routing on page paths only (see config.matcher):
//   - a path without a locale prefix is redirected to /<locale>/<path> (remembered cookie, Accept-Language, region default);
//   - ?theme=light|sun|dark stores the theme choice and redirects to the same URL without the parameter;
//   - the locale is passed to server components as the x-carpal-locale request header (not-found pages have no params).
// Security headers (CSP nonce, Trusted Types …) are added here in P2.T8.
import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE, isLocale, negotiateLocale } from './lib/i18n/locales';
import { THEME_COOKIE, isTheme } from './lib/theme';

const ONE_YEAR_S = 365 * 24 * 60 * 60;

export function proxy(request: NextRequest): NextResponse {
  const url = request.nextUrl;
  const secure = url.protocol === 'https:';
  const first = url.pathname.split('/')[1];

  if (!isLocale(first)) {
    const locale = negotiateLocale(request.headers.get('accept-language'), request.cookies.get(LOCALE_COOKIE)?.value);
    const target = url.clone();
    target.pathname = `/${locale}${url.pathname === '/' ? '' : url.pathname}`;
    const response = NextResponse.redirect(target, 307);
    response.headers.set('Vary', 'Accept-Language, Cookie');
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  const theme = url.searchParams.get('theme');
  if (theme !== null) {
    const target = url.clone();
    target.searchParams.delete('theme');
    const response = NextResponse.redirect(target, 303);
    if (isTheme(theme)) response.cookies.set(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', secure, maxAge: ONE_YEAR_S });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  const headers = new Headers(request.headers);
  headers.set('x-carpal-locale', first);
  const response = NextResponse.next({ request: { headers } });
  if (request.cookies.get(LOCALE_COOKIE)?.value !== first) {
    response.cookies.set(LOCALE_COOKIE, first, { path: '/', sameSite: 'lax', secure, maxAge: ONE_YEAR_S });
  }
  return response;
}

export const config = {
  // Page paths only: not the BFF and API (/api, /bff), the hosted sign-in (/id), link pages (/l), Next.js
  // internals, the design-system files (/ds) or any file with an extension.
  matcher: ['/((?!(?:api|bff|id|l)(?:/|$)|_next/|ds/|.*\\.[A-Za-z0-9]+$).*)'],
};
