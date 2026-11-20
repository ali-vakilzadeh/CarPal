'use client';
// Recovery requests (AC10b.T4, SEC-ADM-2, backend S16b; ADM only, next to Pending approvals): staff members who lost
// their security key and asked for an account recovery at the sign-in page. Two different administrators approve a
// request after checking the person outside CarPal (verification method, and a note when the method is "other"); one
// rejection ends it. Approval needs a security-key sign-in within 5 minutes (STEP_UP_REQUIRED max_age=300): the kit's
// step-up repeats the approval once after the key. The requester, an administrator who already approved and one
// under the 72-hour post-recovery restriction are refused by the server (SELF_APPROVAL_FORBIDDEN,
// INVALID_TRANSITION, STAFF_RECOVERY_RESTRICTED) and the page explains it. The list never shows codes, handles or
// contact data beyond the masked email (Docs/40 StaffRecoveryRequest).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { StaffRecoveryRequest } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  ConfirmDialog,
  DataTable,
  ReasonDialog,
  ReasonPanel,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { roleNames, useShortcut } from '@/features/shell';
import { useApiQuery } from '@/lib/api/query';
import { checkReason, composeReason, EMPTY_REASON, parseReason, type ReasonDraft } from '@/lib/config/reasons';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import {
  APPROVALS_NEEDED,
  approveBody,
  checkApprove,
  isRecoveryStatus,
  METHOD_NOTE_MAX,
  RECOVERY_STATUSES,
  recoveryActions,
  roleCodes,
  VERIFICATION_METHODS,
  type ApproveDraft,
} from './recovery-logic';
import { isRestricted, useStaffMe } from './staff-me';

const PAGE_SIZE = 50;

export function recoveryStatusLabel(status: string, t: Translate): string {
  return isRecoveryStatus(status) ? t(`admin.recoveries.status.${status}`) : t('admin.kit.unknown', { value: status });
}

function methodLabel(method: string | null, t: Translate): string {
  return method && (VERIFICATION_METHODS as readonly string[]).includes(method)
    ? t(`admin.recoveries.method.${method}` as MessageKey)
    : t('admin.kit.unknown', { value: method ?? '' });
}

function ReasonText({ reason }: { reason: string }) {
  const t = useT();
  const r = parseReason(reason);
  return (
    <>
      {r.code ? <strong>{t(`admin.reasons.codes.${r.code}` as MessageKey)}</strong> : null}
      {r.note ? (
        <>
          {r.code ? ' — ' : null}
          <Bidi>{r.note}</Bidi>
        </>
      ) : null}
    </>
  );
}

const EMPTY_APPROVE: ApproveDraft = { method: '', note: '' };

/** Approve: the reason, how the person was checked, and a note (required for "other"). */
function ApproveDialog({
  open,
  onClose,
  request,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  request: StaffRecoveryRequest | null;
  onSubmit: (reason: string, draft: ApproveDraft) => void;
}) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState<ReasonDraft>(EMPTY_REASON);
  const [draft, setDraft] = useState<ApproveDraft>(EMPTY_APPROVE);
  const [tried, setTried] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setReason(EMPTY_REASON);
      setDraft(EMPTY_APPROVE);
      setTried(false);
    }
  }
  const reasonProblem = checkReason('recovery_approve', reason);
  const problem = checkApprove(draft);
  const ready = !reasonProblem.code && !reasonProblem.note && !problem.method && !problem.note;
  const methodError = tried && problem.method ? t('admin.recoveries.approve.methodRequired') : null;
  const noteError =
    tried && problem.note === 'required'
      ? t('admin.recoveries.approve.noteRequired')
      : problem.note === 'too_long'
        ? t('admin.kit.reason.noteTooLong', { n: METHOD_NOTE_MAX })
        : undefined;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={t('admin.recoveries.approve.title')}
      confirmLabel={t('admin.recoveries.approve.action')}
      ready={ready}
      onAttempt={() => setTried(true)}
      onConfirm={() => onSubmit(composeReason(reason), draft)}
      name="approve-recovery"
    >
      {request ? (
        <div className="adm-confirm-summary">
          <p className="adm-panel-title">
            <Bidi>{request.display_name}</Bidi>
          </p>
          <p className="adm-muted">{t('admin.recoveries.approve.effect')}</p>
        </div>
      ) : null}
      <fieldset className="adm-radios" aria-describedby={methodError ? `${id}-m-e` : undefined}>
        <legend>{t('admin.recoveries.approve.method')}</legend>
        {VERIFICATION_METHODS.map((m) => (
          <label key={m} className="adm-radio">
            <input
              type="radio"
              name={`${id}-method`}
              value={m}
              checked={draft.method === m}
              onChange={() => setDraft({ ...draft, method: m })}
            />
            <span>{t(`admin.recoveries.method.${m}`)}</span>
          </label>
        ))}
        {methodError ? (
          <p id={`${id}-m-e`} className="adm-error" role="alert">
            {methodError}
          </p>
        ) : null}
      </fieldset>
      <TextField
        multiline
        rows={2}
        label={draft.method === 'other' ? t('admin.recoveries.approve.noteRequiredLabel') : t('admin.recoveries.approve.note')}
        hint={t('admin.recoveries.approve.noteHint')}
        value={draft.note}
        maxLength={METHOD_NOTE_MAX}
        required={draft.method === 'other'}
        error={noteError}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
      />
      <ReasonPanel kind="recovery_approve" value={reason} onChange={setReason} showErrors={tried} />
    </ConfirmDialog>
  );
}

export function RecoveriesPage() {
  const t = useT();
  const f = useFormat();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const me = useStaffMe();
  const restricted = me.data ? isRestricted(me.data.restricted_until, me.dataUpdatedAt) : false;

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.recoveries.filter.status'),
        options: RECOVERY_STATUSES.map((s) => ({ value: s, label: recoveryStatusLabel(s, t) })),
        defaultValue: 'awaiting_approvals',
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.staff_recoveries_list',
    {
      query: {
        status: filters.values.status as StaffRecoveryRequest['status'],
        limit: PAGE_SIZE,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const selectedId = params.get('request');
  // The request itself (also when it is not on this page of the list, e.g. from a notice link).
  const detail = useApiQuery('admin.staff_recovery_get', { path: { request_id: selectedId ?? '' } }, { enabled: !!selectedId });
  const selected = detail.data ?? null;
  const select = (r: StaffRecoveryRequest | null) => {
    const p = new URLSearchParams(params);
    if (r) p.set('request', r.id);
    else p.delete('request');
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin.staff_recoveries_list'] });
    void queryClient.invalidateQueries({ queryKey: ['admin.staff_recovery_get'] });
  };
  const approve = useAdminAction('admin.staff_recovery_approve', { onOutcome: refresh, target: selectedId ?? undefined });
  const reject = useAdminAction('admin.staff_recovery_reject', { onOutcome: refresh, target: selectedId ?? undefined });
  const action = decided === 'reject' ? reject : approve;
  const busy = approve.state.status === 'busy' || reject.state.status === 'busy';
  const can = selected ? recoveryActions(selected) : { approve: false, reject: false };

  const open = (kind: 'approve' | 'reject') => {
    if (!selected || busy || !can[kind]) return;
    approve.reset();
    reject.reset();
    setDialog(kind);
  };
  useShortcut('approve', () => open('approve'), can.approve);
  useShortcut('reject', () => open('reject'), can.reject);

  const afterFailure = (r: { status: string; problem?: { code: string } }) => {
    if (r.status === 'failed' && r.problem?.code === 'INVALID_TRANSITION') refresh();
  };
  const submitApprove = (reason: string, draft: ApproveDraft) => {
    if (!selected) return;
    setDialog(null);
    setDecided('approve');
    void approve.run({ path: { request_id: selected.id }, body: approveBody(draft, reason), reason }).then(afterFailure);
  };
  const submitReject = (reason: string) => {
    if (!selected) return;
    setDialog(null);
    setDecided('reject');
    void reject.run({ path: { request_id: selected.id }, body: { reason }, reason }).then(afterFailure);
  };

  const now = list.dataUpdatedAt;
  const columns: Column<StaffRecoveryRequest>[] = [
    { id: 'who', header: t('admin.recoveries.col.who'), pinned: true, cell: (r) => <Bidi>{r.display_name}</Bidi> },
    { id: 'roles', header: t('admin.recoveries.col.roles'), cell: (r) => roleNames(roleCodes(r.platform_roles), t) },
    {
      id: 'requested',
      header: t('admin.recoveries.col.requested'),
      cell: (r, ctx) => <time dateTime={r.requested_at}>{ctx.digits(f.date(r.requested_at, 'dateTime'))}</time>,
    },
    {
      id: 'approvals',
      header: t('admin.recoveries.col.approvals'),
      cell: (r) => t('admin.recoveries.approvalsOf', { n: f.number(r.approvals), of: f.number(APPROVALS_NEEDED) }),
    },
    {
      id: 'expires',
      header: t('admin.recoveries.col.expires'),
      cell: (r) =>
        r.status === 'awaiting_approvals' || r.status === 'approved' ? (
          <SlaBadge
            state={slaState(Date.parse(r.requested_at), Date.parse(r.expires_at), now)}
            text={t('admin.approvals.expiresIn', { when: f.relative(r.expires_at, now) })}
          />
        ) : (
          <time dateTime={r.expires_at}>{f.date(r.expires_at, 'dateTime')}</time>
        ),
    },
    { id: 'status', header: t('admin.recoveries.col.status'), cell: (r) => recoveryStatusLabel(r.status, t), defaultHidden: true },
  ];

  return (
    <div className="adm-page" data-testid="recoveries-page">
      <h1 className="adm-page-title">{t('admin.recoveries.title')}</h1>
      <p className="adm-measure">{t('admin.recoveries.intro')}</p>
      <CaseLayout
        labels={{
          list: t('admin.recoveries.listLabel'),
          item: t('admin.recoveries.itemLabel'),
          decision: t('admin.recoveries.decisionLabel'),
        }}
        list={
          <DataTable
            id="recoveries"
            caption={t('admin.recoveries.listLabel')}
            columns={columns}
            rows={list.data?.items}
            rowKey={(r) => r.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.recoveries.empty')}
            selectedKey={selectedId}
            onSelect={select}
            filters={filterDefs}
            filterValues={filters.values}
            onFilterChange={filters.setFilter}
            onApplyView={filters.applyView}
            paging={{
              page: paging.page,
              hasPrev: paging.page > 1,
              hasNext: !!list.data?.next_cursor,
              onPrev: paging.prev,
              onNext: () => list.data?.next_cursor && paging.next(list.data.next_cursor),
            }}
          />
        }
        item={
          selected ? (
            <article data-testid="recovery-detail" data-request={selected.id} data-status={selected.status}>
              <h2 className="adm-panel-title">
                <Bidi>{selected.display_name}</Bidi>
              </h2>
              <dl className="adm-facts">
                <div>
                  <dt>{t('admin.recoveries.email')}</dt>
                  <dd>
                    <Bidi ltr>{selected.email_masked}</Bidi>
                  </dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.col.roles')}</dt>
                  <dd>{roleNames(roleCodes(selected.platform_roles), t)}</dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.col.status')}</dt>
                  <dd data-testid="recovery-status">{recoveryStatusLabel(selected.status, t)}</dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.col.approvals')}</dt>
                  <dd data-testid="recovery-approvals">
                    {t('admin.recoveries.approvalsOf', { n: f.number(selected.approvals), of: f.number(APPROVALS_NEEDED) })}
                  </dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.col.requested')}</dt>
                  <dd>{f.date(selected.requested_at, 'dateTime')}</dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.col.expires')}</dt>
                  <dd>{f.date(selected.expires_at, 'dateTime')}</dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.country')}</dt>
                  <dd>{selected.ip_country ?? t('admin.recoveries.countryUnknown')}</dd>
                </div>
                <div>
                  <dt>{t('admin.recoveries.password')}</dt>
                  <dd>{selected.password_forgotten ? t('admin.recoveries.passwordForgotten') : t('admin.recoveries.passwordKnown')}</dd>
                </div>
                {selected.completed_at ? (
                  <div>
                    <dt>{t('admin.recoveries.completed')}</dt>
                    <dd>{f.date(selected.completed_at, 'dateTime')}</dd>
                  </div>
                ) : null}
                {selected.restricted_until ? (
                  <div>
                    <dt>{t('admin.recoveries.restrictedUntil')}</dt>
                    <dd>{f.date(selected.restricted_until, 'dateTime')}</dd>
                  </div>
                ) : null}
              </dl>
              <h3 className="adm-panel-title">{t('admin.recoveries.decisions')}</h3>
              {selected.decisions.length === 0 ? (
                <p className="adm-muted">{t('admin.recoveries.noDecisions')}</p>
              ) : (
                <ul className="adm-mine" data-testid="recovery-decisions">
                  {selected.decisions.map((d, i) => (
                    <li key={`${d.decided_at}-${i}`}>
                      <p>
                        <strong>{t(d.decision === 'approve' ? 'admin.recoveries.approved' : 'admin.recoveries.rejected')}</strong>
                        {' · '}
                        <Bidi>{d.decided_by_display}</Bidi>
                        {' · '}
                        {f.date(d.decided_at, 'dateTime')}
                      </p>
                      {d.verification_method ? (
                        <p className="adm-muted">
                          {methodLabel(d.verification_method, t)}
                          {d.note ? (
                            <>
                              {' — '}
                              <Bidi>{d.note}</Bidi>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      <p>
                        <ReasonText reason={d.reason} />
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ) : selectedId && detail.isError ? (
            <p data-testid="recovery-not-found">{t('admin.recoveries.notFound')}</p>
          ) : (
            <p className="adm-muted">{t('admin.recoveries.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.recoveries.decisionLabel')}</h2>
            {restricted ? <Banner tone="warn" text={t('admin.kit.problem.recoveryRestricted')} /> : null}
            {!selected ? (
              <p className="adm-muted">{t('admin.recoveries.pickFirst')}</p>
            ) : !can.approve && !can.reject ? (
              <p>{t('admin.recoveries.closed', { status: recoveryStatusLabel(selected.status, t) })}</p>
            ) : (
              <>
                {selected.approved_by_me ? <p data-testid="recovery-mine">{t('admin.recoveries.approvedByMe')}</p> : null}
                <p className="adm-muted">{t('admin.recoveries.checkFirst')}</p>
                <div className="adm-actions">
                  {can.approve ? (
                    <Button
                      variant="primary"
                      icon="check"
                      aria-keyshortcuts="A"
                      loading={approve.state.status === 'busy'}
                      disabled={busy}
                      onClick={() => open('approve')}
                    >
                      {t('admin.recoveries.approve.action')}
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    icon="close"
                    aria-keyshortcuts="R"
                    loading={reject.state.status === 'busy'}
                    disabled={busy}
                    onClick={() => open('reject')}
                  >
                    {t('admin.recoveries.reject.action')}
                  </Button>
                </div>
              </>
            )}
            {action.state.status === 'failed' && action.state.problem.selfApproval ? (
              <div data-kit="outcome" data-outcome="failed" data-code="SELF_APPROVAL_FORBIDDEN">
                <Banner tone="warn" text={t('admin.recoveries.own')} />
              </div>
            ) : action.state.status === 'done' || action.state.status === 'failed' ? (
              <ActionNotice
                state={action.state}
                applied={t(decided === 'reject' ? 'admin.recoveries.reject.done' : 'admin.recoveries.approve.done')}
              />
            ) : null}
            <p className="adm-muted">{t('admin.approvals.stepUpHint')}</p>
          </>
        }
      />
      <ApproveDialog open={dialog === 'approve'} onClose={() => setDialog(null)} request={selected} onSubmit={submitApprove} />
      <ReasonDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        kind="recovery_reject"
        title={t('admin.recoveries.reject.title')}
        confirmLabel={t('admin.recoveries.reject.action')}
        confirmVariant="danger"
        summary={
          selected ? (
            <>
              <p className="adm-panel-title">
                <Bidi>{selected.display_name}</Bidi>
              </p>
              <p className="adm-muted">{t('admin.recoveries.reject.effect')}</p>
            </>
          ) : null
        }
        onSubmit={submitReject}
        name="reject-recovery"
      />
    </div>
  );
}
