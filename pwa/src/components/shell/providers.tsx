'use client';
// Client providers of every localized page, fed by the [locale] root layout: the typed API client and TanStack
// Query (P2), the BFF session view seeded from the server, translations (the namespaces client components use),
// formatting settings, config.client, theme, toasts, analytics consent and the auth-intent modal.
import type { Resources } from '@/lib/i18n/keys';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { AnalyticsProvider } from '@/lib/analytics/client';
import type { Consent } from '@/lib/analytics/consent';
import type { ApiClient } from '@/lib/api/client';
import { ApiProvider } from '@/lib/api/query';
import { SESSION_QUERY_KEY, type SessionView } from '@/lib/api/session';
import { ConfigProvider, type PublicConfig } from '@/lib/config/client';
import { DEFAULT_PRICE_DISPLAY, TIME_ZONE_COOKIE, type PriceDisplay } from '@/lib/format';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/locales';
import type { Theme, ThemeChoice } from '@/lib/theme';
import { IntentProvider } from './auth-intent';
import { SessionNotices } from './session-notices';
import { ThemeProvider } from './theme-controller';
import { ToastProvider } from './toast';

/** The server's view of the session goes into the cache before anything reads it. Without a session cookie the
 * server could not tell (cross-site arrival), so the seed is marked stale and the browser asks /bff/session. */
function SessionSeed({ initial, confirmed, children }: { initial: SessionView; confirmed: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  useState(() => {
    if (queryClient.getQueryData(SESSION_QUERY_KEY) === undefined)
      queryClient.setQueryData(SESSION_QUERY_KEY, initial, { updatedAt: confirmed ? Date.now() : 0 });
    return null;
  });
  return <>{children}</>;
}

/** Tells the server the browser's time zone for the next render (dates in the viewer's zone); marks <html> as
 * hydrated (data-hydrated) so end-to-end tests interact only once React handles events. */
function TimeZoneSync({ serverZone }: { serverZone: string }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', 'true');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== serverZone)
      document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }, [serverZone]);
  return null;
}

export interface AppProvidersProps {
  locale: Locale;
  resources: Resources;
  config: PublicConfig;
  timeZone: string;
  /** This browser's price display (cp_price cookie, OQ-11). */
  prices?: PriceDisplay;
  themeChoice: ThemeChoice;
  theme: Theme;
  consent: Consent | null;
  session: SessionView;
  sessionConfirmed: boolean;
  /** Tests only: a fake typed client instead of the browser one. */
  apiClient?: ApiClient;
  children: ReactNode;
}

export function AppProviders(p: AppProvidersProps) {
  return (
    <ApiProvider client={p.apiClient}>
      <SessionSeed initial={p.session} confirmed={p.sessionConfirmed}>
        <I18nProvider locale={p.locale} resources={p.resources}>
          <FormatProvider
            timeZone={p.timeZone}
            distanceUnit={p.config.region.distance_unit_default}
            prices={p.prices ?? DEFAULT_PRICE_DISPLAY}
          >
            <ConfigProvider value={p.config}>
              <ThemeProvider initialChoice={p.themeChoice} initialTheme={p.theme}>
                <ToastProvider>
                  <AnalyticsProvider initialConsent={p.consent}>
                    <IntentProvider>{p.children}</IntentProvider>
                  </AnalyticsProvider>
                  <SessionNotices />
                </ToastProvider>
              </ThemeProvider>
            </ConfigProvider>
          </FormatProvider>
        </I18nProvider>
      </SessionSeed>
      <TimeZoneSync serverZone={p.timeZone} />
    </ApiProvider>
  );
}
