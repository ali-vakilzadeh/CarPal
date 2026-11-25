'use client';
// My decisions (AC14-2, admin.my_decisions_list, backend S20): a community reviewer's or moderator's own review-approval
// decisions and dispute resolutions of the last 30 days, newest first, read without an access purpose, so they can look
// back after the approval or dispute purpose has ended. Decision summaries only: the business concerned, never the
// author, reporter or evidence. Reached from the account menu (like My actions for administrators); a filter by kind.
import type { StaffDecision } from '@carpal/api-contracts';
import { DataTable, useUrlFilters, type Column, type FilterDef } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { DISPUTE_STATUSES, DISPUTE_TYPES, enumLabel, REVIEW_STATUSES } from '@/features/reviews';
import { useApiQuery } from '@/lib/api/query';
import { REASON_CODES } from '@/lib/config/reasons';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

const KINDS = ['approval', 'dispute'] as const;
const DECISIONS = ['approved', 'rejected', 'evidence_requested', 'resolved_upheld', 'resolved_rejected', 'withdrawn'] as const;

export function DecisionsPage() {
  const t = useT();
  const f = useFormat();
  const filters: FilterDef[] = [
    {
      key: 'kind',
      label: t('admin.decisions.filter.kind'),
      allowAll: true,
      options: KINDS.map((k) => ({ value: k, label: t(`admin.decisions.kind.${k}`) })),
    },
  ];
  const { values, query, setFilter, applyView } = useUrlFilters(filters);
  const q = useApiQuery('admin.my_decisions_list', { query: query as { kind?: StaffDecision['kind'] } });
  const columns: Column<StaffDecision>[] = [
    {
      id: 'decided',
      header: t('admin.decisions.col.decided'),
      pinned: true,
      cell: (d) => f.date(d.decided_at, 'dateTime'),
    },
    { id: 'kind', header: t('admin.decisions.col.kind'), cell: (d) => enumLabel(KINDS, 'admin.decisions.kind', d.kind, t) },
    {
      id: 'decision',
      header: t('admin.decisions.col.decision'),
      cell: (d) => enumLabel(DECISIONS, 'admin.decisions.decision', d.decision, t),
    },
    {
      id: 'business',
      header: t('admin.decisions.col.business'),
      cell: (d) => (d.subject ? <Bidi>{d.subject.name}</Bidi> : '—'),
    },
    {
      id: 'about',
      header: t('admin.decisions.col.about'),
      cell: (d) => (d.dispute_type ? enumLabel(DISPUTE_TYPES, 'admin.disputes.type', d.dispute_type, t) : t('admin.decisions.aboutReview')),
    },
    {
      id: 'now',
      header: t('admin.decisions.col.now'),
      cell: (d) =>
        d.kind === 'dispute' && d.dispute_status
          ? enumLabel(DISPUTE_STATUSES, 'admin.disputes.status', d.dispute_status, t)
          : enumLabel(REVIEW_STATUSES, 'admin.trust.reviewStatus', d.review_status, t),
    },
    {
      id: 'reason',
      header: t('admin.decisions.col.reason'),
      cell: (d) => (d.reason_code ? enumLabel(REASON_CODES, 'admin.reasons.codes', d.reason_code, t) : '—'),
    },
  ];
  return (
    <div className="adm-page" data-testid="decisions-page">
      <h1 className="adm-page-title">{t('admin.decisions.title')}</h1>
      <p className="adm-muted">{t('admin.decisions.intro')}</p>
      {q.data?.truncated ? <Banner tone="info" text={t('admin.decisions.truncated')} /> : null}
      <DataTable
        id="my-decisions"
        caption={t('admin.decisions.listLabel')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(d) => `${d.kind}:${d.dispute_id ?? d.review_id ?? ''}:${d.decided_at}`}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.decisions.empty')}
        filters={filters}
        filterValues={values}
        onFilterChange={setFilter}
        onApplyView={applyView}
      />
    </div>
  );
}
