// Root layout of every localized page: <html lang dir data-theme>, the design-system styles, the preload of the
// current language's font (P1.T8), the pre-paint theme script (P3.T3) and the client providers (P3): translations
// (CDN-refreshed when config.client says so), config.client, the seeded BFF session, theme, toasts, consent and the
// auth-intent modal. The app shell itself is the (shell) group's layout, so system pages render without it. The
// hosted sign-in (/id) and link pages (/l) get their own root layouts.
import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/shell/providers';
import { ThemeBootScript } from '@/components/shell/theme-boot-script';
import { CONSENT_COOKIE, parseConsent } from '@/lib/analytics/consent';
import type { PublicConfig } from '@/lib/config/client';
import { DS_FONT_BY_LOCALE, DS_STYLESHEETS } from '@/lib/design-system';
import { DEFAULT_TIME_ZONE, TIME_ZONE_COOKIE, validTimeZone } from '@/lib/format';
import type { Namespace } from '@/lib/i18n/keys';
import { LOCALES, directionOf, isLocale } from '@/lib/i18n/locales';
import { DEFAULT_THEME, THEME_COOKIE, themeChoiceOf } from '@/lib/theme';
import { flagsOf, loadClientConfig } from '@/server/config';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { serverSession } from '@/server/session';
import '../globals.css';

/** Namespaces client components use everywhere; feature areas add theirs with <I18nNamespaces>. */
const CLIENT_NAMESPACES: readonly Namespace[] = ['common', 'shell', 'states', 'system', 'consent', 'format', 'vehicle'];

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
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const themeChoice = themeChoiceOf(cookieStore.get(THEME_COOKIE)?.value);
  const theme = themeChoice === 'auto' ? DEFAULT_THEME : themeChoice;
  const timeZone = validTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value) ?? DEFAULT_TIME_ZONE;
  const [loaded, i18n, session] = await Promise.all([loadClientConfig(locale), serverI18n(locale), serverSession()]);
  const config: PublicConfig = {
    flags: flagsOf(loaded.config),
    region: loaded.config.region,
    taxonomyVersion: loaded.config.taxonomy_version,
    i18nVersion: loaded.config.i18n.version,
    source: loaded.source,
  };
  preload(DS_FONT_BY_LOCALE[locale], { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });

  return (
    <html lang={locale} dir={directionOf(locale)} data-theme={theme} data-theme-choice={themeChoice} suppressHydrationWarning>
      <head>
        {DS_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="design-system" />
        ))}
        <ThemeBootScript nonce={headerStore.get('x-nonce') ?? undefined} />
      </head>
      <body>
        <a href="#main" className="cp-btn cp-btn-secondary sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4">
          {i18n.t('common.skipToContent')}
        </a>
        <AppProviders
          locale={locale}
          resources={i18n.resources(CLIENT_NAMESPACES)}
          config={config}
          timeZone={timeZone}
          themeChoice={themeChoice}
          theme={theme}
          consent={parseConsent(cookieStore.get(CONSENT_COOKIE)?.value)}
          session={session.view}
          sessionConfirmed={session.confirmed}
        >
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
