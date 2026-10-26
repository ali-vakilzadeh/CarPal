// A value only the browser knows (feature support, location.origin) without a setState-in-effect: the server render
// and hydration use `server`, the browser then reads `read()` (useSyncExternalStore; `read` must return a stable
// value, e.g. a primitive).
import { useSyncExternalStore } from 'react';

const never = () => () => {};

export function useBrowserValue<T>(read: () => T, server: T): T {
  return useSyncExternalStore(never, read, () => server);
}
