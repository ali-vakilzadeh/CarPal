'use client';
// profile.viewed (backend CLIENT_EVENTS, GD-17): once per page view of a provider or vendor profile, consent-gated by
// the analytics queue. The entry point is "search" when a search result opened the profile (DI-10 origin), "other"
// for a link inside CarPal, and "deep_link" for an arrival from outside (a search engine, a shared link).
import { useEffect, useRef } from 'react';
import { useAnalytics } from '@/lib/analytics/client';
import { readSearchOrigin } from './search-origin';

export function ProfileViewed({ orgId, targetType }: { orgId: string; targetType: 'provider' | 'vendor' }) {
  const { track } = useAnalytics();
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    let internal = false;
    try {
      internal = !!document.referrer && new URL(document.referrer).origin === window.location.origin;
    } catch {
      /* no referrer */
    }
    const entry = readSearchOrigin(orgId) ? 'search' : internal ? 'other' : 'deep_link';
    track('profile.viewed', { target_type: targetType, entry_point: entry });
  }, [orgId, targetType, track]);
  return null;
}
