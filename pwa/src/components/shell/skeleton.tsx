// Skeleton loading (Docs/21 §2.3: lists and profiles show skeleton cards, never spinners; spinners only inside
// buttons). Purely visual: the region that loads carries aria-busy and a hidden "Loading…" for screen readers.
import { cx } from '@/components/ds/cx';

export function SkeletonLine({ width = 'full', large }: { width?: 'full' | 'half' | 'third' | 'twoThirds'; large?: boolean }) {
  return <span className={cx('pwa-skel', large && 'is-lg', `is-${width}`)} aria-hidden="true" />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="pwa-skel-card" aria-hidden="true">
      <div className="pwa-skel-row">
        <span className="pwa-skel is-avatar" />
        <div className="pwa-skel-col">
          <SkeletonLine width="half" />
          <SkeletonLine width="third" />
        </div>
      </div>
      {Array.from({ length: Math.max(0, lines - 1) }, (_, i) => (
        <SkeletonLine key={i} width={i % 2 ? 'twoThirds' : 'full'} />
      ))}
    </div>
  );
}

export function SkeletonList({ count = 3, label }: { count?: number; label: string }) {
  return (
    <div className="pwa-skel-list" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
