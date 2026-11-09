// Root layout of every page (AC1.T5). No locale segment (GD-05): lang/dir come from the proxy's negotiated locale,
// the theme from the cpa_theme cookie (pre-paint boot script for "automatic", GD-06). The console frame carries the
// environment badge on every page, the system pages included. AC4 replaces the frame with the full shell (top bar,
// role-filtered navigation) inside the (console) group's layout.
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import { EnvBadge } from '@/components/shell/env-badge';
import { AppProviders } from '@/components/shell/providers';
import { ThemeBootScript } from '@/components/shell/theme-boot-script';
import { DS_FONT_BY_LOCALE, DS_STYLESHEETS } from '@/lib/design-system';
import { getTranslator, pickNamespaces, BUNDLED } from '@/lib/i18n/dictionary';
import { directionOf } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { requestLocale, requestNonce, requestTheme } from '@/server/request-locale';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return {
    title: { default: t('admin.console.metaTitle'), template: `%s · ${t('admin.console.name')}` },
    applicationName: t('admin.console.name'),
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, theme, nonce] = await Promise.all([requestLocale(), requestTheme(), requestNonce()]);
  const env = serverEnv();
  const t = getTranslator(locale);
  preload(DS_FONT_BY_LOCALE[locale], { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });

  return (
    <html lang={locale} dir={directionOf(locale)} data-theme={theme.theme} data-theme-choice={theme.choice} suppressHydrationWarning>
      <head>
        {DS_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="design-system" />
        ))}
        <ThemeBootScript nonce={nonce} />
      </head>
      <body className="adm-body">
        <a href="#main" className="cp-btn cp-btn-secondary sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4">
          {t('common.skipToContent')}
        </a>
        <AppProviders locale={locale} resources={pickNamespaces(BUNDLED[locale])} timeZone={env.CARPAL_ADMIN_DEFAULT_TIME_ZONE}>
          <header className="adm-frame-bar">
            <Link href="/" className="adm-wordmark">
              {t('admin.console.name')}
            </Link>
            <EnvBadge env={env.CARPAL_ADMIN_ENV} t={t} />
          </header>
          <main id="main" className="adm-frame-main">
            {children}
          </main>
        </AppProviders>
      </body>
    </html>
  );
}
