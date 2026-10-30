// W-HELP-01 Help Me (P10; mirrors C-HELP-01..03): the landing with Describe at /<locale>/help, also where request links
// of profiles, search, the map, favourites and the garage hand over (?provider…, ?vehicle&issue, ?urgent=1). A
// full-screen flow without the app shell (P3 notes); guests may describe and pick a category, starting needs sign-in
// (DI-04). Private page (no-store, noindex via the proxy).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FlowFrame } from '@/components/shell/flow-frame';
import { HelpEntry, HelpExit } from '@/features/help';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';
import { HELP_NAMESPACES } from './namespaces';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('help.metaTitle'), robots: { index: false, follow: false } };
}

export default async function HelpPage({ params }: Props) {
  const locale = await localeOf(params);
  const i18n = await serverI18n(locale);
  return (
    <I18nNamespaces resources={i18n.resources(HELP_NAMESPACES)}>
      <FlowFrame t={i18n.t} home={`/${locale}`} full end={<HelpExit saved={false} />}>
        <Suspense>
          <HelpEntry />
        </Suspense>
      </FlowFrame>
    </I18nNamespaces>
  );
}
