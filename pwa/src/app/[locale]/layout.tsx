// Root layout of every localized page: the shared <html> document (src/app/root-document.tsx: lang/dir/data-theme,
// design-system styles, font preload, pre-paint theme script, client providers). The app shell itself is the (shell)
// group's layout, so system pages and full-screen flows (onboarding) render without it. The hosted sign-in (/id) and
// link pages (/l) have their own root layouts over the same document.
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LOCALES, isLocale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { RootDocument } from '../root-document';

// The proxy redirects any path whose first segment is not a locale, so dynamicParams stays on: turning it off here
// would also apply to the [...missing] catch-all and move its 404 out of this layout (no lang/dir, client-rendered).
export function generateStaticParams(): { locale: string }[] {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const { t } = await serverI18n(isLocale(locale) ? locale : 'fa');
  return {
    metadataBase: new URL(serverEnv().CARPAL_PWA_ORIGIN),
    title: { default: t('common.appName'), template: `%s · ${t('common.appName')}` },
    applicationName: t('common.appName'),
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RootDocument locale={locale}>{children}</RootDocument>;
}
