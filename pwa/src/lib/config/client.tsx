'use client';
// config.client in client components (P3.T7): the server layout passes the cached configuration down once per page;
// useFlag() treats unknown flags as off (GD-13), useRegion() gives the region (map, cities, navigation apps,
// currency, calendar, distance unit), useTaxonomyVersion() keys the client taxonomy cache.
import type { RegionConfig } from '@carpal/api-contracts';
import { createContext, useContext, type ReactNode } from 'react';

export interface PublicConfig {
  flags: Record<string, boolean>;
  region: RegionConfig;
  taxonomyVersion: string;
  i18nVersion: string;
  /** live = fresh from the API; stale = served from cache while refreshing; fallback = region file, flags off. */
  source: 'live' | 'stale' | 'fallback';
  /** PWA settings of this deployment (P12): the web push key (null = no web push), the business portal and (P13) the support address. */
  pwa?: PwaConfig;
}

export interface PwaConfig {
  vapidPublicKey: string | null;
  portalUrl: string;
  /** "Contact support" (OQ-18): an email address for the MVP. */
  supportEmail: string;
  /**
   * The pilot region's time zone (CARPAL_PWA_DEFAULT_TIME_ZONE, OQ-13): shop times such as a result card's next open
   * slot are shown in it, because ResultCard carries no location time zone (P14.T3).
   */
  regionTimeZone: string;
}

const DEFAULT_PWA: PwaConfig = {
  vapidPublicKey: null,
  portalUrl: 'https://web.carpals.ir',
  supportEmail: 'support@carpals.ir',
  regionTimeZone: 'Asia/Tehran',
};

const ConfigContext = createContext<PublicConfig | null>(null);

export function ConfigProvider({ value, children }: { value: PublicConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): PublicConfig {
  const value = useContext(ConfigContext);
  if (!value) throw new Error('useConfig outside <ConfigProvider>');
  return value;
}

export function useFlag(key: string): boolean {
  return useConfig().flags[key] === true;
}

export function useRegion(): RegionConfig {
  return useConfig().region;
}

export function useTaxonomyVersion(): string {
  return useConfig().taxonomyVersion;
}

export function usePwaConfig(): PwaConfig {
  return useConfig().pwa ?? DEFAULT_PWA;
}
