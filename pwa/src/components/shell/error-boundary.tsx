'use client';
// Error boundary with Retry for client islands (the route-level one is app/[locale]/error.tsx). A render error
// shows the GD-13 state for it (offline, AI off, removed …) and a Retry that resets the boundary and the failed
// TanStack queries below it.
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { useT } from '@/lib/i18n/client';
import { StateView, stateFromProblem } from './states';

interface BoundaryProps {
  children: ReactNode;
  fallback: (error: unknown, retry: () => void) => ReactNode;
  onReset?: () => void;
}

class Boundary extends Component<BoundaryProps, { error: unknown; failed: boolean }> {
  override state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  retry = () => {
    this.props.onReset?.();
    this.setState({ error: null, failed: false });
  };

  override render() {
    return this.state.failed ? this.props.fallback(this.state.error, this.retry) : this.props.children;
  }
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const t = useT();
  const kind = stateFromProblem(error);
  return (
    <StateView
      kind={kind}
      t={t}
      compact={compact}
      action={
        onRetry && kind !== 'removed' && kind !== 'notFound' ? (
          <Button icon="refresh" onClick={onRetry}>
            {t('common.actions.retry')}
          </Button>
        ) : null
      }
    />
  );
}

export function ErrorBoundary({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <Boundary onReset={reset} fallback={(error, retry) => <ErrorState error={error} onRetry={retry} compact={compact} />}>
          {children}
        </Boundary>
      )}
    </QueryErrorResetBoundary>
  );
}
