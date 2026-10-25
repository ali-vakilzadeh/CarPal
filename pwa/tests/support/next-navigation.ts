// Test double of next/navigation for DOM tests: `vi.mock('next/navigation', () => import('…/next-navigation'))`.
// The current URL lives in `navigation` and follows push/replace/back, like the App Router does.
import { vi } from 'vitest';

export const navigation = {
  pathname: '/fa',
  search: '',
  history: [] as string[],
  set(url: string) {
    const u = new URL(url, 'http://localhost');
    navigation.pathname = u.pathname;
    navigation.search = u.search.replace(/^\?/, '');
    listeners.forEach((fn) => fn());
  },
  reset(url = '/fa') {
    navigation.history = [];
    navigation.set(url);
    router.push.mockClear();
    router.replace.mockClear();
    router.back.mockClear();
  },
};

const listeners = new Set<() => void>();

export const router = {
  push: vi.fn((url: string) => {
    navigation.history.push(`${navigation.pathname}${navigation.search ? `?${navigation.search}` : ''}`);
    navigation.set(url);
  }),
  replace: vi.fn((url: string) => navigation.set(url)),
  back: vi.fn(() => {
    const prev = navigation.history.pop();
    if (prev) navigation.set(prev);
  }),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

import { useSyncExternalStore } from 'react';

function useUrl() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => `${navigation.pathname}?${navigation.search}`,
  );
}

export function usePathname() {
  useUrl();
  return navigation.pathname;
}

export function useSearchParams() {
  useUrl();
  return new URLSearchParams(navigation.search);
}

export function useRouter() {
  return router;
}

export function notFound(): never {
  throw new Error('NEXT_NOT_FOUND');
}

export function forbidden(): never {
  throw new Error('NEXT_FORBIDDEN');
}
