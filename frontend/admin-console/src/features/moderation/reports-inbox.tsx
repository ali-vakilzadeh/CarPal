'use client';
// Reports inbox (AC8.T1, Docs/23 A-CON-01 "Reported", Docs/40 admin.reports_list / admin.report_triage; moderators
// and support). User reports of content, profiles, listings, wrong locations, accounts and AI output, oldest safety
// reports first, with the Docs/23 §6 timer. A report is triaged with a reason: into a new case (severity chosen here;
// unsafe advice, media without consent and private data are at least high, Docs/23 A-CON-01), into the open case about
// the same target (moderators: the console looks it up), or dismissed. Opening a case gathers every open report about
// the same target (the backend), so the queue shows each target once. The answer of the triage stays on screen with a
// link to the case.
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { ModerationCase, StaffReport } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  EntityChip,
  ReasonDialog,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Button } from '@/components/ds/button';
import { useApiQuery, useSession } from '@/lib/api/query';
import { slaState, URGENT_REASONS } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import {
  CASE_SEVERITIES,
  caseHref,
  enumLabel,
  MODERATION_REASONS,
  OPEN_CASE_STATUSES,
  proposedSeverity,
  REPORT_STATUSES,
  reportDue,
  severityChoices,
  TARGET_TYPES,
  thingKey,
} from './case-logic';
import { caseReason } from './case-workspace';

const PAGE_SIZE = 50;
const LIST_KEY = ['admin.reports_list'] as const;

type Triage = 'open_case' | 'link' | 'dismiss';

/** Open reports first, safety reasons first among them, then the oldest. */
function reportOrder(rows: readonly StaffReport[]): StaffReport[] {
  const open = (r: StaffReport) => (r.status === 'open' ? 1 : 0);
  const urgent = (r: StaffReport) => (URGENT_REASONS.has(r.reason) ? 1 : 0);
  return [...rows].sort((a, b) => open(b) - open(a) || urgent(b) - urgent(a) || Date.parse(a.created_at) - Date.parse(b.created_at));
}

export function ReportsInbox() {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const canTriage = canCall('admin.report_triage', roles);
  const canSeeCases = canCall('admin.cases_list', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.cases.filter.status'),
        options: REPORT_STATUSES.map((s) => ({ value: s, label: t(`admin.moderation.reportStatus.${s}`) })),
        defaultValue: 'open',
        allowAll: true,
      },
      {
        key: 'target_type',
        label: t('admin.moderation.filter.type'),
        options: TARGET_TYPES.map((x) => ({ value: x, label: t(thingKey(x)) })),
        defaultValue: '',
        allowAll: true,
      },
      {
        key: 'reason',
        label: t('admin.cases.col.reason'),
        options: MODERATION_REASONS.map((r) => ({ value: r, label: caseReason(r, t) })),
        defaultValue: '',
        allowAll: true,
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.reports_list',
    {
      query: {
        ...(filters.query as Partial<Pick<StaffReport, 'status' | 'reason'>> & { target_type?: StaffReport['target']['type'] }),
        limit: PAGE_SIZE,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const rows = useMemo(() => (list.data ? reportOrder(list.data.items) : undefined), [list.data]);
  const selectedId = params.get('report');
  const [triaged, setTriaged] = useState<StaffReport | null>(null);
  const report = (triaged && triaged.id === selectedId ? triaged : null) ?? rows?.find((r) => r.id === selectedId) ?? null;

  // The open case about the same target, if any (moderators can list cases; support staff open a new one).
  const sameTarget = useApiQuery('admin.cases_list', report ? { query: { case_type: report.target.type, limit: 100 } } : undefined, {
    enabled: !!report && report.status === 'open' && canSeeCases,
  });
  const openCase: ModerationCase | undefined = sameTarget.data?.items.find(
    (c) => c.target.id === report?.target.id && OPEN_CASE_STATUSES.includes(c.status),
  );

  const select = (r: StaffReport) => {
    const p = new URLSearchParams(params);
    p.set('report', r.id);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const [severity, setSeverity] = useState<ModerationCase['severity'] | ''>('');
  const chosenSeverity = report
    ? severity && severityChoices(report.reason).includes(severity)
      ? severity
      : proposedSeverity(report.reason)
    : 'medium';
  const [dialog, setDialog] = useState<Triage | null>(null);
  const triage = useAdminAction('admin.report_triage', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      if (o.kind === 'applied') setTriaged(o.data);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ['admin.cases_list'] });
    },
  });
  const busy = triage.state.status === 'busy';

  const submit = (reason: string) => {
    if (!report || !dialog) return;
    const d = dialog;
    setDialog(null);
    const body =
      d === 'dismiss'
        ? { dismiss: true, reason }
        : d === 'link' && openCase
          ? { moderation_case_id: openCase.id, reason }
          : { open_case: { severity: chosenSeverity }, reason };
    void triage.run({ path: { report_id: report.id }, body, reason });
  };

  const now = list.dataUpdatedAt;
  const columns: Column<StaffReport>[] = [
    { id: 'reason', header: t('admin.cases.col.reason'), pinned: true, cell: (r) => caseReason(r.reason, t) },
    { id: 'target', header: t('admin.moderation.col.type'), cell: (r) => t(thingKey(r.target.type)) },
    { id: 'reporter', header: t('admin.moderation.col.reporter'), cell: (r) => <Bidi>{r.reporter_display}</Bidi> },
    {
      id: 'received',
      header: t('admin.moderation.col.received'),
      cell: (r, ctx) => <time dateTime={r.created_at}>{ctx.digits(f.date(r.created_at, 'dateShort'))}</time>,
    },
    {
      id: 'sla',
      header: t('admin.cases.col.sla'),
      cell: (r) => {
        if (r.status !== 'open') return '—';
        const due = reportDue(r, timeZone);
        return (
          <SlaBadge state={slaState(Date.parse(r.created_at), due, now)} text={t('admin.reviews.dueIn', { when: f.relative(due, now) })} />
        );
      },
    },
    {
      id: 'status',
      header: t('admin.cases.col.status'),
      cell: (r) => enumLabel(REPORT_STATUSES, 'admin.moderation.reportStatus', r.status, t),
    },
  ];

  const item = () => {
    if (!selectedId) return <p className="adm-muted">{t('admin.moderation.reports.pick')}</p>;
    if (!report)
      return list.isPending ? <p className="adm-muted">{t('admin.kit.table.loading')}</p> : <p>{t('admin.moderation.reports.gone')}</p>;
    return (
      <article className="adm-stack" data-testid="report-item" data-report={report.id}>
        <h2 className="adm-panel-title">{caseReason(report.reason, t)}</h2>
        <dl className="adm-facts">
          <div>
            <dt>{t('admin.moderation.col.type')}</dt>
            <dd>
              {t(thingKey(report.target.type))} <EntityChip type={report.target.type} id={report.target.id} />
            </dd>
          </div>
          <div>
            <dt>{t('admin.moderation.col.reporter')}</dt>
            <dd>
              <Bidi>{report.reporter_display}</Bidi>
            </dd>
          </div>
          <div>
            <dt>{t('admin.moderation.col.received')}</dt>
            <dd>
              <time dateTime={report.created_at}>{f.date(report.created_at, 'dateTime')}</time>
            </dd>
          </div>
          <div>
            <dt>{t('admin.cases.col.status')}</dt>
            <dd data-testid="report-status">{enumLabel(REPORT_STATUSES, 'admin.moderation.reportStatus', report.status, t)}</dd>
          </div>
        </dl>
        {report.details ? (
          <blockquote className="adm-quote" aria-label={t('admin.moderation.reports.details')}>
            <p>
              <Bidi>{report.details}</Bidi>
            </p>
          </blockquote>
        ) : (
          <p className="adm-muted">{t('admin.moderation.reports.noDetails')}</p>
        )}
        {report.moderation_case_id ? (
          <p data-testid="report-case">
            {canSeeCases ? (
              <Link href={caseHref(report.target.type, report.moderation_case_id)}>{t('admin.moderation.reports.openCase')}</Link>
            ) : (
              <>
                {t('admin.moderation.reports.inCase')} <EntityChip type="case" id={report.moderation_case_id} />
              </>
            )}
          </p>
        ) : null}
      </article>
    );
  };

  const decision = () => {
    if (!report) return <p className="adm-muted">{t('admin.moderation.reports.pickFirst')}</p>;
    if (!canTriage) return <p>{t('admin.moderation.reports.cannotTriage')}</p>;
    if (report.status !== 'open')
      return (
        <div className="adm-stack">
          <p>
            {t('admin.moderation.reports.done', { status: enumLabel(REPORT_STATUSES, 'admin.moderation.reportStatus', report.status, t) })}
          </p>
          <ActionNotice
            state={triage.state}
            applied={t(report.status === 'dismissed' ? 'admin.moderation.reports.dismissed' : 'admin.moderation.reports.triaged')}
          />
        </div>
      );
    const choices = severityChoices(report.reason);
    return (
      <div className="adm-stack" data-testid="triage">
        <section className="adm-panel" aria-labelledby={`${uid}-open`}>
          <h3 id={`${uid}-open`} className="adm-subtitle">
            {t('admin.moderation.reports.openTitle')}
          </h3>
          <div className="cp-field">
            <label className="cp-field-label" htmlFor={`${uid}-sev`}>
              {t('admin.cases.col.severity')}
            </label>
            <div className="cp-field-box">
              <select
                id={`${uid}-sev`}
                className="cp-field-input adm-select"
                value={chosenSeverity}
                aria-describedby={URGENT_REASONS.has(report.reason) ? `${uid}-sev-h` : undefined}
                onChange={(e) => setSeverity(e.target.value as ModerationCase['severity'])}
              >
                {choices.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(CASE_SEVERITIES, 'admin.cases.severity', s, t)}
                  </option>
                ))}
              </select>
            </div>
            {URGENT_REASONS.has(report.reason) ? (
              <p id={`${uid}-sev-h`} className="cp-field-hint">
                {t('admin.moderation.reports.atLeastHigh')}
              </p>
            ) : null}
          </div>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setDialog('open_case')}>
            {t('admin.moderation.reports.openButton')}
          </Button>
        </section>
        {openCase ? (
          <section className="adm-panel" aria-labelledby={`${uid}-link`} data-testid="same-target-case">
            <h3 id={`${uid}-link`} className="adm-subtitle">
              {t('admin.moderation.reports.linkTitle')}
            </h3>
            <p className="adm-muted">
              {t('admin.moderation.reports.linkText', { reason: caseReason(openCase.reason, t) })}{' '}
              <EntityChip type="case" id={openCase.id} />
            </p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('link')}>
              {t('admin.moderation.reports.linkButton')}
            </Button>
          </section>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('dismiss')}>
          {t('admin.moderation.reports.dismissButton')}
        </Button>
        <ActionNotice state={triage.state} />
      </div>
    );
  };

  return (
    <>
      <CaseLayout
        labels={{
          list: t('admin.moderation.reports.listLabel'),
          item: t('admin.moderation.reports.itemLabel'),
          decision: t('admin.moderation.reports.decisionLabel'),
        }}
        list={
          <DataTable
            id="reports"
            caption={t('admin.moderation.reports.listLabel')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.moderation.reports.empty')}
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
        item={item()}
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.moderation.reports.decisionLabel')}</h2>
            {decision()}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'dismiss' ? 'report_dismiss' : 'triage'}
        title={t(`admin.moderation.reports.dialog.${dialog ?? 'open_case'}`)}
        confirmLabel={
          dialog === 'dismiss'
            ? t('admin.moderation.reports.dismissButton')
            : dialog === 'link'
              ? t('admin.moderation.reports.linkButton')
              : t('admin.moderation.reports.openButton')
        }
        summary={
          report && dialog ? (
            <p className="adm-muted">
              {dialog === 'open_case'
                ? t('admin.moderation.reports.effect.open_case', {
                    severity: enumLabel(CASE_SEVERITIES, 'admin.cases.severity', chosenSeverity, t),
                  })
                : t(`admin.moderation.reports.effect.${dialog}`)}
            </p>
          ) : null
        }
        onSubmit={submit}
        name="report"
      />
    </>
  );
}
