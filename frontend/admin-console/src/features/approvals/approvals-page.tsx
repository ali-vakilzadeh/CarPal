'use client';
// Pending approvals (AC5.T4, Docs/23 §3.3 "Four-eyes request", GD-11, SEC-ADM-6): the changes waiting for a second
// staff member (admin.four_eyes_list: never the caller's own; moderators see moderation changes only, the server
// filters), in the three-panel layout: the list, the change, and the decision. Approve (A) or Reject (R) opens the
// reason; admin.four_eyes_decide is AAL3, so a sign-in older than the step-up window asks for the security key and
// repeats the decision once. SELF_APPROVAL_FORBIDDEN and an expired or already decided change are explained. Changes
// this staff member requested in this tab are listed apart as "Waiting for someone else" (memory only; the contract
// has no list of one's own requests, BR-21).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { PendingChange } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  FourEyesBanner,
  MY_CHANGES_KEY,
  opLabel,
  ReasonDialog,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Button } from '@/components/ds/button';
import { useShortcut } from '@/features/shell';
import { useApiQuery, useSession } from '@/lib/api/query';
import { parseReason } from '@/lib/config/reasons';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';

const STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
const PAGE_SIZE = 50;

export function statusLabel(status: string, t: Translate): string {
  return (STATUSES as readonly string[]).includes(status)
    ? t(`admin.approvals.status.${status}` as MessageKey)
    : t('admin.kit.unknown', { value: status });
}

/** The reason a requester gave, with the console's code in words. */
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

export function ApprovalsPage() {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const canDecide = canCall('admin.four_eyes_decide', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.approvals.filter.status'),
        options: STATUSES.map((s) => ({ value: s, label: statusLabel(s, t) })),
        defaultValue: 'pending',
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.four_eyes_list',
    {
      query: {
        status: filters.values.status as PendingChange['status'],
        limit: PAGE_SIZE,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const mine = useQuery<PendingChange[]>({ queryKey: MY_CHANGES_KEY, queryFn: () => [], enabled: false, staleTime: Infinity });

  const selectedId = params.get('change');
  const items = list.data?.items;
  const selected = items?.find((c) => c.change_id === selectedId) ?? null;
  const select = (change: PendingChange | null) => {
    const p = new URLSearchParams(params);
    if (change) p.set('change', change.change_id);
    else p.delete('change');
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [decided, setDecided] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const refreshList = () => void queryClient.invalidateQueries({ queryKey: ['admin.four_eyes_list'] });
  const action = useAdminAction('admin.four_eyes_decide', {
    onOutcome: (outcome) => {
      refreshList();
      // The decided change leaves the pending list; the notice below says what happened.
      if (outcome.kind === 'applied') select(null);
    },
  });

  const decidable = !!selected && selected.status === 'pending' && canDecide;
  const busy = action.state.status === 'busy';
  const open = (kind: 'approve' | 'reject') => {
    if (!decidable || busy) return;
    action.reset();
    setDialog(kind);
  };
  useShortcut('approve', () => open('approve'), decidable);
  useShortcut('reject', () => open('reject'), decidable);

  const submit = (reason: string) => {
    if (!selected || !dialog) return;
    const decision = dialog;
    setDialog(null);
    setDecided({ id: selected.change_id, decision });
    void action.run({ path: { change_id: selected.change_id }, body: { decision, reason }, reason }).then((r) => {
      // Expired or decided by someone else meanwhile: the list was stale.
      if (r.status === 'failed' && r.problem.code === 'INVALID_TRANSITION') refreshList();
    });
  };

  // Timers are measured at the moment the list was read (refreshed every minute).
  const now = list.dataUpdatedAt;
  const columns: Column<PendingChange>[] = [
    { id: 'change', header: t('admin.approvals.col.change'), pinned: true, cell: (c) => opLabel(c.op_id, t) },
    { id: 'summary', header: t('admin.approvals.col.summary'), cell: (c) => <Bidi>{c.summary}</Bidi> },
    { id: 'requested_by', header: t('admin.approvals.col.requestedBy'), cell: (c) => <Bidi>{c.requested_by_display}</Bidi> },
    {
      id: 'requested_at',
      header: t('admin.approvals.col.requestedAt'),
      cell: (c, ctx) => <time dateTime={c.requested_at}>{ctx.digits(f.date(c.requested_at, 'dateTime'))}</time>,
    },
    {
      id: 'expires',
      header: t('admin.approvals.col.expires'),
      cell: (c) =>
        c.status === 'pending' ? (
          <SlaBadge
            state={slaState(Date.parse(c.requested_at), Date.parse(c.expires_at), now)}
            text={t('admin.approvals.expiresIn', { when: f.relative(c.expires_at, now) })}
          />
        ) : (
          <time dateTime={c.expires_at}>{f.date(c.expires_at, 'dateTime')}</time>
        ),
    },
    { id: 'status', header: t('admin.approvals.col.status'), cell: (c) => statusLabel(c.status, t), defaultHidden: true },
  ];

  return (
    <div className="adm-page" data-testid="approvals-page">
      <h1 className="adm-page-title">{t('admin.approvals.title')}</h1>
      <p className="adm-measure">{t('admin.approvals.intro')}</p>
      <p className="adm-muted" data-testid="approvals-own-hint">
        {t('admin.approvals.ownHint')}
      </p>
      <CaseLayout
        labels={{
          list: t('admin.approvals.listLabel'),
          item: t('admin.approvals.itemLabel'),
          decision: t('admin.approvals.decisionLabel'),
        }}
        list={
          <DataTable
            id="approvals"
            caption={t('admin.approvals.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(c) => c.change_id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.approvals.empty')}
            selectedKey={selected?.change_id ?? null}
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
            <article data-testid="approval-detail" data-change={selected.change_id}>
              <h2 className="adm-panel-title">{opLabel(selected.op_id, t)}</h2>
              <p>
                <Bidi>{selected.summary}</Bidi>
              </p>
              <dl className="adm-facts">
                <div>
                  <dt>{t('admin.approvals.col.requestedBy')}</dt>
                  <dd>
                    <Bidi>{selected.requested_by_display}</Bidi>
                  </dd>
                </div>
                <div>
                  <dt>{t('admin.approvals.col.requestedAt')}</dt>
                  <dd>{f.date(selected.requested_at, 'dateTime')}</dd>
                </div>
                <div>
                  <dt>{t('admin.approvals.reason')}</dt>
                  <dd>
                    <ReasonText reason={selected.reason} />
                  </dd>
                </div>
                <div>
                  <dt>{t('admin.approvals.col.status')}</dt>
                  <dd data-testid="approval-status">{statusLabel(selected.status, t)}</dd>
                </div>
                <div>
                  <dt>{t('admin.approvals.col.expires')}</dt>
                  <dd>{f.date(selected.expires_at, 'dateTime')}</dd>
                </div>
              </dl>
            </article>
          ) : selectedId && items ? (
            <p data-testid="approval-not-listed">{t('admin.approvals.notListed')}</p>
          ) : (
            <p className="adm-muted">{t('admin.approvals.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.approvals.decisionLabel')}</h2>
            {!selected ? (
              <p className="adm-muted">{t('admin.approvals.pickFirst')}</p>
            ) : !canDecide ? (
              <p>{t('admin.approvals.cannotDecide')}</p>
            ) : selected.status !== 'pending' ? (
              <p>{t('admin.approvals.alreadyDecided', { status: statusLabel(selected.status, t) })}</p>
            ) : (
              <div className="adm-actions">
                <Button variant="primary" icon="check" aria-keyshortcuts="A" loading={busy} onClick={() => open('approve')}>
                  {t('admin.approvals.approve')}
                </Button>
                <Button variant="danger" icon="close" aria-keyshortcuts="R" disabled={busy} onClick={() => open('reject')}>
                  {t('admin.approvals.reject')}
                </Button>
              </div>
            )}
            {action.state.status === 'done' || action.state.status === 'failed' ? (
              <ActionNotice
                state={action.state}
                applied={t(
                  decided?.decision === 'approve'
                    ? 'admin.approvals.approved'
                    : decided?.decision === 'reject'
                      ? 'admin.approvals.rejected'
                      : 'admin.approvals.decisionDone',
                )}
              />
            ) : null}
            <p className="adm-muted">{t('admin.approvals.stepUpHint')}</p>
          </>
        }
      />
      <section aria-labelledby="mine-title" data-testid="my-requests">
        <h2 id="mine-title" className="adm-section-title">
          {t('admin.approvals.mine.title')}
        </h2>
        {mine.data?.length ? (
          <ul className="adm-mine">
            {mine.data.map((c) => (
              <li key={c.change_id}>
                <FourEyesBanner change={c} showLink={false} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-muted">{t('admin.approvals.mine.none')}</p>
        )}
      </section>
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'reject' ? 'reject_change' : 'approve_change'}
        title={dialog === 'reject' ? t('admin.approvals.rejectTitle') : t('admin.approvals.approveTitle')}
        confirmLabel={dialog === 'reject' ? t('admin.approvals.reject') : t('admin.approvals.approve')}
        confirmVariant={dialog === 'reject' ? 'danger' : 'primary'}
        summary={
          selected ? (
            <>
              <p className="adm-panel-title">{opLabel(selected.op_id, t)}</p>
              <p>
                <Bidi>{selected.summary}</Bidi>
              </p>
              <p className="adm-muted">{dialog === 'reject' ? t('admin.approvals.rejectEffect') : t('admin.approvals.approveEffect')}</p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="decide"
      />
    </div>
  );
}
