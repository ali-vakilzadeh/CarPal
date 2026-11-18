'use client';
// Badges of an organization (AC8.T5, AC10.T0; Docs/40 admin.badges_list, admin.badge_approve, ModerationActionType
// revoke_badge). The panel lists the organization's badges (admin.badges_list organization_id, backend S13, BR-31;
// AC8 asked for a typed badge id, D-53) or, with no organization, the badges waiting for approval. Only the Verified
// Business badge waits for staff approval (54 §4: the trust worker awards it pending_approval once the business
// identity and a location are verified): Approve is admin.badge_approve (RSN, ADM/MOD). Revoke is admin.case_action
// revoke_badge on a case about the organization (PURP RSN), final for the organization (a second confirmation); the
// backend refuses a badge of another organization (S14).
import { useId, useState } from 'react';
import type { OrgSummary, ProviderBadge } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Button } from '@/components/ds/button';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';

const BADGE_TYPES = [
  'verified_business',
  'make_specialist',
  'system_expert',
  'highly_rated',
  'fast_responder',
  'high_response_rate',
  'repeat_customer_favorite',
  'fast_appointment_turnaround',
  'excellent_communication',
  'fleet_friendly',
  'ev_ready',
] as const;
const BADGE_STATUSES = ['pending_approval', 'active', 'revoked', 'expired'] as const;
const PAGE_SIZE = 50;

type ListedBadge = ProviderBadge & { organization: OrgSummary };

export function badgeName(type: string, t: Translate): string {
  return (BADGE_TYPES as readonly string[]).includes(type)
    ? t(`admin.moderation.badge.type.${type}` as MessageKey)
    : t('admin.kit.unknown', { value: type });
}

function badgeStatus(status: string, t: Translate): string {
  return (BADGE_STATUSES as readonly string[]).includes(status)
    ? t(`admin.moderation.badge.status.${status}` as MessageKey)
    : t('admin.kit.unknown', { value: status });
}

export interface BadgePanelProps {
  /** The organization whose badges are listed; without one, the badges waiting for approval. */
  orgId?: string | null;
  /** The case about the organization (revocation is a case action, read for the case's purpose). */
  caseId?: string;
  purpose?: AccessPurpose;
  /** Called after a badge decision (the case history changes). */
  onDone?: () => void;
}

export function BadgePanel({ orgId, caseId, purpose, onDone }: BadgePanelProps) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const canList = canCall('admin.badges_list', roles);
  const canApprove = canCall('admin.badge_approve', roles);
  const canRevoke = !!caseId && !!purpose && !!orgId && canCall('admin.case_action', roles);
  const list = useApiQuery(
    'admin.badges_list',
    { query: orgId ? { organization_id: orgId, limit: PAGE_SIZE } : { status: 'pending_approval', limit: PAGE_SIZE } },
    { enabled: canList },
  );
  const [dialog, setDialog] = useState<{ which: 'approve' | 'revoke'; badge: ListedBadge } | null>(null);
  const [last, setLast] = useState<{ which: 'approve' | 'revoke'; badge: ListedBadge } | null>(null);
  const done = () => {
    void list.refetch();
    onDone?.();
  };
  const approve = useAdminAction('admin.badge_approve', { target: last?.badge.id, onOutcome: done });
  const revoke = useAdminAction('admin.case_action', { target: caseId, onOutcome: done });
  if (!canList || (!canApprove && !canRevoke)) return null;
  const busy = approve.state.status === 'busy' || revoke.state.status === 'busy';
  const badges = list.data?.items ?? [];

  const start = (which: 'approve' | 'revoke', badge: ListedBadge) => {
    if (busy) return;
    approve.reset();
    revoke.reset();
    setDialog({ which, badge });
  };
  const submit = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    setLast(d);
    const id = d.badge.id;
    if (d.which === 'approve') void approve.run({ path: { badge_id: id }, body: { reason }, reason });
    else if (caseId && purpose)
      void revoke.run({
        path: { case_id: caseId },
        purpose,
        body: { action_type: 'revoke_badge', target: { type: 'badge', id }, params: { badge_id: id }, reason },
        reason,
      });
  };

  return (
    <section className="adm-panel" aria-labelledby={`${uid}-t`} data-testid="badge-panel">
      <h3 id={`${uid}-t`} className="adm-subtitle">
        {orgId ? t('admin.moderation.badge.title') : t('admin.moderation.badge.titlePending')}
      </h3>
      <p className="adm-muted">{t('admin.moderation.badge.text')}</p>
      {list.isPending ? (
        <p className="adm-muted">{t('admin.kit.table.loading')}</p>
      ) : list.isError ? (
        <p data-testid="badges-error">
          {t('admin.moderation.badge.listError')}{' '}
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void list.refetch()}>
            {t('admin.kit.table.retry')}
          </Button>
        </p>
      ) : badges.length ? (
        <table className="adm-simple-table" data-testid="badges">
          <caption className="sr-only">{t('admin.moderation.badge.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.moderation.badge.col.badge')}</th>
              {orgId ? null : <th scope="col">{t('admin.moderation.badge.col.organization')}</th>}
              <th scope="col">{t('admin.moderation.badge.col.status')}</th>
              <th scope="col">{t('admin.moderation.badge.col.awarded')}</th>
              <th scope="col">{t('admin.moderation.badge.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {badges.map((b) => {
              const approvable = canApprove && b.status === 'pending_approval';
              const revocable = canRevoke && (b.status === 'active' || b.status === 'pending_approval');
              return (
                <tr key={b.id} data-testid="badge-row" data-badge={b.id}>
                  <td>{badgeName(b.badge_type, t)}</td>
                  {orgId ? null : (
                    <td>
                      <Bidi>{b.organization.name}</Bidi>
                    </td>
                  )}
                  <td>{badgeStatus(b.status, t)}</td>
                  <td>{f.date(b.awarded_at, 'dateShort')}</td>
                  <td>
                    <div className="adm-actions">
                      {approvable ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          loading={approve.state.status === 'busy' && last?.badge.id === b.id}
                          onClick={() => start('approve', b)}
                        >
                          {t('admin.moderation.badge.approve')}
                        </Button>
                      ) : null}
                      {revocable ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          loading={revoke.state.status === 'busy' && last?.badge.id === b.id}
                          onClick={() => start('revoke', b)}
                        >
                          {t('admin.moderation.badge.revoke')}
                        </Button>
                      ) : null}
                      {!approvable && !revocable ? '—' : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p data-testid="badges-none">{orgId ? t('admin.moderation.badge.none') : t('admin.moderation.badge.nonePending')}</p>
      )}
      {list.data?.next_cursor ? <p className="adm-muted">{t('admin.moderation.badge.more', { n: f.number(PAGE_SIZE) })}</p> : null}
      <ActionNotice
        state={approve.state}
        applied={last ? t('admin.moderation.badge.approved', { badge: badgeName(last.badge.badge_type, t) }) : undefined}
      />
      <ActionNotice state={revoke.state} applied={t('admin.moderation.badge.revoked')} />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog?.which === 'revoke' ? 'badge_revoke' : 'approval'}
        title={dialog?.which === 'revoke' ? t('admin.moderation.badge.revokeTitle') : t('admin.moderation.badge.approveTitle')}
        confirmLabel={dialog?.which === 'revoke' ? t('admin.moderation.badge.revoke') : t('admin.moderation.badge.approve')}
        confirmVariant={dialog?.which === 'revoke' ? 'danger' : 'primary'}
        irreversible={dialog?.which === 'revoke'}
        summary={
          dialog ? (
            <>
              <p>
                {badgeName(dialog.badge.badge_type, t)} — <Bidi>{dialog.badge.organization.name}</Bidi>
              </p>
              <p className="adm-muted">
                {dialog.which === 'revoke' ? t('admin.moderation.badge.revokeEffect') : t('admin.moderation.badge.approveEffect')}
              </p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="badge"
      />
    </section>
  );
}
