// Shared server parts of the CarPal Workshop pages (provider plan PW1): the locale and the private-page metadata. The
// pages themselves are client screens of features/provider; the proxy marks /<locale>/provider private (no-store,
// noindex) and the service worker never keeps them (PRV-GD-05).
import type { Metadata } from 'next';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import type { MessageKey } from '@/lib/i18n/keys';
import { serverI18n } from '@/server/i18n';

export type LocaleParams = Promise<{ locale: string }>;

export async function localeOf(params: LocaleParams): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function workshopMetadata(params: LocaleParams, title?: MessageKey): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t(title ?? 'provider.metaTitle'), robots: { index: false, follow: false } };
}
