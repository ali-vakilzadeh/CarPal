'use client';
// Badges of an organization (AC8.T5, Docs/40 admin.badge_approve, ModerationActionType revoke_badge). Only the
// Verified Business badge waits for staff approval (54 §4: the trust worker awards it pending_approval once the
// business identity and a location are verified); every badge can be revoked from a case about the organization.
// Contract 1.3.0 has no read that lists an organization's badges or the badges waiting for approval (BR-31), so the
// staff member enters the badge id (from a badge challenge in Disputes, the organization's verification, or the
// audit log); the panel says so. Approval: admin.badge_approve (RSN, ADM/MOD). Revocation: admin.case_action
// revoke_badge on the case (PURP RSN), final for the organization (a second confirmation).
import { useId, useState } from 'react';
import type { ProviderBadge } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import type { AccessPurpose } from '@/lib/api/client';
import { useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { isId } from './case-logic';

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

export interface BadgePanelProps {
  /** The case about the organization (revocation is a case action, read for the case's purpose). */
  caseId?: string;
  purpose?: AccessPurpose;
  /** Called after a badge decision (the case history changes). */
  onDone?: () => void;
}

export function BadgePanel({ caseId, purpose, onDone }: BadgePanelProps) {
  const t = useT();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const canApprove = canCall('admin.badge_approve', roles);
  const canRevoke = !!caseId && !!purpose && canCall('admin.case_action', roles);
  const [badgeId, setBadgeId] = useState('');
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState<'approve' | 'revoke' | null>(null);
  const [approved, setApproved] = useState<ProviderBadge | null>(null);
  const approve = useAdminAction('admin.badge_approve', {
    target: badgeId.trim() || undefined,
    onOutcome: (o) => {
      if (o.kind === 'applied') setApproved(o.data);
      onDone?.();
    },
  });
  const revoke = useAdminAction('admin.case_action', { target: caseId, onOutcome: () => onDone?.() });
  if (!canApprove && !canRevoke) return null;
  const id = badgeId.trim();
  const valid = isId(id);
  const busy = approve.state.status === 'busy' || revoke.state.status === 'busy';

  const start = (which: 'approve' | 'revoke') => {
    setTried(true);
    approve.reset();
    revoke.reset();
    setApproved(null);
    if (!valid || busy) return;
    setDialog(which);
  };
  const submit = (reason: string) => {
    const which = dialog;
    setDialog(null);
    if (which === 'approve') void approve.run({ path: { badge_id: id }, body: { reason }, reason });
    else if (which === 'revoke' && caseId && purpose)
      void revoke.run({
        path: { case_id: caseId },
        purpose,
        body: { action_type: 'revoke_badge', target: { type: 'badge', id }, params: { badge_id: id }, reason },
        reason,
      });
  };
  const badgeName = (b: ProviderBadge) =>
    (BADGE_TYPES as readonly string[]).includes(b.badge_type)
      ? t(`admin.moderation.badge.type.${b.badge_type}` as MessageKey)
      : t('admin.kit.unknown', { value: b.badge_type });

  return (
    <section className="adm-panel" aria-labelledby={`${uid}-t`} data-testid="badge-panel">
      <h3 id={`${uid}-t`} className="adm-subtitle">
        {t('admin.moderation.badge.title')}
      </h3>
      <p className="adm-muted">{t('admin.moderation.badge.text')}</p>
      <TextField
        label={t('admin.moderation.badge.id')}
        hint={t('admin.moderation.badge.idHint')}
        error={tried && !valid ? t('admin.moderation.badge.idInvalid') : undefined}
        value={badgeId}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setBadgeId(e.target.value)}
      />
      <div className="adm-actions">
        {canApprove ? (
          <Button size="sm" variant="primary" disabled={busy} loading={approve.state.status === 'busy'} onClick={() => start('approve')}>
            {t('admin.moderation.badge.approve')}
          </Button>
        ) : null}
        {canRevoke ? (
          <Button size="sm" variant="danger" disabled={busy} loading={revoke.state.status === 'busy'} onClick={() => start('revoke')}>
            {t('admin.moderation.badge.revoke')}
          </Button>
        ) : null}
      </div>
      <ActionNotice
        state={approve.state}
        applied={approved ? t('admin.moderation.badge.approved', { badge: badgeName(approved) }) : undefined}
      />
      <ActionNotice state={revoke.state} applied={t('admin.moderation.badge.revoked')} />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'revoke' ? 'badge_revoke' : 'approval'}
        title={dialog === 'revoke' ? t('admin.moderation.badge.revokeTitle') : t('admin.moderation.badge.approveTitle')}
        confirmLabel={dialog === 'revoke' ? t('admin.moderation.badge.revoke') : t('admin.moderation.badge.approve')}
        confirmVariant={dialog === 'revoke' ? 'danger' : 'primary'}
        irreversible={dialog === 'revoke'}
        summary={
          <>
            <p>
              {t('admin.moderation.badge.id')}: <Bidi ltr>{id}</Bidi>
            </p>
            <p className="adm-muted">
              {dialog === 'revoke' ? t('admin.moderation.badge.revokeEffect') : t('admin.moderation.badge.approveEffect')}
            </p>
          </>
        }
        onSubmit={submit}
        name="badge"
      />
    </section>
  );
}
