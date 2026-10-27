// Shared server parts of the garage pages (P7): the locale, the private-page metadata (noindex; the proxy adds
// no-store) and the client namespaces the garage screens use. Ids in the path are checked before anything renders.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import type { MessageKey } from '@/lib/i18n/keys';
import { serverI18n } from '@/server/i18n';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function localeOf(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function garageMetadata(params: Promise<{ locale: string }>, title: MessageKey = 'shell.nav.garage'): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t(title), robots: { index: false, follow: false } };
}

export async function GaragePage({ locale, children }: { locale: Locale; children: ReactNode }) {
  const i18n = await serverI18n(locale);
  return <I18nNamespaces resources={i18n.resources(['garage', 'media', 'onboarding'])}>{children}</I18nNamespaces>;
}
