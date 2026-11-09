'use client';
// 500 (AC1.T5): errors below the root layout outside the console shell (sign-in pages, the console layout itself), in
// the plain frame (AC4). Shows the server's error digest as a reference (never the message or stack, which may carry
// data; GD-12) and a retry.
import { useEffect } from 'react';
import { PlainFrame } from '@/components/shell/plain-frame';
import { SystemPage } from '@/components/shell/system-page';
import { useT } from '@/lib/i18n/client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    document.title = t('admin.system.error.metaTitle');
  }, [t]);
  return (
    <PlainFrame>
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
    </PlainFrame>
  );
}
