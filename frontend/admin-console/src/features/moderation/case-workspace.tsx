'use client';
// The moderation case workspace (AC8.T2-T4, Docs/23 A-CON-01/02, A-INV-01, §3.2 case layout; generalised from the AC7
// review case). One queue of admin.cases_list per console queue (content, accounts, AI output, inventory, reviews):
// a queue of one case type pages on the server; a queue of several types reads each type (the list filters one type
// per call, D-49) unless a type is chosen. Safety cases sort first, then severity, then age (Docs/23 principle 10).
// The item is admin.case_get for purpose case:<id> (open cases, unassigned or the caller's; otherwise "being handled
// by …"): the target as the public sees it, the case facts, the AI risk as labelled evidence and the action history.
// "Take this case" assigns it to the caller (admin.case_assign; the button is the reason, D-50). Actions apply to the
// target in its state (targetActions): content actions, the account (warn, suspend, reactivate; suspension and trust
// penalties ask for the security key again, AAL3), a trust penalty for the organization, badges on organization
// cases; every one with a reason through the ReasonDialog. The case is closed with an outcome and a resolution.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { ModerationAction, ModerationCase, ModerationActionInput } from '@carpal/api-contracts';
import {
  ActionNotice,
  AiEvidenceBlock,
  CaseLayout,
  DataTable,
  EntityChip,
  ReasonDialog,
  SlaBadge,
  Timeline,
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
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery, useSession } from '@/lib/api/query';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { BadgePanel } from './badge-panel';
import {
  ACTION_REASON,
  ACTION_TYPES,
  actionTexts,
  bySafetyFirst,
  CASE_QUEUES,
  CASE_RESOLUTION_MAX,
  CASE_SEVERITIES,
  CASE_SOURCES,
  CASE_STATUSES,
  CASE_VIEWS,
  caseDue,
  CLOSE_STATUSES,
  enumLabel,
  inView,
  IRREVERSIBLE,
  isSafetyCase,
  MODERATION_REASONS,
  OPEN_CASE_STATUSES,
  parseTarget,
  penaltyPoints,
  PENALTY_MAX,
  PENALTY_MIN,
  SELF_ASSIGN_REASON,
  STEP_UP_ACTIONS,
  targetActions,
  targetOrganization,
  thingKey,
  type CaseAction,
  type CaseQueueId,
  type CloseStatus,
  type Target,
} from './case-logic';
import { TargetBlock } from './target-view';

export const CASE_PAGE_SIZE = 50;
const LIST_KEY = ['admin.cases_list'] as const;
const SEVERITY_TONE = { low: 'neutral', medium: 'signal', high: 'danger', critical: 'danger' } as const;

const caseStatus = (s: string, t: Translate) => enumLabel(CASE_STATUSES, 'admin.cases.status', s, t);
export const caseReason = (s: string, t: Translate) => enumLabel(MODERATION_REASONS, 'admin.cases.reason', s, t);

export function SeverityBadge({ severity }: { severity: string }) {
  const t = useT();
  const tone = SEVERITY_TONE[severity as keyof typeof SEVERITY_TONE] ?? 'neutral';
  return <Badge tone={tone}>{enumLabel(CASE_SEVERITIES, 'admin.cases.severity', severity, t)}</Badge>;
}

/** What the decision column shows besides the standard panels (reviews: the move to Path 2). */
export interface CaseExtraContext {
  theCase: ModerationCase;
  target: Target | null;
  purpose: AccessPurpose;
  busy: boolean;
  refresh: () => void;
}

export interface CaseWorkspaceProps {
  queue: CaseQueueId;
  /** DataTable settings key, e.g. "content-cases". */
  tableId: string;
  /** Name of the list (table caption and region), e.g. "Review cases". */
  listLabel: string;
  emptyText: string;
  /** Show the views of Docs/23 A-CON-01 (reported, AI flagged, rule, unsafe advice, consent). */
  views?: boolean;
  /** The target as the item panel shows it (default: TargetBlock). */
  renderTarget?: (target: Target, purpose: AccessPurpose) => ReactNode;
  /** A note above the actions (reviews: "a low rating alone is never a reason"). */
  actionsNote?: ReactNode;
  extra?: (ctx: CaseExtraContext) => ReactNode;
  /** The public web app's origin for "Open the public page" links (GD-07). */
  publicWeb?: string;
}

type Dialog = { kind: 'action'; action: CaseAction } | { kind: 'close' };

/** Reads the cases of a queue: one paged type, or every type of the queue at once (one call per type). */
function useCaseList(queue: CaseQueueId, filters: Record<string, string>, cursor: string | undefined) {
  const api = useApiClient();
  const types = CASE_QUEUES[queue];
  const { type, view: _view, ...rest } = filters;
  const single = type || (types.length === 1 ? types[0]! : '');
  const serverQuery = rest as Partial<Pick<ModerationCase, 'status' | 'severity'>>;
  const one = useApiQuery(
    'admin.cases_list',
    { query: { case_type: single as ModerationCase['case_type'], ...serverQuery, limit: CASE_PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
    { refetchInterval: 60_000, enabled: !!single },
  );
  const many = useQuery({
    queryKey: [...LIST_KEY, 'queue', queue, serverQuery],
    enabled: !single,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        types.map((case_type) => api.api('admin.cases_list', { query: { case_type, ...serverQuery, limit: CASE_PAGE_SIZE }, signal })),
      );
      return { items: pages.flatMap((p) => p.items), more: pages.some((p) => !!p.next_cursor) };
    },
  });
  if (single)
    return {
      items: one.data?.items,
      next: one.data?.next_cursor ?? null,
      more: false,
      paged: true,
      pending: one.isPending,
      error: one.error,
      refetch: () => void one.refetch(),
      updatedAt: one.dataUpdatedAt,
    };
  return {
    items: many.data?.items,
    next: null,
    more: many.data?.more ?? false,
    paged: false,
    pending: many.isPending,
    error: many.error as ApiProblem | null,
    refetch: () => void many.refetch(),
    updatedAt: many.dataUpdatedAt,
  };
}

export function CaseWorkspace({
  queue,
  tableId,
  listLabel,
  emptyText,
  views = false,
  renderTarget,
  actionsNote,
  extra,
  publicWeb,
}: CaseWorkspaceProps) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const canAct = canCall('admin.case_action', roles);
  const canAssign = canCall('admin.case_assign', roles);
  const canClose = canCall('admin.case_close', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const types = CASE_QUEUES[queue];

  const filterDefs: FilterDef[] = useMemo(() => {
    const defs: FilterDef[] = [];
    if (types.length > 1)
      defs.push({
        key: 'type',
        label: t('admin.moderation.filter.type'),
        options: types.map((x) => ({ value: x, label: t(thingKey(x)) })),
        defaultValue: '',
        allowAll: true,
      });
    defs.push(
      {
        key: 'status',
        label: t('admin.cases.filter.status'),
        options: CASE_STATUSES.map((s) => ({ value: s, label: caseStatus(s, t) })),
        defaultValue: 'open',
        allowAll: true,
      },
      {
        key: 'severity',
        label: t('admin.cases.filter.severity'),
        options: CASE_SEVERITIES.map((s) => ({ value: s, label: enumLabel(CASE_SEVERITIES, 'admin.cases.severity', s, t) })),
        defaultValue: '',
        allowAll: true,
      },
    );
    if (views)
      defs.push({
        key: 'view',
        label: t('admin.moderation.filter.view'),
        options: CASE_VIEWS.map((v) => ({ value: v, label: t(`admin.moderation.view.${v}`) })),
        defaultValue: '',
        allowAll: true,
      });
    return defs;
  }, [t, types, views]);
  const filters = useUrlFilters(filterDefs);
  const { view = '', ...serverFilters } = filters.query;
  const paging = useCursorPaging(JSON.stringify(serverFilters));
  const list = useCaseList(queue, filters.query, paging.cursor);
  const rows = useMemo(() => (list.items ? bySafetyFirst(list.items.filter((c) => inView(c, view))) : undefined), [list.items, view]);

  const selectedId = params.get('case');
  const row = list.items?.find((c) => c.id === selectedId) ?? null;
  // A case closed here: its purpose ends (no more reads), the answer of admin.case_close is shown instead.
  const [closedCase, setClosedCase] = useState<ModerationCase | null>(null);
  const closedId = closedCase?.id ?? null;
  // Wait for the list: a closed case in it is not read again (its purpose has ended).
  const readable = !!selectedId && closedId !== selectedId && !!list.items && (!row || OPEN_CASE_STATUSES.includes(row.status));
  const purpose = selectedId ? purposeOf('case', selectedId) : null;
  const detail = useApiQuery('admin.case_get', selectedId && purpose ? { path: { case_id: selectedId }, purpose } : undefined, {
    enabled: readable,
  });
  const [assigned, setAssigned] = useState<ModerationCase | null>(null);
  const theCase =
    (closedCase && closedCase.id === selectedId ? closedCase : null) ??
    (assigned && assigned.id === selectedId && readable ? assigned : null) ??
    (readable ? detail.data?.case : null) ??
    row;
  const target = readable ? parseTarget(detail.data?.target_snapshot) : null;
  const isOpen = !!theCase && OPEN_CASE_STATUSES.includes(theCase.status);
  const thing = t(thingKey(target?.type ?? theCase?.case_type ?? 'item'));

  const select = (c: ModerationCase) => {
    const p = new URLSearchParams(params);
    p.set('case', c.id);
    p.set('purpose', purposeOf('case', c.id));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    void queryClient.invalidateQueries({ queryKey: ['admin.case_get'] });
  };
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const caseAction = useAdminAction('admin.case_action', { target: selectedId ?? undefined, onOutcome: refresh });
  const assign = useAdminAction('admin.case_assign', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      if (o.kind === 'applied') setAssigned(o.data);
      refresh();
    },
  });
  const close = useAdminAction('admin.case_close', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      if (o.kind === 'applied') setClosedCase(o.data);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
  const [closeStatus, setCloseStatus] = useState<CloseStatus>('dismissed');
  const [resolution, setResolution] = useState('');
  const [closeTried, setCloseTried] = useState(false);
  const [points, setPoints] = useState('');
  const [pointsTried, setPointsTried] = useState(false);
  const resolutionError =
    closeTried && !resolution.trim()
      ? t('admin.cases.resolutionRequired')
      : resolution.length > CASE_RESOLUTION_MAX
        ? t('admin.cases.resolutionTooLong', { n: f.number(CASE_RESOLUTION_MAX) })
        : undefined;
  const busy = caseAction.state.status === 'busy' || close.state.status === 'busy' || assign.state.status === 'busy';
  const [lastAction, setLastAction] = useState<CaseAction | null>(null);

  const start = (d: Dialog) => {
    if (busy || !theCase) return;
    caseAction.reset();
    close.reset();
    if (d.kind === 'close') {
      setCloseTried(true);
      if (!resolution.trim() || resolution.length > CASE_RESOLUTION_MAX) return;
    }
    if (d.kind === 'action' && d.action === 'apply_trust_penalty') {
      setPointsTried(true);
      if (penaltyPoints(points) === null) return;
    }
    setDialog(d);
  };

  const submit = (reason: string) => {
    if (!theCase || !dialog || !purpose) return;
    const d = dialog;
    setDialog(null);
    if (d.kind === 'close') {
      void close.run({ path: { case_id: theCase.id }, body: { status: closeStatus, resolution: resolution.trim(), reason }, reason });
      return;
    }
    setLastAction(d.action);
    const body: ModerationActionInput = { action_type: d.action, reason };
    if (d.action === 'apply_trust_penalty') body.params = { trust_penalty_points: penaltyPoints(points)! };
    void caseAction.run({ path: { case_id: theCase.id }, purpose, body, reason });
  };

  const takeCase = () => {
    if (!theCase || busy) return;
    assign.reset();
    void assign.run({ path: { case_id: theCase.id }, body: { reason: SELF_ASSIGN_REASON }, reason: SELF_ASSIGN_REASON });
  };

  const now = list.updatedAt;
  const columns: Column<ModerationCase>[] = [
    { id: 'reason', header: t('admin.cases.col.reason'), pinned: true, cell: (c) => caseReason(c.reason, t) },
    ...(types.length > 1
      ? [
          {
            id: 'type',
            header: t('admin.moderation.col.type'),
            cell: (c: ModerationCase) => t(thingKey(c.case_type)),
          } satisfies Column<ModerationCase>,
        ]
      : []),
    { id: 'source', header: t('admin.cases.col.source'), cell: (c) => enumLabel(CASE_SOURCES, 'admin.cases.source', c.source, t) },
    {
      id: 'severity',
      header: t('admin.cases.col.severity'),
      cell: (c) => (
        <>
          <SeverityBadge severity={c.severity} />
          {isSafetyCase(c) ? <span className="sr-only">{t('admin.moderation.safety')}</span> : null}
        </>
      ),
    },
    {
      id: 'risk',
      header: t('admin.cases.col.risk'),
      align: 'end',
      cell: (c) => (c.ai_risk_score == null ? '—' : f.number(c.ai_risk_score)),
    },
    { id: 'reports', header: t('admin.cases.col.reports'), align: 'end', cell: (c) => f.number(c.report_count) },
    {
      id: 'age',
      header: t('admin.cases.col.opened'),
      cell: (c, ctx) => <time dateTime={c.created_at}>{ctx.digits(f.date(c.created_at, 'dateShort'))}</time>,
    },
    {
      id: 'sla',
      header: t('admin.cases.col.sla'),
      cell: (c) => {
        if (!OPEN_CASE_STATUSES.includes(c.status)) return '—';
        const due = caseDue(c, timeZone);
        return (
          <SlaBadge state={slaState(Date.parse(c.created_at), due, now)} text={t('admin.reviews.dueIn', { when: f.relative(due, now) })} />
        );
      },
    },
    {
      id: 'assignee',
      header: t('admin.cases.col.assignee'),
      cell: (c) => (c.assigned_to_display ? <Bidi>{c.assigned_to_display}</Bidi> : '—'),
    },
    { id: 'status', header: t('admin.cases.col.status'), cell: (c) => caseStatus(c.status, t) },
  ];

  const history = (actions: readonly ModerationAction[]) => (
    <section aria-label={t('admin.cases.history')}>
      <h3 className="adm-subtitle">{t('admin.cases.history')}</h3>
      <Timeline
        label={t('admin.cases.history')}
        items={actions.map((a) => ({
          id: a.id,
          at: a.created_at,
          actor: a.actor_display,
          title: enumLabel(ACTION_TYPES, 'admin.moderation.actionType', a.action_type, t),
          detail: <Bidi>{a.reason}</Bidi>,
        }))}
      />
    </section>
  );

  const item = () => {
    if (!selectedId) return <p className="adm-muted">{t('admin.cases.pick')}</p>;
    if (!theCase)
      return detail.isError ? <p>{t('admin.cases.unavailable')}</p> : <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
    return (
      <article className="adm-stack" data-testid="case-item" data-case={theCase.id}>
        <h2 className="adm-panel-title">
          {caseReason(theCase.reason, t)} <SeverityBadge severity={theCase.severity} />
        </h2>
        {isSafetyCase(theCase) && isOpen ? <Banner tone="warn" text={t('admin.moderation.safetyFirst')} /> : null}
        {readable && detail.isError ? (
          <p data-testid="case-unavailable">
            {theCase.assigned_to_display ? t('admin.cases.handledBy', { name: theCase.assigned_to_display }) : t('admin.cases.unavailable')}
          </p>
        ) : null}
        {!readable ? <p className="adm-muted">{t('admin.cases.closedSummary')}</p> : null}
        {target && target.available && purpose ? (
          (renderTarget?.(target, purpose) ?? <TargetBlock target={target} purpose={purpose} publicWeb={publicWeb} />)
        ) : readable && detail.data ? (
          <p data-testid="target-gone">
            {t('admin.moderation.targetGone', { thing })} <EntityChip type={theCase.target.type} id={theCase.target.id} />
          </p>
        ) : null}
        <dl className="adm-facts">
          <div>
            <dt>{t('admin.cases.col.source')}</dt>
            <dd>{enumLabel(CASE_SOURCES, 'admin.cases.source', theCase.source, t)}</dd>
          </div>
          <div>
            <dt>{t('admin.cases.col.reports')}</dt>
            <dd>{f.number(theCase.report_count)}</dd>
          </div>
          <div>
            <dt>{t('admin.cases.col.status')}</dt>
            <dd data-testid="case-status">{caseStatus(theCase.status, t)}</dd>
          </div>
          <div>
            <dt>{t('admin.cases.col.assignee')}</dt>
            <dd data-testid="case-assignee">
              {theCase.assigned_to_display ? <Bidi>{theCase.assigned_to_display}</Bidi> : t('admin.cases.unassigned')}
            </dd>
          </div>
          <div>
            <dt>{t('admin.cases.col.opened')}</dt>
            <dd>{f.date(theCase.created_at, 'dateTime')}</dd>
          </div>
          {theCase.resolution ? (
            <div>
              <dt>{t('admin.cases.resolution')}</dt>
              <dd>
                <Bidi>{theCase.resolution}</Bidi>
              </dd>
            </div>
          ) : null}
        </dl>
        {theCase.ai_risk_score != null ? (
          <AiEvidenceBlock title={t('admin.cases.aiRisk')} riskScore={theCase.ai_risk_score} reasons={[caseReason(theCase.reason, t)]} />
        ) : null}
        {readable && detail.data ? history(detail.data.actions) : null}
      </article>
    );
  };

  const actionButton = (a: CaseAction, variant: 'primary' | 'secondary' | 'danger', disabledWhy?: string) => (
    <Button
      key={a}
      size="sm"
      variant={variant}
      disabled={busy || !!disabledWhy}
      loading={busy && lastAction === a && caseAction.state.status === 'busy'}
      aria-describedby={disabledWhy ? `${uid}-why-${a}` : undefined}
      onClick={() => start({ kind: 'action', action: a })}
    >
      {t(`admin.moderation.do.${a}` as MessageKey, { thing })}
    </Button>
  );

  const decision = () => {
    if (!theCase) return <p className="adm-muted">{t('admin.cases.pickFirst')}</p>;
    if (!canAct && !canClose) return <p>{t('admin.cases.cannotAct')}</p>;
    if (!isOpen)
      return (
        <>
          <p>{t('admin.cases.closed', { status: caseStatus(theCase.status, t) })}</p>
          <ActionNotice state={close.state} applied={t('admin.cases.close.done')} />
        </>
      );
    if (readable && !detail.data)
      return <p className="adm-muted">{detail.isError ? t('admin.cases.cannotActNow') : t('admin.kit.table.loading')}</p>;
    const acts = targetActions(target);
    const org = targetOrganization(target);
    const done = lastAction && target ? t(actionTexts(target.type, lastAction).done, { thing }) : undefined;
    const pointsValue = penaltyPoints(points);
    return (
      <div className="adm-stack">
        {canAssign && purpose ? (
          theCase.assigned_to_display ? (
            <p className="adm-muted" data-testid="assigned-to-you">
              {t('admin.moderation.assign.yours')}
            </p>
          ) : (
            <div className="adm-actions">
              <Button size="sm" variant="secondary" icon="user" disabled={busy} loading={assign.state.status === 'busy'} onClick={takeCase}>
                {t('admin.moderation.assign.take')}
              </Button>
              <span className="adm-muted">{t('admin.moderation.assign.hint')}</span>
            </div>
          )
        ) : null}
        {assign.state.status === 'failed' ? <ActionNotice state={assign.state} /> : null}
        {actionsNote}
        {canAct && acts.content.length ? (
          <div className="adm-actions" data-testid="case-actions">
            {acts.content.map((a) =>
              actionButton(
                a,
                a === 'remove' ? 'danger' : a === 'approve' || a === 'restore' ? 'primary' : 'secondary',
                acts.blocked[a as keyof typeof acts.blocked]
                  ? t(`admin.moderation.blocked.${acts.blocked[a as keyof typeof acts.blocked]!}`)
                  : undefined,
              ),
            )}
          </div>
        ) : null}
        {canAct
          ? Object.entries(acts.blocked).map(([a, why]) => (
              <p key={a} id={`${uid}-why-${a}`} className="adm-muted" data-testid={`blocked-${a}`}>
                {t(`admin.moderation.blocked.${why}`)}
              </p>
            ))
          : null}
        {canAct && (acts.suspend || acts.reactivate) ? (
          <section className="adm-panel" aria-labelledby={`${uid}-acc`} data-testid="account-actions">
            <h3 id={`${uid}-acc`} className="adm-subtitle">
              {t(target?.type === 'user' ? 'admin.moderation.account.titleUser' : 'admin.moderation.account.titleAuthor')}
            </h3>
            <p className="adm-muted">{t('admin.moderation.account.text')}</p>
            <div className="adm-actions">
              {acts.suspend ? actionButton('suspend_account', 'danger') : null}
              {acts.reactivate ? actionButton('reactivate_account', 'primary') : null}
            </div>
          </section>
        ) : null}
        {canAct && acts.penalty ? (
          <section className="adm-panel" aria-labelledby={`${uid}-pen`} data-testid="penalty">
            <h3 id={`${uid}-pen`} className="adm-subtitle">
              {t('admin.moderation.penalty.title')}
            </h3>
            <p className="adm-muted">
              {t('admin.moderation.penalty.text')} {org ? <EntityChip type="organization" id={org} /> : null}
            </p>
            <TextField
              label={t('admin.moderation.penalty.points')}
              hint={t('admin.moderation.penalty.pointsHint', { min: f.number(PENALTY_MIN), max: f.number(PENALTY_MAX) })}
              error={
                pointsTried && pointsValue === null
                  ? t('admin.moderation.penalty.pointsInvalid', { min: f.number(PENALTY_MIN), max: f.number(PENALTY_MAX) })
                  : undefined
              }
              inputMode="numeric"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
            {actionButton('apply_trust_penalty', 'danger')}
          </section>
        ) : null}
        {caseAction.state.status === 'done' || caseAction.state.status === 'failed' ? (
          <ActionNotice state={caseAction.state} applied={done} />
        ) : null}
        {canAct && target?.type === 'organization_location' ? <p className="adm-muted">{t('admin.moderation.locationHint')}</p> : null}
        {acts.badges && purpose ? <BadgePanel caseId={theCase.id} purpose={purpose} onDone={refresh} /> : null}
        {purpose ? extra?.({ theCase, target, purpose, busy, refresh }) : null}
        {canClose ? (
          <section className="adm-panel" aria-labelledby={`${uid}-close`}>
            <h3 id={`${uid}-close`} className="adm-subtitle">
              {t('admin.cases.close.title')}
            </h3>
            <fieldset className="adm-choices adm-choices-row">
              <legend>{t('admin.cases.close.outcome')}</legend>
              {CLOSE_STATUSES.map((s) => (
                <label key={s} className="adm-radio">
                  <input type="radio" name={`${uid}-outcome`} value={s} checked={closeStatus === s} onChange={() => setCloseStatus(s)} />
                  {t(`admin.cases.close.${s}`, { thing })}
                </label>
              ))}
            </fieldset>
            <TextField
              multiline
              rows={3}
              label={t('admin.cases.resolution')}
              hint={t('admin.cases.resolutionHint', { n: f.number(CASE_RESOLUTION_MAX) })}
              error={resolutionError}
              value={resolution}
              maxLength={CASE_RESOLUTION_MAX}
              onChange={(e) => setResolution(e.target.value)}
            />
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => start({ kind: 'close' })}>
              {t('admin.cases.close.button')}
            </Button>
            <ActionNotice state={close.state} applied={t('admin.cases.close.done')} />
          </section>
        ) : null}
      </div>
    );
  };

  const texts = dialog?.kind === 'action' ? actionTexts(target?.type ?? theCase?.case_type ?? '', dialog.action) : null;
  const action = dialog?.kind === 'action' ? dialog.action : null;
  return (
    <>
      <CaseLayout
        labels={{ list: listLabel, item: t('admin.cases.itemLabel'), decision: t('admin.cases.decisionLabel') }}
        list={
          <>
            <DataTable
              id={tableId}
              caption={listLabel}
              columns={columns}
              rows={rows}
              rowKey={(c) => c.id}
              loading={list.pending}
              error={list.error}
              onRetry={list.refetch}
              emptyText={emptyText}
              selectedKey={selectedId}
              onSelect={select}
              filters={filterDefs}
              filterValues={filters.values}
              onFilterChange={filters.setFilter}
              onApplyView={filters.applyView}
              paging={
                list.paged
                  ? {
                      page: paging.page,
                      hasPrev: paging.page > 1,
                      hasNext: !!list.next,
                      onPrev: paging.prev,
                      onNext: () => list.next && paging.next(list.next),
                    }
                  : undefined
              }
            />
            {list.more ? <p className="adm-muted">{t('admin.moderation.morePerType', { n: f.number(CASE_PAGE_SIZE) })}</p> : null}
            {view ? <p className="adm-muted">{t('admin.moderation.viewNote')}</p> : null}
          </>
        }
        item={item()}
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.cases.decisionLabel')}</h2>
            {decision()}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog?.kind === 'close' ? 'case_close' : action ? ACTION_REASON[action] : 'approval'}
        title={dialog?.kind === 'close' ? t('admin.cases.dialog.close') : texts ? t(texts.dialog, { thing }) : ''}
        confirmLabel={
          dialog?.kind === 'close'
            ? t('admin.cases.close.button')
            : action
              ? t(`admin.moderation.do.${action}` as MessageKey, { thing })
              : ''
        }
        confirmVariant={
          action === 'remove' || action === 'hide' || action === 'suspend_account' || action === 'apply_trust_penalty'
            ? 'danger'
            : 'primary'
        }
        irreversible={!!action && IRREVERSIBLE.has(action)}
        summary={
          dialog ? (
            <>
              {texts ? (
                <p className="adm-muted">{t(texts.effect, { thing })}</p>
              ) : (
                <p className="adm-muted">{t('admin.cases.effect.close')}</p>
              )}
              {action === 'apply_trust_penalty' ? (
                <p>{t('admin.moderation.penalty.summary', { n: f.number(penaltyPoints(points) ?? 0) })}</p>
              ) : null}
              {action && STEP_UP_ACTIONS.has(action) ? <p className="adm-muted">{t('admin.moderation.stepUp')}</p> : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="case"
      />
    </>
  );
}
