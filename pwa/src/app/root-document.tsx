// The <html> document shared by the three root layouts — localized pages ([locale]), the hosted sign-in (/id, P4.T1)
// and link-token pages (/l, P4.T3/T5): lang/dir/data-theme, the design-system styles, the preload of the current
// language's font, the pre-paint theme script and the client providers (translations, config.client, the seeded BFF
// session, formatting, theme, toasts, consent, the auth-intent modal). Not a route file (colocated in app/).
import { cookies, headers } from 'next/headers';
import { preload } from 'react-dom';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/shell/providers';
import { ThemeBootScript } from '@/components/shell/theme-boot-script';
import { CONSENT_COOKIE, parseConsent } from '@/lib/analytics/consent';
import type { PublicConfig } from '@/lib/config/client';
import { DS_FONT_BY_LOCALE, DS_STYLESHEETS } from '@/lib/design-system';
import { PRICE_COOKIE, TIME_ZONE_COOKIE, parsePriceDisplay, validTimeZone } from '@/lib/format';
import type { Namespace } from '@/lib/i18n/keys';
import { directionOf, type Locale } from '@/lib/i18n/locales';
import { DEFAULT_THEME, THEME_COOKIE, themeChoiceOf } from '@/lib/theme';
import { flagsOf, loadClientConfig } from '@/server/config';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { serverSession } from '@/server/session';
import './globals.css';

/** Namespaces client components use everywhere; feature areas add theirs with <I18nNamespaces> or `namespaces`. */
export const CLIENT_NAMESPACES: readonly Namespace[] = [
  'common',
  'shell',
  'states',
  'system',
  'consent',
  'format',
  'vehicle',
  'notifications',
  'pwa',
];

export async function RootDocument({
  locale,
  namespaces = [],
  children,
}: {
  locale: Locale;
  /** Extra namespaces the whole document needs on the client (e.g. 'auth' for the hosted sign-in). */
  namespaces?: readonly Namespace[];
  children: ReactNode;
}) {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const themeChoice = themeChoiceOf(cookieStore.get(THEME_COOKIE)?.value);
  const theme = themeChoice === 'auto' ? DEFAULT_THEME : themeChoice;
  // The browser's zone once it told us (cp_tz); until then the deployment's default (OQ-13).
  const timeZone = validTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value) ?? serverEnv().CARPAL_PWA_DEFAULT_TIME_ZONE;
  const [loaded, i18n, session] = await Promise.all([loadClientConfig(locale), serverI18n(locale), serverSession()]);
  const config: PublicConfig = {
    flags: flagsOf(loaded.config),
    region: loaded.config.region,
    taxonomyVersion: loaded.config.taxonomy_version,
    i18nVersion: loaded.config.i18n.version,
    source: loaded.source,
    pwa: { vapidPublicKey: serverEnv().CARPAL_PWA_VAPID_PUBLIC_KEY ?? null, portalUrl: serverEnv().CARPAL_PWA_PORTAL_URL },
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
          resources={i18n.resources([...CLIENT_NAMESPACES, ...namespaces])}
          config={config}
          timeZone={timeZone}
          prices={parsePriceDisplay(cookieStore.get(PRICE_COOKIE)?.value)}
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
