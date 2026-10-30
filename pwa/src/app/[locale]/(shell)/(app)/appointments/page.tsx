// W-APP-01 Appointments (P10.T4; mirrors C-APP-01..04): /<locale>/appointments?seg=… — the list with segments and
// "Needs your action"; on wide screens the detail column waits for a choice. Private page behind the session gate.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppointmentsScreen } from '@/features/appointments';
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
  return { title: t('shell.nav.appointments'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const i18n = await serverI18n(await localeOf(params));
  return (
    <I18nNamespaces resources={i18n.resources(['appointments', 'profiles', 'help', 'reviews'])}>
      <Suspense>
        <AppointmentsScreen selectedId={null} />
      </Suspense>
    </I18nNamespaces>
  );
}
