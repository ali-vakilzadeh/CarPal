'use client';
// Privacy requests (AC10.T4/T5, Docs/23 A-DSR-01 and A-DSR-02, Docs/02 WP2, Docs/40 §23.5 admin.dsr_queue,
// admin.dsr_update, admin.dsr_export, admin.job_get, admin.dsr_execute_deletion). Support staff and platform admins
// meet data subject rights on time: the queue (type, status, the "overdue" and "due this week" views; the due date
// with its countdown; most urgent first) and, in the three-panel layout, the request and its steps. Every step is a
// purpose-bound write for the request (dsr:<id>, SEC-ADM-5) with a reason: identity check, processing, completion or
// rejection with a text for the user; an export file built in the background (followed with admin.job_get, BR-20;
// staff never download it, DQ-12: the user does); and the deletion, run only after a second administrator approves
// (four-eyes, ADM). The contract has no read of one request (the item comes from the queue row, D-67, BR-38), no
// assignee, no deletion preview and no list of the records a rectification concerns: the screen says so (DI-33).
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  ReasonDialog,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  withPurpose,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { purposeOf } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import type { ReasonKind } from '@/lib/config/reasons';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import {
  byDue,
  canBuildExport,
  canRunDeletion,
  DSR_REJECTION_MAX,
  DSR_STATUSES,
  DSR_TYPES,
  DSR_VIEWS,
  dsrMoves,
  dueBeforeOf,
  inDsrView,
  isOpenDsr,
  MOVE_REASON,
  shortId,
  type DsrMove,
  type DsrRow,
  type DsrStatus,
  type DsrType,
} from './dsr-logic';

const PAGE_SIZE = 50;
const JOB_DONE = ['succeeded', 'failed', 'cancelled'];

function enumLabel(list: readonly string[], prefix: string, value: string, t: Translate): string {
  return list.includes(value) ? t(`${prefix}.${value}` as MessageKey) : t('admin.kit.unknown', { value });
}
export const dsrType = (v: string, t: Translate) => enumLabel(DSR_TYPES, 'admin.privacy.type', v, t);
export const dsrStatus = (v: string, t: Translate) => enumLabel(DSR_STATUSES, 'admin.privacy.status', v, t);

type Dialog = { kind: 'move'; move: DsrMove } | { kind: 'export' } | { kind: 'deletion' };

export function PrivacyPage() {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const canUpdate = canCall('admin.dsr_update', roles);
  const canExport = canCall('admin.dsr_export', roles);
  const canDelete = canCall('admin.dsr_execute_deletion', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'view',
        label: t('admin.privacy.filter.view'),
        options: DSR_VIEWS.map((v) => ({ value: v, label: t(`admin.privacy.view.${v}`) })),
        defaultValue: '',
        allowAll: true,
      },
      {
        key: 'type',
        label: t('admin.privacy.filter.type'),
        options: DSR_TYPES.map((v) => ({ value: v, label: dsrType(v, t) })),
        defaultValue: '',
        allowAll: true,
      },
      {
        key: 'status',
        label: t('admin.privacy.filter.status'),
        options: DSR_STATUSES.map((v) => ({ value: v, label: dsrStatus(v, t) })),
        defaultValue: '',
        allowAll: true,
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const view = filters.values.view ?? '';
  const paging = useCursorPaging(JSON.stringify(filters.query));
  // The day boundary of the views is read once per filter change (not every render).
  const [clock] = useState(() => Date.now());
  const dueBefore = dueBeforeOf(view, clock, timeZone);
  const list = useApiQuery(
    'admin.dsr_queue',
    {
      query: {
        ...(filters.values.status ? { status: filters.values.status as DsrStatus } : {}),
        ...(filters.values.type ? { request_type: filters.values.type as DsrType } : {}),
        ...(dueBefore ? { due_before: dueBefore } : {}),
        limit: PAGE_SIZE,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const now = list.dataUpdatedAt || clock;
  const rows = useMemo(
    () => (list.data ? [...list.data.items].filter((r) => inDsrView(r, view, now)).sort(byDue) : undefined),
    [list.data, view, now],
  );

  const selectedId = params.get('request');
  const listed = list.data?.items.find((r) => r.id === selectedId) ?? null;
  // The answer of the last write replaces the row until the list is read again (the contract has no read by id).
  const [answer, setAnswer] = useState<DsrRow | null>(null);
  const selected: DsrRow | null = answer && answer.id === selectedId ? { ...answer, user_id: listed?.user_id ?? answer.user_id } : listed;
  const purpose = selected ? purposeOf('dsr', selected.id) : null;
  const select = (r: DsrRow | null) => {
    const p = new URLSearchParams(params);
    if (r) {
      p.set('request', r.id);
      p.set('purpose', purposeOf('dsr', r.id));
    } else {
      p.delete('request');
      p.delete('purpose');
    }
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin.dsr_queue'] });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [lastMove, setLastMove] = useState<DsrMove | null>(null);
  const [rejection, setRejection] = useState('');
  const [rejectTried, setRejectTried] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const update = useAdminAction('admin.dsr_update', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      if (o.kind === 'applied' && selected) setAnswer({ ...o.data, user_id: selected.user_id });
      refresh();
    },
  });
  const exporter = useAdminAction('admin.dsr_export', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      if (o.kind === 'accepted') setJobId(o.job.id);
    },
  });
  const deletion = useAdminAction('admin.dsr_execute_deletion', { target: selectedId ?? undefined, onOutcome: refresh });
  const job = useApiQuery('admin.job_get', jobId ? { path: { job_id: jobId }, background: false } : undefined, {
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && JOB_DONE.includes(q.state.data.status) ? false : 3_000),
  });
  const busy = update.state.status === 'busy' || exporter.state.status === 'busy' || deletion.state.status === 'busy';

  const rejectionError =
    rejectTried && !rejection.trim()
      ? t('admin.privacy.rejectionRequired')
      : rejection.length > DSR_REJECTION_MAX
        ? t('admin.privacy.rejectionTooLong', { n: f.number(DSR_REJECTION_MAX) })
        : undefined;

  const start = (d: Dialog) => {
    if (busy || !selected) return;
    update.reset();
    exporter.reset();
    deletion.reset();
    if (d.kind === 'move' && d.move === 'rejected') {
      setRejectTried(true);
      if (!rejection.trim() || rejection.length > DSR_REJECTION_MAX) return;
    }
    setDialog(d);
  };
  const submit = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d || !selected || !purpose) return;
    const path = { request_id: selected.id };
    if (d.kind === 'move') {
      setLastMove(d.move);
      const body = d.move === 'rejected' ? { status: d.move, rejection_reason: rejection.trim(), reason } : { status: d.move, reason };
      void update.run({ path, purpose, body, reason });
    } else if (d.kind === 'export') {
      setJobId(null);
      void exporter.run({ path, purpose, body: { reason }, reason });
    } else void deletion.run({ path, purpose, body: { reason }, reason });
  };

  const columns: Column<DsrRow>[] = [
    { id: 'type', header: t('admin.privacy.col.type'), pinned: true, cell: (r) => dsrType(r.request_type, t) },
    { id: 'request', header: t('admin.privacy.col.request'), cell: (r) => <Bidi ltr>{shortId(r.id)}</Bidi> },
    { id: 'user', header: t('admin.privacy.col.user'), cell: (r) => <Bidi ltr>{shortId(r.user_id)}</Bidi> },
    { id: 'status', header: t('admin.privacy.col.status'), cell: (r) => dsrStatus(r.status, t) },
    {
      id: 'requested',
      header: t('admin.privacy.col.requested'),
      cell: (r, ctx) => <time dateTime={r.requested_at}>{ctx.digits(f.date(r.requested_at, 'dateShort'))}</time>,
    },
    {
      id: 'due',
      header: t('admin.privacy.col.due'),
      cell: (r, ctx) =>
        isOpenDsr(r) ? (
          <SlaBadge
            state={slaState(Date.parse(r.requested_at), Date.parse(r.due_at), now)}
            text={t('admin.privacy.dueIn', { when: f.relative(r.due_at, now) })}
          />
        ) : (
          <time dateTime={r.due_at}>{ctx.digits(f.date(r.due_at, 'dateShort'))}</time>
        ),
    },
  ];

  const item = () => {
    if (!selectedId) return <p className="adm-muted">{t('admin.privacy.pick')}</p>;
    if (!selected)
      return list.data ? (
        <p data-testid="dsr-not-listed">{t('admin.privacy.notListed')}</p>
      ) : (
        <p className="adm-muted">{t('admin.kit.table.loading')}</p>
      );
    const r = selected;
    return (
      <article className="adm-stack" data-testid="dsr-detail" data-request={r.id}>
        <h2 className="adm-panel-title">
          {t('admin.privacy.itemTitle', { type: dsrType(r.request_type, t) })} <Bidi ltr>{shortId(r.id)}</Bidi>
        </h2>
        {isOpenDsr(r) && Date.parse(r.due_at) < now ? <Banner tone="danger" text={t('admin.privacy.overdue')} /> : null}
        <dl className="adm-facts">
          <div>
            <dt>{t('admin.privacy.col.status')}</dt>
            <dd data-testid="dsr-status">{dsrStatus(r.status, t)}</dd>
          </div>
          <div>
            <dt>{t('admin.privacy.col.requested')}</dt>
            <dd>{f.date(r.requested_at, 'dateTime')}</dd>
          </div>
          <div>
            <dt>{t('admin.privacy.col.due')}</dt>
            <dd>{f.date(r.due_at, 'dateTime')}</dd>
          </div>
          {r.completed_at ? (
            <div>
              <dt>{t('admin.privacy.completedAt')}</dt>
              <dd>{f.date(r.completed_at, 'dateTime')}</dd>
            </div>
          ) : null}
          {r.request_type === 'export' || r.request_type === 'deletion' ? (
            <div>
              <dt>{t('admin.privacy.exportFile')}</dt>
              <dd data-testid="dsr-export-available">
                {r.export_available ? t('admin.privacy.exportReady') : t('admin.privacy.exportNotReady')}
              </dd>
            </div>
          ) : null}
          {r.rejection_reason ? (
            <div>
              <dt>{t('admin.privacy.rejectionShown')}</dt>
              <dd>
                <Bidi>{r.rejection_reason}</Bidi>
              </dd>
            </div>
          ) : null}
        </dl>
        <section aria-labelledby={`${uid}-details`}>
          <h3 id={`${uid}-details`} className="adm-subtitle">
            {t('admin.privacy.details')}
          </h3>
          {r.details ? (
            <blockquote className="adm-quote">
              <p>
                <Bidi>{r.details}</Bidi>
              </p>
            </blockquote>
          ) : (
            <p className="adm-muted">{t('admin.privacy.noDetails')}</p>
          )}
        </section>
        <p>
          <Link href={withPurpose(`/users/${r.user_id}`, purposeOf('dsr', r.id))} data-testid="dsr-user-link">
            {t('admin.privacy.openUser')}
          </Link>
        </p>
        <p className="adm-muted" data-testid="dsr-type-note">
          {t(`admin.privacy.typeNote.${r.request_type}` as MessageKey)}
        </p>
      </article>
    );
  };

  const decision = () => {
    if (!selected) return <p className="adm-muted">{t('admin.privacy.pickFirst')}</p>;
    if (!canUpdate) return <p>{t('admin.privacy.cannotAct')}</p>;
    const r = selected;
    const moves = isOpenDsr(r) ? dsrMoves(r) : [];
    const steps = moves.filter((m) => m !== 'rejected');
    const jobDone = job.data && JOB_DONE.includes(job.data.status);
    return (
      <div className="adm-stack">
        {!isOpenDsr(r) ? <p>{t('admin.privacy.closed', { status: dsrStatus(r.status, t) })}</p> : null}
        {steps.length ? (
          <div className="adm-actions" data-testid="dsr-moves">
            {steps.map((m) => (
              <Button
                key={m}
                size="sm"
                variant="primary"
                disabled={busy}
                loading={update.state.status === 'busy' && lastMove === m}
                onClick={() => start({ kind: 'move', move: m })}
              >
                {t(`admin.privacy.move.${m}`)}
              </Button>
            ))}
          </div>
        ) : null}
        {steps.length ? <p className="adm-muted">{t(`admin.privacy.stepHint.${r.status}` as MessageKey)}</p> : null}
        {r.request_type === 'export' && r.status === 'in_progress' ? (
          <p className="adm-muted">{t('admin.privacy.completeNeedsFile')}</p>
        ) : null}
        <ActionNotice state={update.state} applied={lastMove ? t(`admin.privacy.moved.${lastMove}`) : undefined} />
        {canExport && canBuildExport(r) ? (
          <section className="adm-panel" aria-labelledby={`${uid}-export`} data-testid="dsr-export">
            <h3 id={`${uid}-export`} className="adm-subtitle">
              {t('admin.privacy.export.title')}
            </h3>
            <p className="adm-muted">{t('admin.privacy.export.text')}</p>
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              disabled={busy || (!!jobId && !jobDone)}
              loading={exporter.state.status === 'busy'}
              onClick={() => start({ kind: 'export' })}
            >
              {r.export_available || jobDone ? t('admin.privacy.export.again') : t('admin.privacy.export.build')}
            </Button>
            {exporter.state.status === 'failed' ? <ActionNotice state={exporter.state} /> : null}
            {jobId ? <JobStatus job={job.data ?? null} failed={job.isError} /> : null}
          </section>
        ) : null}
        {canRunDeletion(r) ? (
          <section className="adm-panel" aria-labelledby={`${uid}-del`} data-testid="dsr-deletion">
            <h3 id={`${uid}-del`} className="adm-subtitle">
              {t('admin.privacy.deletion.title')}
            </h3>
            <p className="adm-muted">{t('admin.privacy.deletion.text')}</p>
            <p className="adm-muted">{t('admin.privacy.deletion.noPreview')}</p>
            {canDelete ? (
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                loading={deletion.state.status === 'busy'}
                onClick={() => start({ kind: 'deletion' })}
              >
                {t('admin.privacy.deletion.run')}
              </Button>
            ) : (
              <p>{t('admin.privacy.deletion.adminOnly')}</p>
            )}
            <ActionNotice state={deletion.state} />
          </section>
        ) : null}
        {moves.includes('rejected') ? (
          <section className="adm-panel" aria-labelledby={`${uid}-rej`}>
            <h3 id={`${uid}-rej`} className="adm-subtitle">
              {t('admin.privacy.reject.title')}
            </h3>
            <TextField
              multiline
              rows={3}
              label={t('admin.privacy.reject.message')}
              hint={t('admin.privacy.reject.hint', { n: f.number(DSR_REJECTION_MAX) })}
              error={rejectionError}
              value={rejection}
              maxLength={DSR_REJECTION_MAX}
              onChange={(e) => setRejection(e.target.value)}
            />
            <Button size="sm" variant="danger" disabled={busy} onClick={() => start({ kind: 'move', move: 'rejected' })}>
              {t('admin.privacy.move.rejected')}
            </Button>
          </section>
        ) : null}
      </div>
    );
  };

  const kind: ReasonKind = dialog?.kind === 'move' ? MOVE_REASON[dialog.move] : dialog?.kind === 'export' ? 'dsr_export' : 'dsr_deletion';
  const dialogTitle =
    dialog?.kind === 'move'
      ? t(`admin.privacy.dialog.${dialog.move}`)
      : dialog?.kind === 'export'
        ? t('admin.privacy.export.title')
        : t('admin.privacy.deletion.dialog');
  const confirmLabel =
    dialog?.kind === 'move'
      ? t(`admin.privacy.move.${dialog.move}`)
      : dialog?.kind === 'export'
        ? t('admin.privacy.export.build')
        : t('admin.privacy.deletion.run');
  const danger = dialog?.kind === 'deletion' || (dialog?.kind === 'move' && dialog.move === 'rejected');
  return (
    <div className="adm-page" data-testid="privacy-page">
      <h1 className="adm-page-title">{t('admin.privacy.title')}</h1>
      <p className="adm-measure">{t('admin.privacy.intro')}</p>
      <CaseLayout
        labels={{ list: t('admin.privacy.listLabel'), item: t('admin.privacy.itemLabel'), decision: t('admin.privacy.decisionLabel') }}
        list={
          <DataTable
            id="privacy"
            caption={t('admin.privacy.listLabel')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.privacy.empty')}
            selectedKey={selected?.id ?? null}
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
        item={item()}
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.privacy.decisionLabel')}</h2>
            {decision()}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={kind}
        title={dialogTitle}
        confirmLabel={confirmLabel}
        confirmVariant={danger ? 'danger' : 'primary'}
        irreversible={dialog?.kind === 'deletion'}
        summary={
          dialog && selected ? (
            <>
              <p>
                {dsrType(selected.request_type, t)} <Bidi ltr>{shortId(selected.id)}</Bidi>
              </p>
              <p className="adm-muted">
                {dialog.kind === 'move'
                  ? t(`admin.privacy.effect.${dialog.move}`)
                  : dialog.kind === 'export'
                    ? t('admin.privacy.export.effect')
                    : t('admin.privacy.deletion.effect')}
              </p>
              {dialog.kind === 'move' && dialog.move === 'rejected' ? (
                <blockquote className="adm-quote">
                  <p>
                    <Bidi>{rejection.trim()}</Bidi>
                  </p>
                </blockquote>
              ) : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="dsr"
      />
    </div>
  );
}

function JobStatus({ job, failed }: { job: { status: string; progress?: number; error_code?: string } | null; failed: boolean }) {
  const t = useT();
  const f = useFormat();
  if (failed) return <p data-testid="dsr-job">{t('admin.privacy.job.unreadable')}</p>;
  if (!job)
    return (
      <p className="adm-muted" data-testid="dsr-job">
        {t('admin.privacy.job.started')}
      </p>
    );
  const tone = job.status === 'succeeded' ? 'success' : job.status === 'failed' || job.status === 'cancelled' ? 'danger' : 'info';
  const known = ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status);
  return (
    <div data-testid="dsr-job" data-status={job.status}>
      <Banner
        tone={tone}
        text={
          known
            ? t(`admin.privacy.job.${job.status}` as MessageKey, { progress: f.number(job.progress ?? 0) })
            : t('admin.kit.unknown', { value: job.status })
        }
      />
    </div>
  );
}
