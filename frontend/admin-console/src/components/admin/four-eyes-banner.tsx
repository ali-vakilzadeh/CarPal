'use client';
// FourEyesBanner and ActionNotice (AC5.T4, GD-11, SEC-ADM-6). A write answered 202 PendingChange did not take effect:
// it waits for a second staff member, who decides it on Pending approvals; the requester sees what was filed, when it
// expires and where it is decided. ActionNotice turns the outcome of useAdminAction into one sentence: applied,
// waiting, accepted as a background job, or the problem explained (SELF_APPROVAL_FORBIDDEN is a rule, not an error).
import Link from 'next/link';
import type { PendingChange } from '@carpal/api-contracts';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useT } from '@/lib/i18n/client';
import type { Translate } from '@/lib/i18n/keys';
import type { ActionState } from './admin-action';
import { opLabel } from './op-label';

export function FourEyesBanner({ change, showLink = true }: { change: PendingChange; showLink?: boolean }) {
  const t = useT();
  const f = useFormat();
  return (
    <div data-kit="four-eyes-banner" data-change={change.change_id}>
      <Banner tone="warn" icon="clock" title={t('admin.kit.fourEyes.title')}>
        <p className="pwa-banner-text">{t('admin.kit.fourEyes.text', { op: opLabel(change.op_id, t) })}</p>
        <p className="pwa-banner-text">
          <Bidi>{change.summary}</Bidi>
        </p>
        <p className="pwa-banner-text adm-muted">{t('admin.kit.fourEyes.expires', { when: f.date(change.expires_at, 'dateTime') })}</p>
        {showLink ? (
          <p className="pwa-banner-text">
            <Link href="/approvals">{t('admin.kit.fourEyes.link')}</Link>
          </p>
        ) : null}
      </Banner>
    </div>
  );
}

/** One sentence for a problem of an admin write (the screen may add its own words before it). */
export function problemText(p: ApiProblem, t: Translate): string {
  if (p.selfApproval) return t('admin.kit.problem.selfApproval');
  if (p.code === 'INVALID_TRANSITION') return t('admin.kit.problem.invalidTransition');
  if (p.preconditionFailed) return t('admin.kit.problem.changed');
  if (p.code === 'DUPLICATE') return t('admin.kit.problem.duplicate');
  if (p.purposeMismatch) return t('admin.kit.problem.purposeMismatch');
  if (p.purposeRequired) return t('admin.kit.problem.purpose');
  if (p.status === 403) return t('admin.kit.problem.forbidden');
  if (p.status === 404) return t('admin.kit.problem.notFound');
  if (p.status === 422) return t('admin.kit.problem.invalid');
  if (p.rateLimited || p.code === 'PAUSED') return t('admin.kit.problem.busy');
  if (p.status === 0) return t('admin.kit.problem.network');
  return t('admin.kit.problem.other');
}

/**
 * The result of a kit action, ready to show under the action (nothing while idle or busy). `onReload` (ETAG screens,
 * AC6) adds a Reload button when someone changed the record meanwhile (412/428): the screen re-reads the record and
 * keeps what the staff member typed.
 */
export function ActionNotice<T>({ state, applied, onReload }: { state: ActionState<T>; applied?: string; onReload?: () => void }) {
  const t = useT();
  if (state.status === 'done') {
    const o = state.outcome;
    if (o.kind === 'pending') return <FourEyesBanner change={o.change} />;
    if (o.kind === 'accepted') return <Banner tone="info" text={t('admin.kit.outcome.accepted')} />;
    return (
      <div data-kit="outcome" data-outcome="applied">
        <Banner tone="success" text={applied ?? t('admin.kit.outcome.applied')} />
      </div>
    );
  }
  if (state.status === 'failed') {
    const p = state.problem;
    return (
      <div data-kit="outcome" data-outcome="failed" data-code={p.code}>
        <Banner
          tone={p.selfApproval ? 'warn' : 'danger'}
          title={p.selfApproval ? t('admin.kit.problem.selfApprovalTitle') : undefined}
          text={
            <>
              {problemText(p, t)}
              {p.requestId ? (
                <span className="adm-muted">
                  {' '}
                  {t('admin.kit.problem.requestId')} <Bidi ltr>{p.requestId}</Bidi>
                </span>
              ) : null}
            </>
          }
        />
        {p.preconditionFailed && onReload ? (
          <Button size="sm" icon="refresh" onClick={onReload}>
            {t('admin.kit.problem.reload')}
          </Button>
        ) : null}
      </div>
    );
  }
  return null;
}
