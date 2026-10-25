// The UI locale of the current request for components that receive no params (not-found pages): the proxy sets
// x-carpal-locale on every localized page request.
import 'server-only';
import { headers } from 'next/headers';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n/locales';

export async function requestLocale(): Promise<Locale> {
  const value = (await headers()).get('x-carpal-locale');
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
