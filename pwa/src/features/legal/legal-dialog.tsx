'use client';
// The full text in the sign-up "Read" dialogs (S-AUTH-03, P13.T7). The texts load with import() when a dialog opens,
// so the hosted sign-in page does not carry them; the dialog also links the page for reading in a new tab.
import { useEffect, useState } from 'react';
import { SkeletonCard } from '@/components/shell/skeleton';
import { usePwaConfig } from '@/lib/config/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { LegalDocument } from './markdown';
import { LegalBody, type LegalKind } from './legal-text';

export function LegalDialogBody({ kind, version }: { kind: LegalKind; version: string }) {
  const t = useT();
  const locale = useLocale();
  const { supportEmail } = usePwaConfig();
  const [doc, setDoc] = useState<LegalDocument | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    import('./documents').then(
      (m) => live && setDoc(m.legalDoc(kind)),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [kind]);
  const href = `/${locale}/${kind}`;
  return (
    <div className="pwa-stack-sm">
      <p className="pwa-text-caption m-0">
        {t('auth.signup.legalVersion', { version })}{' '}
        <a className="pwa-link" href={href} target="_blank" rel="noopener">
          {t('auth.signup.legalOpen')}
        </a>
      </p>
      {locale !== 'en' ? <p className="pwa-legal-note pwa-text-caption m-0">{t('shell.legal.englishOnly')}</p> : null}
      {doc ? (
        <LegalBody doc={doc} fill={{ supportEmail, domain: window.location.host }} headingOffset={1} />
      ) : failed ? (
        <p className="pwa-text-body">{t('auth.signup.legalFailed')}</p>
      ) : (
        <SkeletonCard lines={8} />
      )}
    </div>
  );
}
