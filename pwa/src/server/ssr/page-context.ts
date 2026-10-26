// What a server-rendered public page needs besides its data (P5): the translator, a formatter with this browser's
// time zone and price display (OQ-11/OQ-13: the cp_tz and cp_price cookies, so server and client render the same
// text), the public origin for absolute URLs (JSON-LD, sitemaps), the site name and the region config.
import 'server-only';
import type { RegionConfig } from '@carpal/api-contracts';
import { cookies } from 'next/headers';
import { createFormatter, parsePriceDisplay, PRICE_COOKIE, type Formatter } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { flagsOf, loadClientConfig } from '@/server/config';
import { serverEnv } from '@/server/env';
import { serverI18n, type ServerI18n } from '@/server/i18n';
import { requestTimeZone } from './public-reads';

export interface PageContext {
  locale: Locale;
  i18n: ServerI18n;
  t: Translate;
  f: Formatter;
  timeZone: string;
  origin: string;
  siteName: string;
  region: RegionConfig;
  flags: Record<string, boolean>;
}

export async function pageContext(locale: Locale): Promise<PageContext> {
  const [i18n, timeZone, cookieStore, loaded] = await Promise.all([
    serverI18n(locale),
    requestTimeZone(),
    cookies(),
    loadClientConfig(locale),
  ]);
  const prices = parsePriceDisplay(cookieStore.get(PRICE_COOKIE)?.value);
  const region = loaded.config.region;
  return {
    locale,
    i18n,
    t: i18n.t,
    f: createFormatter(locale, i18n.t, timeZone, region.distance_unit_default, prices),
    timeZone,
    origin: serverEnv().CARPAL_PWA_ORIGIN,
    siteName: i18n.t('common.appName'),
    region,
    flags: flagsOf(loaded.config),
  };
}
