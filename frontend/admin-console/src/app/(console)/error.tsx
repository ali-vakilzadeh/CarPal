'use client';
// 500 inside the console shell (AC4): an error in a console page keeps the top bar and the navigation. Shows the
// server's error digest as a reference (never the message or stack, which may carry data; GD-12) and a retry.
import { useEffect } from 'react';
import { SystemPage } from '@/components/shell/system-page';
import { useT } from '@/lib/i18n/client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    document.title = t('admin.system.error.metaTitle');
  }, [t]);
  return (
    <SystemPage
      kind="error"
      t={t}
      digest={error.digest}
      action={
        <button type="button" className="cp-btn cp-btn-primary" onClick={reset}>
          {t('common.actions.retry')}
        </button>
      }
    />
  );
}
