// Root layout of every localized page: the shared <html> document (src/app/root-document.tsx: lang/dir/data-theme,
// design-system styles, font preload, pre-paint theme script, client providers). The app shell itself is the (shell)
// group's layout, so system pages and full-screen flows (onboarding) render without it. The hosted sign-in (/id) and
// link pages (/l) have their own root layouts over the same document.
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { THEME_COLORS } from '@/features/pwa';
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
  const lang = isLocale(locale) ? locale : 'fa';
  const { t } = await serverI18n(lang);
  return {
    metadataBase: new URL(serverEnv().CARPAL_PWA_ORIGIN),
    title: { default: t('common.appName'), template: `%s · ${t('common.appName')}` },
    applicationName: t('common.appName'),
    // P12.T1: the web app manifest of the page language, the home-screen icon of iOS.
    manifest: `/manifests/${lang}.webmanifest`,
    icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], apple: '/icons/apple-touch-icon.png' },
    appleWebApp: { capable: true, title: t('common.appName'), statusBarStyle: 'default' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLORS.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark },
  ],
};

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RootDocument locale={locale}>{children}</RootDocument>;
}
