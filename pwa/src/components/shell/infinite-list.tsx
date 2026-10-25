'use client';
// Infinite list with anchors (Docs/22 §2.5): more items load when the end comes near (IntersectionObserver, plus a
// "Show more" button for keyboards and old browsers); the back button returns to the same scroll position (the pages
// stay in the TanStack cache, and the position saved when leaving is restored after a back/forward navigation);
// a "Back to top" button appears after three screens. Loading = skeleton cards, failure = GD-13 state with Retry.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { useT } from '@/lib/i18n/client';
import { ErrorState } from './error-boundary';
import { SkeletonList } from './skeleton';

export interface InfiniteListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  status: 'pending' | 'error' | 'success';
  error?: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
  /** Shown when the list is empty. */
  empty: ReactNode;
  /** Accessible name of the list. */
  label: string;
  /** Identifies the list for scroll restoration (e.g. "feed:discover"). */
  restoreKey: string;
}

// Back/forward navigations: the App Router handles popstate; listening too tells lists to restore their position.
let lastPopAt = 0;
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (lastPopAt = Date.now()));

const storageKey = (key: string) => `cp:scroll:${key}:${location.pathname}${location.search}`;

function useScrollRestoration(key: string, ready: boolean) {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    try {
      const saved = sessionStorage.getItem(storageKey(key));
      if (saved && Date.now() - lastPopAt < 2_000) window.scrollTo({ top: Number(saved) });
    } catch {
      /* storage blocked: the browser's own restoration still applies */
    }
  }, [key, ready]);
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(storageKey(key), String(Math.round(window.scrollY)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      save();
      window.removeEventListener('pagehide', save);
    };
  }, [key]);
}

export function BackToTop() {
  const t = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight * 3);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <Button
      className="pwa-back-to-top"
      icon="up"
      size="sm"
      onClick={() => {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
        document.getElementById('main')?.focus({ preventScroll: true });
      }}
    >
      {t('common.actions.backToTop')}
    </Button>
  );
}

export function InfiniteList<T>(p: InfiniteListProps<T>) {
  const t = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  useScrollRestoration(p.restoreKey, p.status === 'success');

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = p;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (p.status === 'pending') return <SkeletonList label={t('common.loading')} />;
  if (p.status === 'error' && p.items.length === 0) return <ErrorState error={p.error} onRetry={() => void p.refetch()} />;
  if (p.items.length === 0) return <>{p.empty}</>;

  return (
    <div className="pwa-infinite">
      <ul className="pwa-infinite-list" aria-label={p.label} aria-busy={isFetchingNextPage || undefined}>
        {p.items.map((item, i) => (
          <li key={p.getKey(item)}>{p.renderItem(item, i)}</li>
        ))}
      </ul>
      {isFetchingNextPage ? <SkeletonList count={1} label={t('common.loading')} /> : null}
      {p.status === 'error' ? <ErrorState error={p.error} onRetry={() => void fetchNextPage()} compact /> : null}
      {hasNextPage && !isFetchingNextPage && p.status !== 'error' ? (
        <div ref={sentinel} className="pwa-infinite-more">
          <Button onClick={() => void fetchNextPage()}>{t('common.actions.loadMore')}</Button>
        </div>
      ) : null}
      <BackToTop />
    </div>
  );
}
