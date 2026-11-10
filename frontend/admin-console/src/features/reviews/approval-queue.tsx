'use client';
// The Path 2 approval queue (AC7.T1/T2/T5, Docs/23 A-REV-01 "Awaiting approval", A-REV-02 approval panel, Docs/02 WP9
// Path 2). Reviews written without a visit wait for the business (7 days; silence is no objection) and then for a
// CarPal community reviewer, who has 2 working days. The list is admin.review_approvals_queue by stage, oldest first;
// the item is admin.review_approval_get (purpose approval:<review id>, audited); the decision is
// admin.review_approval_decide (CRV only): Confirm publishes the review as "Approved by the business and CarPal",
// Reject keeps it unpublished (the author is told the reason category and can appeal), Ask for evidence keeps it
// waiting. A rating is never a reason to reject. Keys: J/K move, A confirms, R rejects; both open the reason first.
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import type { StaffReviewApprovalView } from '@carpal/api-contracts';
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
import { useShortcut } from '@/features/shell';
import { purposeOf } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import type { ReasonKind } from '@/lib/config/reasons';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { reviewApprovalTimer } from '@/lib/work/queues';
import {
  APPROVAL_STAGES,
  approvalStage,
  BUSINESS_STATUSES,
  confirmBlock,
  decidable,
  enumLabel,
  excerpt,
  VERIFIED_STATUSES,
  type ApprovalStage,
} from './review-logic';
import { AuthorContext, BusinessStep, EvidenceList, Rating, ReviewBlock } from './review-parts';

const PAGE_SIZE = 50;
const LIST_KEY = ['admin.review_approvals_queue'] as const;

type Decision = 'approved' | 'rejected' | 'evidence_requested';
const DECISION_REASON: Record<Decision, ReasonKind> = {
  approved: 'review_confirm',
  rejected: 'review_reject',
  evidence_requested: 'review_evidence',
};
const DECISION_KEY: Record<Decision, string> = { approved: 'confirm', rejected: 'reject', evidence_requested: 'evidence' };

export function ApprovalQueue() {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const canDecide = canCall('admin.review_approval_decide', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'stage',
        label: t('admin.reviews.filter.stage'),
        options: APPROVAL_STAGES.map((s) => ({ value: s, label: t(`admin.reviews.stage.${s}`) })),
        defaultValue: 'awaiting_reviewer',
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const stage = filters.values.stage as ApprovalStage;
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.review_approvals_queue',
    { query: { stage, limit: PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) } },
    { refetchInterval: 60_000 },
  );
  const items = list.data?.items;
  const selectedId = params.get('review');
  const fromList = items?.find((v) => v.review.id === selectedId) ?? null;

  // A decided review leaves the queue and its approval purpose ends: keep the answer of the decision on screen.
  const [decided, setDecided] = useState<{ view: StaffReviewApprovalView; decision: Decision } | null>(null);
  const decidedHere = decided && decided.view.review.id === selectedId ? decided : null;
  const purpose = selectedId ? purposeOf('approval', selectedId) : null;
  const detail = useApiQuery(
    'admin.review_approval_get',
    selectedId && purpose ? { path: { review_id: selectedId }, purpose } : undefined,
    { enabled: !!selectedId && !decidedHere },
  );
  const view = decidedHere?.view ?? detail.data ?? fromList;

  const select = (v: StaffReviewApprovalView) => {
    const p = new URLSearchParams(params);
    p.set('review', v.review.id);
    p.set('purpose', purposeOf('approval', v.review.id));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const [dialog, setDialog] = useState<Decision | null>(null);
  // The decision of the last run (read in onOutcome, so a ref rather than state).
  const lastRef = useRef<Decision | null>(null);
  const [last, setLast] = useState<Decision | null>(null);
  const action = useAdminAction('admin.review_approval_decide', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      if (o.kind === 'applied' && lastRef.current) setDecided({ view: o.data, decision: lastRef.current });
    },
  });
  const busy = action.state.status === 'busy';
  const open = !!view && canDecide && decidable(view) && !decidedHere;
  const block = view ? confirmBlock(view) : 'not_pending';
  const start = (d: Decision) => {
    if (!open || busy || (d === 'approved' && block)) return;
    action.reset();
    setDialog(d);
  };
  useShortcut('approve', () => start('approved'), open && !block);
  useShortcut('reject', () => start('rejected'), open);

  const submit = (reason: string, draft: { code: string }) => {
    if (!view || !dialog || !purpose) return;
    const decision = dialog;
    setDialog(null);
    setLast(decision);
    lastRef.current = decision;
    void action
      .run({ path: { review_id: view.review.id }, purpose, body: { decision, reason_code: draft.code, reason }, reason })
      .then((r) => {
        if (r.status === 'failed' && r.problem.code === 'INVALID_TRANSITION') void detail.refetch();
      });
  };

  const now = list.dataUpdatedAt;
  const columns: Column<StaffReviewApprovalView>[] = [
    {
      id: 'review',
      header: t('admin.reviews.col.review'),
      pinned: true,
      cell: (v) => <Bidi>{excerpt(v.review) || t('admin.reviews.noText')}</Bidi>,
    },
    { id: 'rating', header: t('admin.reviews.col.rating'), align: 'end', cell: (v) => <Rating value={v.review.overall_rating} /> },
    { id: 'subject', header: t('admin.reviews.col.subject'), cell: (v) => <Bidi>{v.subject.name}</Bidi> },
    { id: 'author', header: t('admin.reviews.col.author'), cell: (v) => <Bidi>{v.author_display_name}</Bidi> },
    {
      id: 'business',
      header: t('admin.reviews.col.business'),
      cell: (v) => enumLabel(BUSINESS_STATUSES, 'admin.trust.business', v.review.business_confirmation_status, t),
    },
    {
      id: 'stage',
      header: t('admin.reviews.col.stage'),
      defaultHidden: true,
      cell: (v) => t(`admin.reviews.stage.${approvalStage(v.review)}`),
    },
    {
      id: 'written',
      header: t('admin.reviews.col.written'),
      cell: (v, ctx) => <time dateTime={v.review.created_at}>{ctx.digits(f.date(v.review.created_at, 'dateShort'))}</time>,
    },
    {
      id: 'sla',
      header: t('admin.reviews.col.sla'),
      cell: (v) => {
        if (approvalStage(v.review) === 'awaiting_business')
          return v.business_confirmation_due_at
            ? t('admin.reviews.businessUntil', { when: f.date(v.business_confirmation_due_at, 'date') })
            : '—';
        const timer = reviewApprovalTimer(v, timeZone, now);
        return (
          <SlaBadge state={slaState(timer.start, timer.due, now)} text={t('admin.reviews.dueIn', { when: f.relative(timer.due, now) })} />
        );
      },
    },
    { id: 'evidence', header: t('admin.reviews.col.evidence'), align: 'end', cell: (v) => f.number(v.evidence.length) },
    {
      id: 'dispute',
      header: t('admin.reviews.col.dispute'),
      cell: (v) => (v.dispute_id ? t('admin.reviews.yes') : '—'),
    },
  ];

  const decisionPanel = () => {
    if (!view) return <p className="adm-muted">{t('admin.reviews.pickFirst')}</p>;
    if (decidedHere)
      return (
        <div data-testid="decision-done">
          <p>{t(`admin.reviews.decided.${DECISION_KEY[decidedHere.decision]}` as MessageKey)}</p>
          <p className="adm-muted">
            {t('admin.reviews.nowStatus', {
              status: enumLabel(VERIFIED_STATUSES, 'admin.trust.verified', decidedHere.view.review.verified_status, t),
            })}
          </p>
        </div>
      );
    if (!canDecide) return <p data-testid="cannot-decide">{t('admin.reviews.crvOnly')}</p>;
    if (!decidable(view))
      return (
        <p>
          {t('admin.reviews.alreadyDecided', {
            status: enumLabel(VERIFIED_STATUSES, 'admin.trust.verified', view.review.verified_status, t),
          })}
        </p>
      );
    return (
      <>
        {view.review.business_confirmation_status === 'rejected' ? (
          <Banner tone="warn" icon="alert" title={t('admin.reviews.objected.title')}>
            <p className="pwa-banner-text">{t('admin.reviews.objected.text')}</p>
            {view.dispute_id ? (
              <p className="pwa-banner-text">
                <Link href={withPurpose(`/disputes?dispute=${view.dispute_id}`, purposeOf('dispute', view.dispute_id))}>
                  {t('admin.reviews.objected.link')}
                </Link>
              </p>
            ) : null}
          </Banner>
        ) : null}
        <p className="adm-muted" data-testid="rating-reminder">
          {t('admin.reviews.ratingRule')}
        </p>
        <div className="adm-actions">
          <Button
            variant="primary"
            icon="check"
            aria-keyshortcuts="A"
            disabled={!!block || busy}
            aria-describedby={block ? 'confirm-block' : undefined}
            loading={busy && last === 'approved'}
            onClick={() => start('approved')}
          >
            {t('admin.reviews.confirm')}
          </Button>
          <Button variant="danger" icon="close" aria-keyshortcuts="R" disabled={busy} onClick={() => start('rejected')}>
            {t('admin.reviews.reject')}
          </Button>
          <Button variant="secondary" icon="attach" disabled={busy} onClick={() => start('evidence_requested')}>
            {t('admin.reviews.askEvidence')}
          </Button>
        </div>
        {block ? (
          <p id="confirm-block" className="adm-muted" data-testid="confirm-block">
            {t(`admin.reviews.block.${block}` as MessageKey)}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <>
      <CaseLayout
        labels={{ list: t('admin.reviews.approvalsLabel'), item: t('admin.reviews.itemLabel'), decision: t('admin.reviews.decisionLabel') }}
        list={
          <DataTable
            id="review-approvals"
            caption={t('admin.reviews.approvalsLabel')}
            columns={columns}
            rows={items}
            rowKey={(v) => v.review.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t(`admin.reviews.empty.${stage}`)}
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
          view && purpose ? (
            <article className="adm-stack" data-testid="approval-item" data-review={view.review.id}>
              <h2 className="adm-panel-title">
                {t('admin.reviews.reviewOf', { name: view.subject.name })}
                <span className="adm-muted"> · {t(`admin.reviews.stage.${approvalStage(view.review)}`)}</span>
              </h2>
              <ReviewBlock review={view.review} />
              <BusinessStep view={view} />
              <EvidenceList items={view.evidence} purpose={purpose} />
              <AuthorContext view={view} />
            </article>
          ) : selectedId && detail.isError ? (
            <p data-testid="approval-unavailable">{t('admin.reviews.unavailable')}</p>
          ) : selectedId ? (
            <p className="adm-muted">{t('admin.kit.table.loading')}</p>
          ) : (
            <p className="adm-muted">{t('admin.reviews.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.reviews.decisionLabel')}</h2>
            {decisionPanel()}
            {action.state.status === 'failed' ? <ActionNotice state={action.state} /> : null}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog ? DECISION_REASON[dialog] : 'review_confirm'}
        title={dialog ? t(`admin.reviews.dialog.${DECISION_KEY[dialog]}.title` as MessageKey) : ''}
        confirmLabel={dialog ? t(`admin.reviews.dialog.${DECISION_KEY[dialog]}.button` as MessageKey) : ''}
        confirmVariant={dialog === 'rejected' ? 'danger' : 'primary'}
        summary={
          view && dialog ? (
            <>
              <p>
                <Bidi>{excerpt(view.review, 160)}</Bidi>
              </p>
              <p className="adm-muted">{t(`admin.reviews.dialog.${DECISION_KEY[dialog]}.effect` as MessageKey)}</p>
              {dialog === 'rejected' ? <p className="adm-muted">{t('admin.reviews.ratingRule')}</p> : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="review-decision"
      />
    </>
  );
}
