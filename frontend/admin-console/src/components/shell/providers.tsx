'use client';
// Client providers of every page (AC1): translations of the request language, the formatters (Jalali in FA,
// Gregorian in EN; GD-05) and the hydration mark the E2E waits for. AC3 adds the TanStack Query client (in-memory
// cache only, cleared on sign-out; GD-12) and the BFF session.
import { useEffect, type ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import type { Resources } from '@/lib/i18n/keys';
import type { Locale } from '@/lib/i18n/locales';
import { FormatProvider } from '@/lib/format/client';

function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}

export function AppProviders({
  locale,
  resources,
  timeZone,
  children,
}: {
  locale: Locale;
  resources: Resources;
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <I18nProvider locale={locale} resources={resources}>
      <FormatProvider timeZone={timeZone} distanceUnit="km">
        <HydrationMark />
        {children}
      </FormatProvider>
    </I18nProvider>
  );
}
