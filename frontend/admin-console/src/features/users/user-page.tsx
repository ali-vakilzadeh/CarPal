'use client';
// User detail (AC10.T2/T3, Docs/23 A-USR-02, Docs/40 §23.2). The user is read for the work item in ?purpose= (a case,
// dispute, privacy request or verification about them; SEC-ADM-5, backend S14: a record outside the item answers
// PURPOSE_RECORD_MISMATCH). Header: display name (the full name masked), user id, status, and by role Suspend (for a
// chosen duration or until reactivated; the scheduler lifts a timed suspension, backend S14), Reactivate, Force
// sign-out (ADM, SUP), Reset onboarding (ADM, SUP) and the Audit trail (ADM); none of these is purpose-bound, every
// one has a reason. Overview: masked contacts with Reveal (a purpose-bound re-read, logged), verification marks,
// counts, subscription; Roles & organizations; Staff roles for platform admins (grant by four-eyes, revoke at once).
// A deleted account takes no actions. The other Docs/23 tabs come with AC14.T5 (backend S23 reads, BR-16).
import Link from 'next/link';
import { useId, useState } from 'react';
import type { StaffUserView } from '@carpal/api-contracts';
import {
  ActionNotice,
  AuditDrawer,
  MaskedField,
  maskName,
  PurposeGate,
  purposeKind,
  ReasonDialog,
  useAdminAction,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { isSuspendDuration, SUSPEND_DURATIONS, suspendUntil, type SuspendDuration } from '@/lib/config/suspension';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import {
  businessMemberships,
  grantableRoles,
  isGone,
  onboardingFlows,
  platformRoles,
  statusChanges,
  type OnboardingFlow,
  type PlatformRole,
  type StatusChange,
} from './user-logic';
import { membershipRole, membershipStatus, onboardingFlow, platformRole, userStatus } from './user-parts';

export function UserPage({ userId }: { userId: string }) {
  const t = useT();
  return (
    <div className="adm-page" data-testid="user-page" data-user={userId}>
      <p className="adm-muted">
        <Link href="/users">{t('admin.users.back')}</Link>
      </p>
      <PurposeGate title={t('admin.users.detailTitle')}>{(purpose) => <UserDetail userId={userId} purpose={purpose} />}</PurposeGate>
    </div>
  );
}

function UserDetail({ userId, purpose }: { userId: string; purpose: AccessPurpose }) {
  const t = useT();
  const detail = useApiQuery('admin.user_get', { path: { user_id: userId }, purpose }, { retry: false });
  const user = detail.data;
  const reload = async () => (await detail.refetch()).data ?? null;
  if (detail.isPending) return <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
  if (!user) {
    const e = detail.error;
    return (
      <section data-testid="user-unavailable">
        <h1 className="adm-page-title">{t('admin.users.unavailable.title')}</h1>
        <p>
          {e?.purposeMismatch
            ? t('admin.users.unavailable.mismatch')
            : e?.status === 404
              ? t('admin.users.unavailable.notFound')
              : t('admin.users.unavailable.other')}
        </p>
      </section>
    );
  }
  const onChanged = () => void detail.refetch();
  return (
    <>
      <UserHeader user={user} purpose={purpose} onChanged={onChanged} />
      <Overview user={user} reload={reload} />
      <Memberships user={user} />
      <StaffRoles user={user} onChanged={onChanged} />
      <section className="adm-missing" aria-labelledby="user-missing-t">
        <h2 id="user-missing-t" className="adm-subtitle">
          {t('admin.users.missing.title')}
        </h2>
        <p className="adm-muted">{t('admin.users.missing.text')}</p>
      </section>
    </>
  );
}

function UserHeader({ user, purpose, onChanged }: { user: StaffUserView; purpose: AccessPurpose; onChanged: () => void }) {
  const t = useT();
  const f = useFormat();
  const name = user.display_name ?? maskName(user.full_name);
  const gone = isGone(user.status);
  return (
    <header className="adm-org-head">
      <h1 className="adm-page-title" data-testid="user-name">
        <Bidi>{name}</Bidi>
      </h1>
      <p className="adm-org-meta">
        <Badge tone={user.status === 'active' ? 'success' : user.status === 'suspended' || gone ? 'danger' : 'neutral'}>
          <span data-testid="user-status">{userStatus(user.status, t)}</span>
        </Badge>
        <span>
          {t('admin.users.id')} <Bidi ltr>{user.id}</Bidi>
        </span>
        {user.status === 'suspended' ? (
          <span data-testid="user-suspended-until">
            {user.suspended_until
              ? t('admin.users.suspendedUntil', { when: f.date(user.suspended_until, 'dateTime') })
              : t('admin.users.suspendedOpen')}
          </span>
        ) : null}
      </p>
      <p className="adm-muted" data-testid="user-purpose">
        {t('admin.users.readFor', { kind: t(`admin.orgs.purpose.kind.${purposeKind(purpose)}`) })}
      </p>
      {gone ? <Banner tone="info" text={t('admin.users.deleted')} /> : null}
      {!gone ? (
        <div className="adm-actions adm-org-actions">
          <StatusActions user={user} onChanged={onChanged} />
          <ForceSignOut user={user} />
          <OnboardingReset user={user} />
          <AuditDrawer entityType="user" entityId={user.id} label={name} />
        </div>
      ) : (
        <div className="adm-actions adm-org-actions">
          <AuditDrawer entityType="user" entityId={user.id} label={name} />
        </div>
      )}
    </header>
  );
}

function StatusActions({ user, onChanged }: { user: StaffUserView; onChanged: () => void }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const allowed = canCall('admin.user_status', session.data?.staff?.roles ?? []);
  const [dialog, setDialog] = useState<StatusChange | null>(null);
  const [last, setLast] = useState<StatusChange | null>(null);
  const [duration, setDuration] = useState<SuspendDuration>('until_reactivated');
  const action = useAdminAction('admin.user_status', {
    target: user.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') onChanged();
    },
  });
  if (!allowed) return null;
  const submit = (reason: string) => {
    const change = dialog;
    setDialog(null);
    if (!change) return;
    setLast(change);
    const until = change === 'suspend' ? suspendUntil(duration) : null;
    const body = {
      status: change === 'suspend' ? ('suspended' as const) : ('active' as const),
      reason,
      ...(until ? { suspend_until: until } : {}),
    };
    void action.run({ path: { user_id: user.id }, body, reason });
  };
  return (
    <>
      {statusChanges(user.status).map((c) => (
        <Button
          key={c}
          size="sm"
          variant={c === 'suspend' ? 'danger' : 'secondary'}
          icon={c === 'suspend' ? 'lock' : 'refresh'}
          loading={action.state.status === 'busy' && last === c}
          disabled={action.state.status === 'busy'}
          onClick={() => {
            action.reset();
            setDuration('until_reactivated');
            setDialog(c);
          }}
        >
          {t(`admin.users.status.do.${c}`)}
        </Button>
      ))}
      <div className="adm-header-notice">
        <ActionNotice state={action.state} applied={last ? t(`admin.users.status.done.${last}`) : undefined} />
      </div>
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'suspend' ? 'suspension' : 'restore'}
        title={dialog ? t(`admin.users.status.dialog.${dialog}`) : ''}
        confirmLabel={dialog ? t(`admin.users.status.do.${dialog}`) : ''}
        confirmVariant={dialog === 'suspend' ? 'danger' : 'primary'}
        irreversible={dialog === 'suspend'}
        summary={
          dialog === 'suspend' ? (
            <>
              <p className="adm-muted">{t('admin.users.status.effect.suspend')}</p>
              <div className="cp-field">
                <label className="cp-field-label" htmlFor={`${uid}-for`}>
                  {t('admin.suspension.label')}
                </label>
                <div className="cp-field-box">
                  <select
                    id={`${uid}-for`}
                    className="cp-field-input adm-select"
                    value={duration}
                    onChange={(e) => isSuspendDuration(e.target.value) && setDuration(e.target.value)}
                  >
                    {SUSPEND_DURATIONS.map((d) => (
                      <option key={d} value={d}>
                        {t(`admin.suspension.duration.${d}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p data-testid="suspend-summary">
                {duration === 'until_reactivated'
                  ? t('admin.suspension.summaryOpen')
                  : t('admin.suspension.summaryUntil', { when: f.date(suspendUntil(duration)!, 'dateTime') })}
              </p>
            </>
          ) : dialog === 'reactivate' ? (
            <p className="adm-muted">{t('admin.users.status.effect.reactivate')}</p>
          ) : null
        }
        onSubmit={submit}
        name="user-status"
      />
    </>
  );
}

function ForceSignOut({ user }: { user: StaffUserView }) {
  const t = useT();
  const session = useSession();
  const allowed = canCall('admin.user_sessions_revoke', session.data?.staff?.roles ?? []);
  const [open, setOpen] = useState(false);
  const action = useAdminAction('admin.user_sessions_revoke', { target: user.id });
  if (!allowed) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon="logout"
        loading={action.state.status === 'busy'}
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        {t('admin.users.signOut.do')}
      </Button>
      <div className="adm-header-notice">
        <ActionNotice state={action.state} applied={t('admin.users.signOut.done')} />
      </div>
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        kind="force_signout"
        title={t('admin.users.signOut.dialog')}
        confirmLabel={t('admin.users.signOut.do')}
        summary={<p className="adm-muted">{t('admin.users.signOut.effect')}</p>}
        onSubmit={(reason) => {
          setOpen(false);
          void action.run({ path: { user_id: user.id }, body: { reason }, reason });
        }}
        name="user-signout"
      />
    </>
  );
}

function OnboardingReset({ user }: { user: StaffUserView }) {
  const t = useT();
  const session = useSession();
  const allowed = canCall('admin.onboarding_reset', session.data?.staff?.roles ?? []);
  const flows = onboardingFlows(user.memberships);
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<OnboardingFlow>(flows[0] ?? 'individual');
  const [last, setLast] = useState<OnboardingFlow | null>(null);
  const action = useAdminAction('admin.onboarding_reset', { target: user.id });
  if (!allowed) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon="refresh"
        loading={action.state.status === 'busy'}
        onClick={() => {
          action.reset();
          setFlow(flows[0] ?? 'individual');
          setOpen(true);
        }}
      >
        {t('admin.users.onboarding.do')}
      </Button>
      <div className="adm-header-notice">
        <ActionNotice
          state={action.state}
          applied={last ? t('admin.users.onboarding.done', { flow: onboardingFlow(last, t) }) : undefined}
        />
      </div>
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        kind="onboarding_reset"
        title={t('admin.users.onboarding.dialog')}
        confirmLabel={t('admin.users.onboarding.do')}
        summary={
          <>
            {flows.length > 1 ? (
              <fieldset className="adm-radios">
                <legend>{t('admin.users.onboarding.flow')}</legend>
                {flows.map((x) => (
                  <label key={x}>
                    <input type="radio" name="onboarding-flow" value={x} checked={flow === x} onChange={() => setFlow(x)} />{' '}
                    {onboardingFlow(x, t)}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p>{t('admin.users.onboarding.only', { flow: onboardingFlow(flow, t) })}</p>
            )}
            <p className="adm-muted">{t('admin.users.onboarding.effect')}</p>
          </>
        }
        onSubmit={(reason) => {
          setOpen(false);
          setLast(flow);
          void action.run({ path: { user_id: user.id, flow_type: flow }, body: { reason }, reason });
        }}
        name="user-onboarding"
      />
    </>
  );
}

function Overview({ user, reload }: { user: StaffUserView; reload: () => Promise<StaffUserView | null> }) {
  const t = useT();
  const f = useFormat();
  const mark = (at: string | null) => (at ? t('admin.users.verifiedOn', { when: f.date(at, 'dateShort') }) : t('admin.users.notVerified'));
  return (
    <section aria-labelledby="user-overview-t" data-testid="user-overview">
      <h2 id="user-overview-t" className="adm-section-title">
        {t('admin.users.overview')}
      </h2>
      <dl className="adm-facts">
        <MaskedField
          label={t('admin.users.fullName')}
          kind="name"
          value={user.full_name}
          onReveal={async () => (await reload())?.full_name ?? null}
        />
        <MaskedField
          label={t('admin.users.email')}
          kind="email"
          value={user.email}
          onReveal={async () => (await reload())?.email ?? null}
        />
        <MaskedField
          label={t('admin.users.phone')}
          kind="phone"
          value={user.phone}
          onReveal={async () => (await reload())?.phone ?? null}
        />
        <div>
          <dt>{t('admin.users.emailMark')}</dt>
          <dd>{mark(user.email_verified_at)}</dd>
        </div>
        <div>
          <dt>{t('admin.users.phoneMark')}</dt>
          <dd>{mark(user.phone_verified_at)}</dd>
        </div>
        <div>
          <dt>{t('admin.users.mfa')}</dt>
          <dd>{user.mfa_enabled ? t('admin.users.yes') : t('admin.users.no')}</dd>
        </div>
        <div>
          <dt>{t('admin.users.trusted')}</dt>
          <dd>{user.trusted_user ? t('admin.users.yes') : t('admin.users.no')}</dd>
        </div>
        <div>
          <dt>{t('admin.users.created')}</dt>
          <dd>{f.date(user.created_at, 'dateShort')}</dd>
        </div>
        <div>
          <dt>{t('admin.users.lastActive')}</dt>
          <dd>{user.last_active_at ? f.date(user.last_active_at, 'dateTime') : '—'}</dd>
        </div>
        <div>
          <dt>{t('admin.users.count.reviews')}</dt>
          <dd>{f.number(user.counts.reviews)}</dd>
        </div>
        <div>
          <dt>{t('admin.users.count.reportsAgainst')}</dt>
          <dd>{f.number(user.counts.reports_against)}</dd>
        </div>
        <div>
          <dt>{t('admin.users.count.openDisputes')}</dt>
          <dd>{f.number(user.counts.open_disputes)}</dd>
        </div>
        <div>
          <dt>{t('admin.users.plan')}</dt>
          <dd>
            {planLabel(user.subscription.plan_key, t)}
            {user.subscription.trial_ends_at
              ? ` · ${t('admin.users.trialEnds', { when: f.date(user.subscription.trial_ends_at, 'dateShort') })}`
              : ''}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Memberships({ user }: { user: StaffUserView }) {
  const t = useT();
  const f = useFormat();
  const list = businessMemberships(user.memberships);
  return (
    <section aria-labelledby="user-members-t" data-testid="user-memberships">
      <h2 id="user-members-t" className="adm-section-title">
        {t('admin.users.memberships')}
      </h2>
      {list.length ? (
        <table className="adm-simple-table">
          <caption className="sr-only">{t('admin.users.memberships')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.users.col.organization')}</th>
              <th scope="col">{t('admin.users.col.role')}</th>
              <th scope="col">{t('admin.users.col.status')}</th>
              <th scope="col">{t('admin.users.col.joined')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/orgs/${m.organization!.id}`}>
                    <Bidi>{m.organization!.name}</Bidi>
                  </Link>
                </td>
                <td>{membershipRole(m.role, t)}</td>
                <td>{membershipStatus(m.status, t)}</td>
                <td>{m.joined_at ? f.date(m.joined_at, 'dateShort') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="adm-muted">{t('admin.users.noMemberships')}</p>
      )}
    </section>
  );
}

/** Staff roles (AC10.T3, ADM): grant by four-eyes (admin.platform_role_grant), revoke at once (admin.platform_role_revoke). */
function StaffRoles({ user, onChanged }: { user: StaffUserView; onChanged: () => void }) {
  const t = useT();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const canGrant = canCall('admin.platform_role_grant', roles);
  const canRevoke = canCall('admin.platform_role_revoke', roles);
  const held = platformRoles(user.memberships);
  const grantable = grantableRoles(user.memberships);
  const [role, setRole] = useState<PlatformRole | ''>('');
  const [dialog, setDialog] = useState<{ kind: 'grant' | 'revoke'; role: PlatformRole } | null>(null);
  const [last, setLast] = useState<{ kind: 'grant' | 'revoke'; role: PlatformRole } | null>(null);
  const grant = useAdminAction('admin.platform_role_grant', { target: user.id });
  const revoke = useAdminAction('admin.platform_role_revoke', {
    target: user.id,
    onOutcome: (o) => {
      if (o.kind === 'applied') onChanged();
    },
  });
  if (!canGrant && !canRevoke) return null;
  const busy = grant.state.status === 'busy' || revoke.state.status === 'busy';
  const gone = isGone(user.status);
  const submit = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    setLast(d);
    if (d.kind === 'grant') void grant.run({ path: { user_id: user.id }, body: { role: d.role, reason }, reason });
    else void revoke.run({ path: { user_id: user.id, role: d.role }, reason });
  };
  return (
    <section aria-labelledby={`${uid}-t`} data-testid="staff-roles" className="adm-panel">
      <h2 id={`${uid}-t`} className="adm-section-title">
        {t('admin.users.staff.title')}
      </h2>
      <p className="adm-muted">{t('admin.users.staff.text')}</p>
      {held.length ? (
        <ul className="adm-stack">
          {held.map((r) => (
            <li key={r.role} data-testid="staff-role" data-role={r.role}>
              {platformRole(r.role, t)}
              {r.status !== 'active' ? ` (${membershipStatus(r.status, t)})` : ''}{' '}
              {canRevoke && !gone ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  loading={revoke.state.status === 'busy' && last?.role === r.role}
                  onClick={() => {
                    revoke.reset();
                    grant.reset();
                    setDialog({ kind: 'revoke', role: r.role });
                  }}
                >
                  {t('admin.users.staff.revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="staff-roles-none">{t('admin.users.staff.none')}</p>
      )}
      {canGrant && !gone && grantable.length ? (
        <div className="adm-actions">
          <div className="cp-field">
            <label className="cp-field-label" htmlFor={`${uid}-role`}>
              {t('admin.users.staff.role')}
            </label>
            <div className="cp-field-box">
              <select
                id={`${uid}-role`}
                className="cp-field-input adm-select"
                value={role}
                onChange={(e) => setRole(e.target.value as PlatformRole | '')}
              >
                <option value="">{t('admin.users.staff.choose')}</option>
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {platformRole(r, t)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !role}
            loading={grant.state.status === 'busy'}
            onClick={() => {
              if (!role) return;
              grant.reset();
              revoke.reset();
              setDialog({ kind: 'grant', role });
            }}
          >
            {t('admin.users.staff.grant')}
          </Button>
        </div>
      ) : null}
      <ActionNotice state={grant.state} />
      <ActionNotice
        state={revoke.state}
        applied={last?.kind === 'revoke' ? t('admin.users.staff.revoked', { role: platformRole(last.role, t) }) : undefined}
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog?.kind === 'revoke' ? 'role_revoke' : 'role_grant'}
        title={dialog ? t(`admin.users.staff.dialog.${dialog.kind}`, { role: platformRole(dialog.role, t) }) : ''}
        confirmLabel={dialog?.kind === 'revoke' ? t('admin.users.staff.revoke') : t('admin.users.staff.grant')}
        confirmVariant={dialog?.kind === 'revoke' ? 'danger' : 'primary'}
        summary={dialog ? <p className="adm-muted">{t(`admin.users.staff.effect.${dialog.kind}`)}</p> : null}
        onSubmit={submit}
        name="staff-role"
      />
    </section>
  );
}
