// W-ME-01 My Activity (mirrors C-PROF-06; P9.T5) at /<locale>/activity[?tab=…], signed in (private).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ActivityScreen } from '@/features/activity';
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
  return { title: t('shell.menu.activity'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const i18n = await serverI18n(await localeOf(params));
  return (
    <I18nNamespaces resources={i18n.resources(['activity', 'settings'])}>
      <Suspense>
        <ActivityScreen />
      </Suspense>
    </I18nNamespaces>
  );
}
