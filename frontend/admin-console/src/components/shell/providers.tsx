'use client';
// Client providers of every page (AC1): translations of the request language, the formatters (Jalali in FA,
// Gregorian in EN; GD-05), the typed admin API client with its TanStack Query cache (AC3.T5: in memory only, cleared on
// sign-out, session end and staff switch; GD-12), the environment for client-rendered frames (AC4) and the hydration
// mark the E2E waits for. The server's session view seeds the cache (AC4), so the shell renders the staff member's
// navigation without a first round trip.
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import type { Resources } from '@/lib/i18n/keys';
import type { Locale } from '@/lib/i18n/locales';
import { validTimeZone } from '@/lib/format';
import { FormatProvider } from '@/lib/format/client';
import { ApiProvider } from '@/lib/api/query';
import type { SessionView } from '@/lib/api/session';
import type { AdminEnv } from './env-badge';

function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}

const EnvContext = createContext<AdminEnv>('dev');

/** The environment this console serves (GD-06), for client components that draw the badge. */
export function useAdminEnv(): AdminEnv {
  return useContext(EnvContext);
}

export function AppProviders({
  locale,
  resources,
  timeZone,
  env,
  session,
  children,
}: {
  locale: Locale;
  resources: Resources;
  timeZone: string;
  env: AdminEnv;
  session?: SessionView;
  children: ReactNode;
}) {
  return (
    <I18nProvider locale={locale} resources={resources}>
      <FormatProvider timeZone={validTimeZone(session?.staff?.timezone) ?? timeZone} distanceUnit="km">
        <EnvContext.Provider value={env}>
          <ApiProvider {...(session ? { initialSession: session } : {})}>
            <HydrationMark />
            {children}
          </ApiProvider>
        </EnvContext.Provider>
      </FormatProvider>
    </I18nProvider>
  );
}
