// W-APP-01 Appointment detail (P10.T4): /<locale>/appointments/<id> — the list beside the detail from 1024 px, the
// detail alone below. Also where appointment notifications open (P9.T1). 404 for an id that is not the caller's
// (SEC-AZ-2). Private page behind the session gate.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { AppointmentsScreen } from '@/features/appointments';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('appointments.detail.metaTitle'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const [locale, { id }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(id)) notFound();
  const i18n = await serverI18n(locale);
  return (
    <I18nNamespaces resources={i18n.resources(['appointments', 'profiles', 'help'])}>
      <Suspense>
        <AppointmentsScreen selectedId={id.toLowerCase()} />
      </Suspense>
    </I18nNamespaces>
  );
}
