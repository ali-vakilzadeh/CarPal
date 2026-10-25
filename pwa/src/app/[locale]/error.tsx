'use client';
// Route-level error boundary with Retry (P3.T5): an unexpected render error in a localized page shows the GD-13 state
// for it (offline, AI off, removed …, or "Something went wrong") inside the root layout, and Retry re-renders the
// segment. Next.js 16 passes `retry` (older releases called it `reset`).
import { useEffect } from 'react';
import { ErrorState } from '@/components/shell/error-boundary';

export default function RouteError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error('route error', error);
  }, [error]);
  return (
    <main id="main" tabIndex={-1} className="pwa-system-main">
      <ErrorState error={error} onRetry={retry ?? reset} />
    </main>
  );
}
