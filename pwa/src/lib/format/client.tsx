'use client';
// useFormat(): the formatters of src/lib/format bound to the UI language, the viewer's time zone (from the shell)
// and the region's distance unit.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLocale, useT } from '@/lib/i18n/client';
import { createFormatter, DEFAULT_TIME_ZONE, type Formatter } from './index';

interface FormatSettings {
  timeZone: string;
  distanceUnit: 'km' | 'mi';
}

const FormatContext = createContext<FormatSettings>({ timeZone: DEFAULT_TIME_ZONE, distanceUnit: 'km' });

export function FormatProvider({ timeZone, distanceUnit, children }: FormatSettings & { children: ReactNode }) {
  const value = useMemo(() => ({ timeZone, distanceUnit }), [timeZone, distanceUnit]);
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

export function useFormat(): Formatter {
  const locale = useLocale();
  const t = useT();
  const { timeZone, distanceUnit } = useContext(FormatContext);
  return useMemo(() => createFormatter(locale, t, timeZone, distanceUnit), [locale, t, timeZone, distanceUnit]);
}
