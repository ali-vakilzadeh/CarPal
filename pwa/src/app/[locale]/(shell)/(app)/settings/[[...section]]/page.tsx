// W-SET-01 Settings (mirrors C-PROF-01..04, 07..09; P9.T2-T4) at /<locale>/settings/<section>, signed in (private).
// /<locale>/settings opens Profile; an unknown section is a 404.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import packageJson from '../../../../../../../package.json';
import { isSection, SettingsScreen, type Section } from '@/features/settings';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string; section?: string[] }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

async function sectionOf(params: Props['params']): Promise<Section> {
  const { section } = await params;
  if (!section || section.length === 0) return 'profile';
  if (section.length > 1 || !isSection(section[0])) notFound();
  return section[0];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.settings'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const [locale, section] = await Promise.all([localeOf(params), sectionOf(params)]);
  const i18n = await serverI18n(locale);
  return (
    // auth: the password strength words of the hosted sign-in.
    <I18nNamespaces resources={i18n.resources(['settings', 'auth'])}>
      <Suspense>
        <SettingsScreen section={section} policyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION} appVersion={packageJson.version} />
      </Suspense>
    </I18nNamespaces>
  );
}
