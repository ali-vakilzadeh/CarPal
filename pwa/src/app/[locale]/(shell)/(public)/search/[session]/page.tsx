// W-SRCH-01 Search results with map (P6.T2): /<locale>/search/<session_id>?<enumerated filters>. The session id and
// filter switches are all the URL holds (GD-14); the results come from the browser (the session's response is in
// this tab, or its stored request runs again). Not indexed.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { SearchScreen } from '@/features/search';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { mapStyleUrl } from '@/server/map-config';
import { pageContext } from '@/server/ssr/page-context';
import { chosenCity } from '@/server/ssr/search';

type Props = {
  params: Promise<{ locale: string; session: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await pageContext(await localeOf(params));
  return { title: ctx.t('search.metaTitle'), robots: { index: false, follow: true } };
}

export default async function SearchResultsPage({ params, searchParams }: Props) {
  const [locale, { session }, sp] = await Promise.all([localeOf(params), params, searchParams]);
  if (!SESSION_ID.test(session)) notFound();
  const ctx = await pageContext(locale);
  const { city } = await chosenCity(ctx, sp.city);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search', 'profiles'])}>
      <Suspense>
        <SearchScreen
          sessionId={session.toLowerCase()}
          privacyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION}
          styleUrl={mapStyleUrl(ctx.region)}
          defaultCity={city}
        />
      </Suspense>
    </I18nNamespaces>
  );
}
