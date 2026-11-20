'use client';
// Staff recovery codes shown once (AC10b.T1, SEC-ADM-2): after the first security key, after an account recovery and
// after "New recovery codes". The codes live only in this component's state: never in browser storage, the query
// cache or a URL (GD-12), and the page cannot show them again. Print opens the browser's print dialog with only the
// codes on the sheet (auth.css @media print); "I have stored them" must be ticked before the staff member goes on.
import { useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { useT } from '@/lib/i18n/client';

export interface RecoveryCodesProps {
  codes: readonly string[];
  /** The button that leaves the codes behind (e.g. "Continue", "Done"). */
  doneLabel: string;
  onDone: () => void;
}

export function RecoveryCodes({ codes, doneLabel, onDone }: RecoveryCodesProps) {
  const t = useT();
  const id = useId();
  const [stored, setStored] = useState(false);
  const [tried, setTried] = useState(false);
  return (
    <section className="adm-codes" aria-labelledby={`${id}-title`} data-testid="recovery-codes">
      <h2 id={`${id}-title`} className="adm-codes-title">
        {t('admin.codes.title')}
      </h2>
      <p className="adm-codes-text">{t('admin.codes.text')}</p>
      <ol className="adm-codes-list" dir="ltr" translate="no">
        {codes.map((c) => (
          <li key={c}>
            <code data-testid="recovery-code">{c}</code>
          </li>
        ))}
      </ol>
      <p className="adm-codes-text adm-codes-noprint">{t('admin.codes.once')}</p>
      <div className="adm-codes-noprint adm-codes-actions">
        <Button icon="doc" onClick={() => window.print()}>
          {t('admin.codes.print')}
        </Button>
        <Check checked={stored} onChange={(e) => setStored(e.target.checked)}>
          {t('admin.codes.stored')}
        </Check>
        {tried && !stored ? (
          <p className="adm-auth-error" role="alert">
            {t('admin.codes.tickFirst')}
          </p>
        ) : null}
        <Button
          variant="primary"
          block
          onClick={() => {
            setTried(true);
            if (stored) onDone();
          }}
        >
          {doneLabel}
        </Button>
      </div>
    </section>
  );
}
