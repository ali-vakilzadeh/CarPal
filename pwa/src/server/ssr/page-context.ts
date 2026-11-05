// What a server-rendered public page needs besides its data (P5): the translator, a formatter with this browser's
// time zone (OQ-13: the cp_tz cookie, so server and client render the same text) and the region's price display
// (backend GD-41), the public origin for absolute URLs (JSON-LD, sitemaps), the site name and the region config.
import 'server-only';
import type { RegionConfig } from '@carpal/api-contracts';
import { createFormatter, priceDisplayOf, type Formatter } from '@/lib/format';
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
  const [i18n, timeZone, loaded] = await Promise.all([serverI18n(locale), requestTimeZone(), loadClientConfig(locale)]);
  const region = loaded.config.region;
  return {
    locale,
    i18n,
    t: i18n.t,
    f: createFormatter(locale, i18n.t, timeZone, region.distance_unit_default, priceDisplayOf(region)),
    timeZone,
    origin: serverEnv().CARPAL_PWA_ORIGIN,
    siteName: i18n.t('common.appName'),
    region,
    flags: flagsOf(loaded.config),
  };
}
