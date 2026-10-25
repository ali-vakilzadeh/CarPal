// Root layout of every localized page: <html lang dir data-theme>, the design-system styles and the preload of
// the current language's font (P1.T8). The hosted sign-in (/id) and link pages (/l) get their own root layouts.
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import type { ReactNode } from 'react';
import { DS_FONT_BY_LOCALE, DS_STYLESHEETS } from '@/lib/design-system';
import { getTranslator } from '@/lib/i18n/dictionary';
import { LOCALES, directionOf, isLocale } from '@/lib/i18n/locales';
import { THEME_COOKIE, themeOrDefault } from '@/lib/theme';
import { serverEnv } from '@/server/env';
import '../globals.css';

// The proxy redirects any path whose first segment is not a locale, so dynamicParams stays on: turning it off here
// would also apply to the [...missing] catch-all and move its 404 out of this layout (no lang/dir, client-rendered).
export function generateStaticParams(): { locale: string }[] {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(isLocale(locale) ? locale : 'fa');
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
  const theme = themeOrDefault((await cookies()).get(THEME_COOKIE)?.value);
  const t = getTranslator(locale);
  preload(DS_FONT_BY_LOCALE[locale], { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });

  return (
    <html lang={locale} dir={directionOf(locale)} data-theme={theme}>
      <head>
        {DS_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="design-system" />
        ))}
      </head>
      <body>
        <a href="#main" className="cp-btn cp-btn-secondary sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4">
          {t('common.skipToContent')}
        </a>
        {children}
      </body>
    </html>
  );
}
