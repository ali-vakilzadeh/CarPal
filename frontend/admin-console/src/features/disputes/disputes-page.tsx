'use client';
// Disputes & appeals (AC7.T4, Docs/23 A-DSP-01, Docs/40 §23.4): disagreements that need a human decision — a
// business's objection to a Path 2 review, fake or inaccurate review claims, mediation requests, badge challenges,
// service-record disputes and moderation appeals. The list is admin.disputes_queue (status, type, assignment); the
// item is admin.dispute_get (purpose dispute:<id>: open disputes that are unassigned or the caller's) with the
// statement, who raised it and, for a review, the review with the business's answer, the author's evidence and the
// first decider (admin.review_approval_get under the same purpose). The decision is admin.dispute_resolve: start
// mediation, uphold or reject, with an outcome message both sides see and internal notes. The decider must differ
// from whoever made the decision under dispute and from whoever raised it: the server enforces it
// (SELF_APPROVAL_FORBIDDEN) and the screen explains it. Withdrawing is the raiser's step (no staff operation).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { StaffDispute } from '@carpal/api-contracts';
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
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { purposeOf, type AccessPurpose } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { disputeTimer } from '@/lib/work/queues';
import {
  DISPUTE_STATUSES,
  DISPUTE_TARGETS,
  DISPUTE_TYPES,
  disputeOutcomes,
  enumLabel,
  NOTES_MAX,
  OPEN_DISPUTE_STATUSES,
  OUTCOME_REASON,
  outcomeEffect,
  RESOLUTION_MAX,
  type DisputeOutcome,
  AuthorContext,
  BusinessStep,
  EvidenceList,
  ReviewBlock,
} from '@/features/reviews';

const PAGE_SIZE = 50;
const LIST_KEY = ['admin.disputes_queue'] as const;
const ASSIGNED = ['mine', 'unassigned'] as const;

export const disputeType = (v: string, t: Translate) => enumLabel(DISPUTE_TYPES, 'admin.disputes.type', v, t);
export const disputeStatus = (v: string, t: Translate) => enumLabel(DISPUTE_STATUSES, 'admin.disputes.status', v, t);
const targetType = (v: string, t: Translate) => enumLabel(DISPUTE_TARGETS, 'admin.disputes.target', v, t);

/**
 * The words of an outcome. For a business's objection the backend's "upheld" keeps the author's review (published
 * as disputed) and "rejected" accepts the objection: those two read as what they do (DI-24).
 */
export function outcomeLabel(type: string, outcome: DisputeOutcome, t: Translate): string {
  if (type === 'review_approval_objection' && outcome !== 'in_mediation') return t(`admin.disputes.outcomesObjection.${outcome}`);
  return t(`admin.disputes.outcomes.${outcome}`);
}

const STATUS_TONE: Record<string, 'neutral' | 'signal' | 'success' | 'danger'> = {
  open: 'signal',
  in_mediation: 'signal',
  resolved_upheld: 'success',
  resolved_rejected: 'neutral',
  withdrawn: 'neutral',
};

export function DisputesPage() {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.disputes.filter.status'),
        options: DISPUTE_STATUSES.map((s) => ({ value: s, label: disputeStatus(s, t) })),
        defaultValue: 'open',
        allowAll: true,
      },
      {
        key: 'type',
        label: t('admin.disputes.filter.type'),
        options: DISPUTE_TYPES.map((s) => ({ value: s, label: disputeType(s, t) })),
        defaultValue: '',
        allowAll: true,
      },
      {
        key: 'assigned',
        label: t('admin.disputes.filter.assigned'),
        options: ASSIGNED.map((s) => ({ value: s, label: t(`admin.disputes.assigned.${s}`) })),
        defaultValue: '',
        allowAll: true,
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const v = filters.values;
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.disputes_queue',
    {
      query: {
        ...(v.status ? { status: v.status as StaffDispute['status'] } : {}),
        ...(v.type ? { dispute_type: v.type as StaffDispute['dispute_type'] } : {}),
        ...(v.assigned ? { assigned_to_me: v.assigned === 'mine' } : {}),
        limit: PAGE_SIZE,
        ...(paging.cursor ? { cursor: paging.cursor } : {}),
      },
    },
    { refetchInterval: 60_000 },
  );
  const items = list.data?.items;
  const selectedId = params.get('dispute');
  const row = items?.find((d) => d.id === selectedId) ?? null;
  const [resolved, setResolved] = useState<StaffDispute | null>(null);
  const resolvedHere = resolved && resolved.id === selectedId ? resolved : null;
  // Only open disputes are readable for a purpose; a decided one is shown from the list (or the decision's answer).
  // Wait for the list: a decided dispute in it is not read again (its purpose has ended).
  const readable = !!selectedId && !resolvedHere && !!items && (!row || OPEN_DISPUTE_STATUSES.includes(row.status));
  const purpose = selectedId ? purposeOf('dispute', selectedId) : null;
  const detail = useApiQuery('admin.dispute_get', selectedId && purpose ? { path: { dispute_id: selectedId }, purpose } : undefined, {
    enabled: readable,
  });
  const dispute = resolvedHere ?? (readable ? detail.data : null) ?? row;

  const select = (d: StaffDispute) => {
    const p = new URLSearchParams(params);
    p.set('dispute', d.id);
    p.set('purpose', purposeOf('dispute', d.id));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const now = list.dataUpdatedAt;
  const columns: Column<StaffDispute>[] = [
    { id: 'type', header: t('admin.disputes.col.type'), pinned: true, cell: (d) => disputeType(d.dispute_type, t) },
    { id: 'target', header: t('admin.disputes.col.target'), cell: (d) => targetType(d.target.type, t) },
    {
      id: 'raised_by',
      header: t('admin.disputes.col.raisedBy'),
      cell: (d) => (
        <Bidi>{d.raised_by_organization ? `${d.raised_by_organization.name} (${d.raised_by_display})` : d.raised_by_display}</Bidi>
      ),
    },
    { id: 'status', header: t('admin.disputes.col.status'), cell: (d) => disputeStatus(d.status, t) },
    {
      id: 'raised',
      header: t('admin.disputes.col.raised'),
      cell: (d, ctx) => <time dateTime={d.created_at}>{ctx.digits(f.date(d.created_at, 'dateShort'))}</time>,
    },
    {
      id: 'sla',
      header: t('admin.disputes.col.sla'),
      cell: (d) => {
        if (!OPEN_DISPUTE_STATUSES.includes(d.status)) return '—';
        const timer = disputeTimer(d, timeZone);
        return (
          <SlaBadge state={slaState(timer.start, timer.due, now)} text={t('admin.reviews.dueIn', { when: f.relative(timer.due, now) })} />
        );
      },
    },
    {
      id: 'assignee',
      header: t('admin.disputes.col.assignee'),
      cell: (d) => (d.assigned_to_display ? <Bidi>{d.assigned_to_display}</Bidi> : '—'),
    },
  ];

  return (
    <div className="adm-page" data-testid="disputes-page">
      <h1 className="adm-page-title">{t('admin.disputes.title')}</h1>
      <p className="adm-measure">{t('admin.disputes.intro')}</p>
      <CaseLayout
        labels={{ list: t('admin.disputes.listLabel'), item: t('admin.disputes.itemLabel'), decision: t('admin.disputes.decisionLabel') }}
        list={
          <DataTable
            id="disputes"
            caption={t('admin.disputes.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(d) => d.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.disputes.empty')}
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
          dispute && purpose ? (
            <DisputeItem dispute={dispute} purpose={purpose} readable={readable} unavailable={readable && detail.isError} />
          ) : selectedId && detail.isError ? (
            <p data-testid="dispute-unavailable">{t('admin.disputes.unavailable')}</p>
          ) : selectedId ? (
            <p className="adm-muted">{t('admin.kit.table.loading')}</p>
          ) : (
            <p className="adm-muted">{t('admin.disputes.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.disputes.decisionLabel')}</h2>
            {!dispute || !purpose ? (
              <p className="adm-muted">{t('admin.disputes.pickFirst')}</p>
            ) : !canCall('admin.dispute_resolve', roles) ? (
              <p>{t('admin.disputes.cannotDecide')}</p>
            ) : (
              <DisputeDecision
                key={dispute.id}
                dispute={dispute}
                purpose={purpose}
                ready={!readable || !!detail.data}
                onResolved={(d) => setResolved(d)}
              />
            )}
          </>
        }
      />
    </div>
  );
}

function DisputeItem({
  dispute,
  purpose,
  readable,
  unavailable,
}: {
  dispute: StaffDispute;
  purpose: AccessPurpose;
  readable: boolean;
  unavailable: boolean;
}) {
  const t = useT();
  const f = useFormat();
  return (
    <article className="adm-stack" data-testid="dispute-item" data-dispute={dispute.id}>
      <h2 className="adm-panel-title">
        {disputeType(dispute.dispute_type, t)}{' '}
        <Badge tone={STATUS_TONE[dispute.status] ?? 'neutral'}>{disputeStatus(dispute.status, t)}</Badge>
      </h2>
      {unavailable ? (
        <p data-testid="dispute-unavailable">
          {dispute.assigned_to_display
            ? t('admin.disputes.handledBy', { name: dispute.assigned_to_display })
            : t('admin.disputes.unavailable')}
        </p>
      ) : null}
      <section className="adm-panel" aria-label={t('admin.disputes.statement')}>
        <h3 className="adm-subtitle">{t('admin.disputes.statement')}</h3>
        <blockquote className="adm-quote">
          <p>
            <Bidi>{dispute.reason}</Bidi>
          </p>
        </blockquote>
        <dl className="adm-facts">
          <div>
            <dt>{t('admin.disputes.col.raisedBy')}</dt>
            <dd>
              <Bidi>{dispute.raised_by_display}</Bidi>
              {dispute.raised_by_organization ? (
                <>
                  {' · '}
                  <EntityChip type="organization" id={dispute.raised_by_organization.id} label={dispute.raised_by_organization.name} />
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{t('admin.disputes.col.raised')}</dt>
            <dd>{f.date(dispute.created_at, 'dateTime')}</dd>
          </div>
          <div>
            <dt>{t('admin.disputes.col.target')}</dt>
            <dd>
              {targetType(dispute.target.type, t)} <EntityChip type={dispute.target.type} id={dispute.target.id} />
            </dd>
          </div>
          <div>
            <dt>{t('admin.disputes.col.assignee')}</dt>
            <dd>{dispute.assigned_to_display ? <Bidi>{dispute.assigned_to_display}</Bidi> : t('admin.disputes.unassigned')}</dd>
          </div>
          {dispute.resolution ? (
            <div>
              <dt>{t('admin.disputes.resolution')}</dt>
              <dd data-testid="dispute-resolution">
                <Bidi>{dispute.resolution}</Bidi>
              </dd>
            </div>
          ) : null}
          {dispute.resolved_at ? (
            <div>
              <dt>{t('admin.disputes.resolvedAt')}</dt>
              <dd>{f.date(dispute.resolved_at, 'dateTime')}</dd>
            </div>
          ) : null}
          {dispute.moderator_notes ? (
            <div>
              <dt>{t('admin.disputes.notes')}</dt>
              <dd>
                <Bidi>{dispute.moderator_notes}</Bidi>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      {readable && dispute.target.type === 'review' ? (
        <DisputedReview reviewId={dispute.target.id} purpose={purpose} />
      ) : (
        <p className="adm-muted" data-testid="target-note">
          {readable ? t('admin.disputes.targetNotShown') : t('admin.disputes.decidedSummary')}
        </p>
      )}
      <p className="adm-muted">{t('admin.disputes.noThread')}</p>
    </article>
  );
}

/** The disputed review with both sides' evidence: the business's answer and note, the author's files. */
function DisputedReview({ reviewId, purpose }: { reviewId: string; purpose: AccessPurpose }) {
  const t = useT();
  const view = useApiQuery('admin.review_approval_get', { path: { review_id: reviewId }, purpose });
  if (view.isPending) return <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
  if (view.isError)
    return (
      <p className="adm-muted" data-testid="review-not-path2">
        {t('admin.disputes.reviewNotPath2')}
      </p>
    );
  return (
    <div className="adm-stack" data-testid="disputed-review">
      <ReviewBlock review={view.data.review} />
      <BusinessStep view={view.data} />
      <EvidenceList items={view.data.evidence} purpose={purpose} />
      <AuthorContext view={view.data} />
    </div>
  );
}

function DisputeDecision({
  dispute,
  purpose,
  ready,
  onResolved,
}: {
  dispute: StaffDispute;
  purpose: AccessPurpose;
  ready: boolean;
  onResolved: (d: StaffDispute) => void;
}) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const queryClient = useQueryClient();
  const outcomes = disputeOutcomes(dispute);
  const [outcome, setOutcome] = useState<DisputeOutcome | null>(null);
  const [resolution, setResolution] = useState('');
  const [notes, setNotes] = useState(dispute.moderator_notes ?? '');
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [sent, setSent] = useState<DisputeOutcome | null>(null);
  const action = useAdminAction('admin.dispute_resolve', {
    target: dispute.id,
    onOutcome: (o) => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      if (o.kind === 'applied') {
        if (o.data.status === 'in_mediation') void queryClient.invalidateQueries({ queryKey: ['admin.dispute_get'] });
        else onResolved(o.data);
      }
    },
  });
  const busy = action.state.status === 'busy';
  const resolving = outcome === 'resolved_upheld' || outcome === 'resolved_rejected';
  const problems = {
    outcome: !outcome,
    resolution: (resolving && !resolution.trim()) || resolution.length > RESOLUTION_MAX,
    notes: notes.length > NOTES_MAX,
  };
  const valid = !problems.outcome && !problems.resolution && !problems.notes;

  if (!outcomes.length)
    return (
      <div data-testid="dispute-closed">
        <p>{t('admin.disputes.closed', { status: disputeStatus(dispute.status, t) })}</p>
        {action.state.status === 'done' ? (
          <ActionNotice state={action.state} applied={t(`admin.disputes.done.${sent ?? 'resolved_upheld'}` as MessageKey)} />
        ) : null}
      </div>
    );
  if (!ready) return <p className="adm-muted">{t('admin.disputes.cannotDecideNow')}</p>;

  const submit = (reason: string) => {
    if (!outcome || !valid) return;
    setDialog(false);
    setSent(outcome);
    const trimmedNotes = notes.trim();
    void action.run({
      path: { dispute_id: dispute.id },
      purpose,
      body: {
        status: outcome,
        ...(resolution.trim() ? { resolution: resolution.trim() } : {}),
        ...(trimmedNotes !== (dispute.moderator_notes ?? '') ? { moderator_notes: trimmedNotes } : {}),
        reason,
      },
      reason,
    });
  };

  const failed = action.state.status === 'failed' ? action.state.problem : null;
  return (
    <>
      <form
        className="adm-stack"
        noValidate
        data-testid="dispute-decision"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!valid || busy) return;
          action.reset();
          setDialog(true);
        }}
      >
        <p className="adm-muted" data-testid="different-staff-rule">
          {t('admin.disputes.differentStaff')}
        </p>
        <fieldset className="adm-choices" aria-describedby={tried && problems.outcome ? `${uid}-o` : undefined}>
          <legend>{t('admin.disputes.outcome')}</legend>
          {outcomes.map((o) => (
            <label key={o} className="adm-radio">
              <input type="radio" name={`${uid}-outcome`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
              {outcomeLabel(dispute.dispute_type, o, t)}
            </label>
          ))}
          {tried && problems.outcome ? (
            <p id={`${uid}-o`} className="adm-error">
              {t('admin.disputes.outcomeRequired')}
            </p>
          ) : null}
        </fieldset>
        {outcome ? (
          <p className="adm-preview" data-testid="outcome-effect">
            {t(outcomeEffect(dispute.dispute_type, outcome))}
          </p>
        ) : null}
        <TextField
          multiline
          rows={3}
          label={resolving ? t('admin.disputes.resolutionRequiredLabel') : t('admin.disputes.resolution')}
          hint={t('admin.disputes.resolutionHint', { n: f.number(RESOLUTION_MAX) })}
          error={tried && problems.resolution ? t('admin.disputes.resolutionInvalid', { n: f.number(RESOLUTION_MAX) }) : undefined}
          value={resolution}
          maxLength={RESOLUTION_MAX}
          onChange={(e) => setResolution(e.target.value)}
        />
        <TextField
          multiline
          rows={3}
          label={t('admin.disputes.notes')}
          hint={t('admin.disputes.notesHint', { n: f.number(NOTES_MAX) })}
          error={problems.notes ? t('admin.disputes.notesTooLong', { n: f.number(NOTES_MAX) }) : undefined}
          value={notes}
          maxLength={NOTES_MAX}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="adm-actions">
          <Button type="submit" variant="primary" loading={busy}>
            {t('admin.disputes.record')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.disputes.withdrawNote')}</p>
        {failed?.selfApproval ? (
          <div data-kit="outcome" data-outcome="failed" data-code={failed.code} data-testid="different-staff-refused">
            <Banner tone="warn" icon="alert" title={t('admin.disputes.refused.title')} text={t('admin.disputes.refused.text')} />
          </div>
        ) : action.state.status === 'done' || action.state.status === 'failed' ? (
          <ActionNotice state={action.state} applied={t(`admin.disputes.done.${sent ?? 'in_mediation'}` as MessageKey)} />
        ) : null}
      </form>
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind={outcome ? OUTCOME_REASON[outcome] : 'mediation'}
        title={outcome ? outcomeLabel(dispute.dispute_type, outcome, t) : ''}
        confirmLabel={t('admin.disputes.record')}
        confirmVariant={outcome === 'resolved_rejected' ? 'danger' : 'primary'}
        irreversible={resolving}
        summary={
          outcome ? (
            <>
              <p>{disputeType(dispute.dispute_type, t)}</p>
              <p className="adm-muted">{t(outcomeEffect(dispute.dispute_type, outcome))}</p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="dispute-resolve"
      />
    </>
  );
}
