// W-NET-01 Saved & Following (mirrors C-PROF-05; P8.T5) at /<locale>/saved[?tab=following], signed in (private).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SavedScreen } from '@/features/community';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.saved'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const i18n = await serverI18n(await localeOf(params));
  return (
    <I18nNamespaces resources={i18n.resources(['community', 'profiles'])}>
      <Suspense>
        <SavedScreen />
      </Suspense>
    </I18nNamespaces>
  );
}
