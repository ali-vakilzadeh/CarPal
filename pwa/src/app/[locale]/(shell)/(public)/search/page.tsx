// W-SRCH-01 Search (P6.T1/T2): the hand-over from the header search, the landing hero and recent searches (the text
// arrives in sessionStorage, never in the URL, GD-14) and, without one, the search entry. Runs search.run and moves
// to /<locale>/search/<session_id>. Not indexed (Docs/22 W-SRCH-01 SEO: directory pages are the indexed version).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SearchScreen } from '@/features/search';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { mapStyleUrl } from '@/server/map-config';
import { pageContext } from '@/server/ssr/page-context';
import { chosenCity } from '@/server/ssr/search';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await pageContext(await localeOf(params));
  return { title: ctx.t('search.metaTitle'), robots: { index: false, follow: true } };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const locale = await localeOf(params);
  const [ctx, sp] = await Promise.all([pageContext(locale), searchParams]);
  const { city } = await chosenCity(ctx, sp.city);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search', 'profiles'])}>
      <Suspense>
        <SearchScreen
          sessionId={null}
          privacyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION}
          styleUrl={mapStyleUrl(ctx.region)}
          defaultCity={city}
        />
      </Suspense>
    </I18nNamespaces>
  );
}
