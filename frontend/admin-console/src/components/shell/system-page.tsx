// The console's system pages (AC1.T5): 404 not found, 403 no permission (AC4.T6 adds the role that is needed) and
// 500 error. Presentational only, so the server pages and the client error boundary share it.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Translate } from '@/lib/i18n/keys';

export type SystemKind = 'notFound' | 'forbidden' | 'error';

export function systemMetaTitle(kind: SystemKind, t: Translate): string {
  return t(`admin.system.${kind}.metaTitle`);
}

export function SystemPage({
  kind,
  t,
  digest,
  action,
  children,
}: {
  kind: SystemKind;
  t: Translate;
  digest?: string;
  action?: ReactNode;
  /** More text under the explanation (e.g. the roles a section needs, AC4.T6). */
  children?: ReactNode;
}) {
  return (
    <section className="adm-system" aria-labelledby="system-title" data-kind={kind}>
      <h1 id="system-title" className="adm-system-title">
        {t(`admin.system.${kind}.title`)}
      </h1>
      <p className="adm-system-text">{t(`admin.system.${kind}.text`)}</p>
      {children}
      {digest ? <p className="adm-system-ref">{t('admin.system.error.reference', { digest })}</p> : null}
      <div className="adm-system-actions">
        {action}
        <Link className="cp-btn cp-btn-secondary" href="/">
          {t('admin.system.home')}
        </Link>
      </div>
    </section>
  );
}
