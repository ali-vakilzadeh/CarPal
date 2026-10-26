'use client';
// useFormat(): the formatters of src/lib/format bound to the UI language, the viewer's time zone (from the shell),
// the region's distance unit and this browser's price display (OQ-11).
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLocale, useT } from '@/lib/i18n/client';
import { createFormatter, DEFAULT_PRICE_DISPLAY, DEFAULT_TIME_ZONE, type Formatter, type PriceDisplay } from './index';

interface FormatSettings {
  timeZone: string;
  distanceUnit: 'km' | 'mi';
  prices?: PriceDisplay;
}

const FormatContext = createContext<FormatSettings>({ timeZone: DEFAULT_TIME_ZONE, distanceUnit: 'km' });

export function FormatProvider({ timeZone, distanceUnit, prices, children }: FormatSettings & { children: ReactNode }) {
  const value = useMemo(() => ({ timeZone, distanceUnit, prices }), [timeZone, distanceUnit, prices]);
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): Formatter {
  const locale = useLocale();
  const t = useT();
  const { timeZone, distanceUnit, prices = DEFAULT_PRICE_DISPLAY } = useContext(FormatContext);
  return useMemo(() => createFormatter(locale, t, timeZone, distanceUnit, prices), [locale, t, timeZone, distanceUnit, prices]);
}

/** This browser's price display (the settings page shows and changes it). */
export function usePriceDisplay(): PriceDisplay {
  return useContext(FormatContext).prices ?? DEFAULT_PRICE_DISPLAY;
}
