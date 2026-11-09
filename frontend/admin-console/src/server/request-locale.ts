// The UI language of the current request (GD-05): the proxy's x-carpal-locale header; when the proxy did not run
// (a path outside its matcher), the same negotiation from the cookie and Accept-Language.
import 'server-only';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, LOCALE_HEADER, isLocale, negotiateLocale, type Locale } from '@/lib/i18n/locales';
import { THEME_COOKIE, themeChoiceOf, DEFAULT_THEME, type Theme, type ThemeChoice } from '@/lib/theme';
import { serverEnv } from './env';

export async function requestLocale(): Promise<Locale> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const fromProxy = h.get(LOCALE_HEADER);
  if (isLocale(fromProxy)) return fromProxy;
  return negotiateLocale(h.get('accept-language'), c.get(LOCALE_COOKIE)?.value, serverEnv().CARPAL_ADMIN_DEFAULT_LOCALE);
}

export async function requestTheme(): Promise<{ choice: ThemeChoice; theme: Theme }> {
  const choice = themeChoiceOf((await cookies()).get(THEME_COOKIE)?.value);
  return { choice, theme: choice === 'auto' ? DEFAULT_THEME : choice };
}

export async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get('x-nonce') ?? undefined;
}
