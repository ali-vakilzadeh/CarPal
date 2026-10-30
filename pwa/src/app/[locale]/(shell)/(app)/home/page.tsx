// W-FEED-01 Home Timeline (mirrors C-HOME-01 and C-COMM-01; P8.T1) at /<locale>/home, signed in (private: no-store,
// noindex). The Discover feed uses the browser's city (cp_city, chosen on the landing page) or the region's first
// city.
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { HomeScreen } from '@/features/community';
import { CITY_COOKIE } from '@/features/landing';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';
import { pageContext } from '@/server/ssr/page-context';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.home'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const locale = await localeOf(params);
  const [ctx, cookieStore] = await Promise.all([pageContext(locale), cookies()]);
  const cities = ctx.region.cities.map((c) => c.city_key);
  const asked = cookieStore.get(CITY_COOKIE)?.value;
  const city = asked && cities.includes(asked) ? asked : cities[0]!;
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['community', 'profiles'])}>
      <HomeScreen cityKey={city} />
    </I18nNamespaces>
  );
}
