'use client';
// A CSS media query as a React value (server render and hydration use `server`). Used where hiding with CSS is not
// enough — e.g. the search page mounts the map pane (and loads MapLibre) only from 1200 px (Docs/22 §2 breakpoints).
import { useCallback, useSyncExternalStore } from 'react';

export const WIDE = '(min-width: 1200px)';
export const TABLET_UP = '(min-width: 768px)';

export function useMediaQuery(query: string, server = false): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const m = window.matchMedia(query);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : server),
    () => server,
  );
}
