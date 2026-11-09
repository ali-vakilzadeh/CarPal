// Browser seams (AC4), copied from pwa/src/lib/browser-nav.ts and browser-value.ts: full-page navigations that leave
// the App Router (sign-in, step-up, sign-out) go through goTo() so tests can observe them (jsdom cannot navigate), and
// useBrowserValue() reads a value only the browser knows without a setState in an effect.
import { useSyncExternalStore } from 'react';

export function goTo(url: string): void {
  window.location.assign(url);
}

const never = () => () => {};

/** `read` must return a stable value (e.g. a primitive); the server render and hydration use `server`. */
export function useBrowserValue<T>(read: () => T, server: T): T {
  return useSyncExternalStore(never, read, () => server);
}
