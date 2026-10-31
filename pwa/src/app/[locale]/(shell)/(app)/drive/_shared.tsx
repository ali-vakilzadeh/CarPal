// Shared server parts of the driver pages (DRV-WEB, P12.T4): locale, private-page metadata, the client namespaces and
// the id check of the path (the backend answers 404 for a vehicle that is not assigned to the driver, SEC-AZ-2/7).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function localeOf(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function driveMetadata(params: Promise<{ locale: string }>, report = false): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t(report ? 'driver.form.title' : 'driver.title'), robots: { index: false, follow: false } };
}

export async function DrivePage({ locale, children }: { locale: Locale; children: ReactNode }) {
  const i18n = await serverI18n(locale);
  return <I18nNamespaces resources={i18n.resources(['driver', 'garage', 'media', 'appointments'])}>{children}</I18nNamespaces>;
}
