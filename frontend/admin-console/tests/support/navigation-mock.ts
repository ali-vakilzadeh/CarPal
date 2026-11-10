// A next/navigation stand-in for DOM tests (AC5): the URL lives in a small store, router.replace/push change it and
// every component that reads usePathname/useSearchParams renders again. Use in a test file as
//   vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
export const nav = { pathname: '/', search: '', replaced: [] as string[], pushed: [] as string[] };

export function setUrl(url: string): void {
  const u = new URL(url, 'http://console.test');
  nav.pathname = u.pathname;
  nav.search = u.search.replace(/^\?/, '');
  for (const l of [...listeners]) l();
}

export function resetNav(url = '/'): void {
  nav.replaced = [];
  nav.pushed = [];
  setUrl(url);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const router = {
  replace: (url: string) => {
    nav.replaced.push(url);
    setUrl(url);
  },
  push: (url: string) => {
    nav.pushed.push(url);
    setUrl(url);
  },
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  prefetch: () => undefined,
};

export function navigationMock() {
  return {
    usePathname: () =>
      useSyncExternalStore(
        subscribe,
        () => nav.pathname,
        () => nav.pathname,
      ),
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(
          subscribe,
          () => nav.search,
          () => nav.search,
        ),
      ),
    useRouter: () => router,
    redirect: (url: string) => {
      throw new Error(`redirect ${url}`);
    },
    notFound: () => {
      throw new Error('notFound');
    },
  };
}
