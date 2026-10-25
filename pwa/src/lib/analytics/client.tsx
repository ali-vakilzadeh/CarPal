'use client';
// The analytics context: one queue per tab, fed only while the visitor allows analytics. The consent itself is
// owned here too, so the cookie banner and the queue never disagree.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import packageJson from '../../../package.json';
import { useApiClient } from '@/lib/api/query';
import { ApiProblem } from '@/lib/api/problem';
import { uuidv7 } from '@/lib/api/uuid';
import { consentCookieString, type Consent } from './consent';
import type { EventName, EventProperties } from './events';
import { AnalyticsQueue } from './queue';

interface AnalyticsValue {
  consent: Consent | null;
  setConsent: (c: Consent) => void;
  track: <N extends EventName>(name: N, properties?: EventProperties<N>) => void;
}

const AnalyticsContext = createContext<AnalyticsValue | null>(null);

export function AnalyticsProvider({ initialConsent, children }: { initialConsent: Consent | null; children: ReactNode }) {
  const api = useApiClient();
  const [consent, setConsentState] = useState<Consent | null>(initialConsent);
  const [queue] = useState(() => {
    let allowed = initialConsent?.analytics === true;
    const q = new AnalyticsQueue({
      allowed: () => allowed,
      sessionId: uuidv7(),
      send: async (events) => {
        try {
          await api.api('events.ingest', { body: { platform: 'web_pwa', app_version: packageJson.version, events } });
        } catch (err) {
          throw Object.assign(new Error('events.ingest failed'), { status: err instanceof ApiProblem ? err.status : undefined });
        }
      },
    });
    return Object.assign(q, { setAllowed: (v: boolean) => (allowed = v) });
  });

  useEffect(() => queue.start(), [queue]);

  const setConsent = useCallback(
    (c: Consent) => {
      document.cookie = consentCookieString(c, location.protocol === 'https:');
      queue.setAllowed(c.analytics);
      if (!c.analytics) queue.clear();
      setConsentState(c);
    },
    [queue],
  );

  const track = useCallback<AnalyticsValue['track']>((name, properties) => void queue.track(name, properties), [queue]);
  const value = useMemo(() => ({ consent, setConsent, track }), [consent, setConsent, track]);
  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): AnalyticsValue {
  const value = useContext(AnalyticsContext);
  if (!value) throw new Error('useAnalytics outside <AnalyticsProvider>');
  return value;
}
