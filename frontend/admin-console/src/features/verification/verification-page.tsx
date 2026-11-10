'use client';
// Verification (AC9.T4, Docs/23 A-VER-01 queue and A-VER-02 review, Docs/40 admin.verifications_queue and
// admin.verification_decide, Docs/54 §4). The queue lists the organizations' checks by status (pending first view),
// oldest first, with the 2-working-day SLA (Story 11 Ch. 1), the documents count, the pin-versus-address result and
// the wrong-location reports. A check opens for its purpose (verification:<id>, accepted by the backend only while the
// check is pending and not taken by another staff member) in three panels: the submitted data (the organization read
// for that purpose, contact data masked), the document viewer, and the checklist with the decision. Approve needs the
// checklist (its state ends the audited reason, D-60) and — for a location or address check — no pin far from its
// address (corrected on the organization's Locations tab first). Reject needs a reason and the message the business
// reads (rejection_reason). "Request more info" has no operation (DI-30). After a decision the purpose ends; the
// answer stays on screen with the organization's new verification status (organization search, no purpose).
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import type { OrganizationVerification, StaffOrgView } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  MaskedField,
  ReasonDialog,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import { useShortcut } from '@/features/shell';
import { purposeOf } from '@/lib/api/client';
import { useApiQuery, useSession } from '@/lib/api/query';
import { slaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { CHECK_STATUSES, CHECK_TYPES, farLocations, label, ORG_TYPES, orgHref, VERIFICATION_STATUSES } from '../orgs/org-logic';
import { DocumentViewer } from './document-viewer';
import {
  approveBlock,
  checklistFor,
  isLocationCheck,
  oldestFirst,
  rejectionProblem,
  verificationTimer,
  withChecklist,
  type ChecklistItem,
  type QueueItem,
} from './verification-logic';

const PAGE_SIZE = 50;
const LIST_KEY = ['admin.verifications_queue'] as const;
type Decision = 'verified' | 'rejected';

export function VerificationPage() {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const timeZone = session.data?.staff?.timezone ?? 'Asia/Tehran';
  const canDecide = canCall('admin.verification_decide', roles);
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.verification.filter.status'),
        options: CHECK_STATUSES.map((s) => ({ value: s, label: t(`admin.orgs.checkStatus.${s}`) })),
        defaultValue: 'pending',
      },
      {
        key: 'verification_type',
        label: t('admin.verification.filter.type'),
        options: CHECK_TYPES.map((s) => ({ value: s, label: t(`admin.orgs.check.${s}`) })),
        allowAll: true,
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery(
    'admin.verifications_queue',
    { query: { ...filters.query, limit: PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) } },
    { refetchInterval: 60_000 },
  );
  const rows = useMemo(() => (list.data ? oldestFirst(list.data.items) : undefined), [list.data]);
  const selectedId = params.get('verification');
  const fromList = rows?.find((v) => v.id === selectedId) ?? null;

  // A decided check leaves the queue and its purpose ends: keep it and the answer on screen.
  const [decided, setDecided] = useState<{ item: QueueItem; result: OrganizationVerification; org: StaffOrgView | null } | null>(null);
  const decidedHere = decided && decided.item.id === selectedId ? decided : null;
  const item = decidedHere?.item ?? fromList;
  const pending = !!item && item.status === 'pending' && !decidedHere;
  const purpose = selectedId ? purposeOf('verification', selectedId) : null;
  const org = useApiQuery('admin.org_get', item && purpose ? { path: { org_id: item.organization.id }, purpose } : undefined, {
    enabled: pending && !!purpose,
    retry: false,
  });
  const after = useApiQuery(
    'admin.orgs_search',
    { body: { organization_id: decidedHere?.item.organization.id ?? '', limit: 1 } },
    { enabled: !!decidedHere },
  );

  const select = (v: QueueItem) => {
    const p = new URLSearchParams(params);
    p.set('verification', v.id);
    p.set('purpose', purposeOf('verification', v.id));
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  // Checklist and decision.
  const [ticked, setTicked] = useState<ChecklistItem[]>([]);
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  if (tickedFor !== selectedId) {
    setTickedFor(selectedId);
    setTicked([]);
  }
  const [dialog, setDialog] = useState<Decision | null>(null);
  const [message, setMessage] = useState('');
  const [messageTried, setMessageTried] = useState(false);
  const lastRef = useRef<{ item: QueueItem; org: StaffOrgView | null } | null>(null);
  const action = useAdminAction('admin.verification_decide', {
    target: selectedId ?? undefined,
    onOutcome: (o) => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      if (o.kind === 'applied' && lastRef.current) setDecided({ ...lastRef.current, result: o.data });
    },
  });
  const busy = action.state.status === 'busy';
  const farApart = org.data ? farLocations(org.data).length > 0 : item?.location_check?.location_check_status === 'far_apart';
  const block = item
    ? approveBlock({ status: decidedHere ? 'decided' : item.status, type: item.verification_type, farApart, ticked })
    : 'not_pending';
  const open = !!item && canDecide && pending;
  const start = (d: Decision) => {
    if (!open || busy || (d === 'verified' && block)) return;
    action.reset();
    setMessage('');
    setMessageTried(false);
    setDialog(d);
  };
  useShortcut('approve', () => start('verified'), open && !block);
  useShortcut('reject', () => start('rejected'), open);

  const submit = (reason: string) => {
    if (!item || !dialog || !purpose) return;
    if (dialog === 'rejected' && rejectionProblem(message)) {
      setMessageTried(true);
      return;
    }
    const decision = dialog;
    setDialog(null);
    lastRef.current = { item, org: org.data ?? null };
    const sent = withChecklist(reason, ticked);
    void action
      .run({
        path: { verification_id: item.id },
        purpose,
        body: { decision, reason: sent, ...(decision === 'rejected' ? { rejection_reason: message.trim() } : {}) },
        reason: sent,
      })
      .then((r) => {
        if (r.status === 'failed' && r.problem.code === 'INVALID_TRANSITION') void list.refetch();
      });
  };

  const now = list.dataUpdatedAt;
  const columns: Column<QueueItem>[] = [
    { id: 'org', header: t('admin.verification.col.org'), pinned: true, cell: (v) => <Bidi>{v.organization.name}</Bidi> },
    {
      id: 'orgType',
      header: t('admin.verification.col.orgType'),
      cell: (v) => label(ORG_TYPES, 'admin.orgs.type', v.organization.organization_type, t),
    },
    { id: 'type', header: t('admin.verification.col.type'), cell: (v) => label(CHECK_TYPES, 'admin.orgs.check', v.verification_type, t) },
    {
      id: 'submitted',
      header: t('admin.verification.col.submitted'),
      cell: (v, ctx) => <time dateTime={v.created_at}>{ctx.digits(f.date(v.created_at, 'dateShort'))}</time>,
    },
    {
      id: 'sla',
      header: t('admin.verification.col.sla'),
      cell: (v) => {
        if (v.status !== 'pending') return label(CHECK_STATUSES, 'admin.orgs.checkStatus', v.status, t);
        const timer = verificationTimer(v, timeZone);
        return (
          <SlaBadge state={slaState(timer.start, timer.due, now)} text={t('admin.reviews.dueIn', { when: f.relative(timer.due, now) })} />
        );
      },
    },
    { id: 'docs', header: t('admin.verification.col.docs'), align: 'end', cell: (v) => f.number(v.submitted_document_ids.length) },
    {
      id: 'pin',
      header: t('admin.verification.col.pin'),
      cell: (v) =>
        v.location_check
          ? v.location_check.location_check_status === 'far_apart'
            ? t('admin.verification.pinFar')
            : v.location_check.location_check_status === 'consistent'
              ? t('admin.verification.pinOk')
              : t('admin.verification.pinUnchecked')
          : '—',
    },
    { id: 'reports', header: t('admin.verification.col.reports'), align: 'end', cell: (v) => f.number(v.wrong_location_reports) },
  ];

  const itemPanel = () => {
    if (!item) {
      if (selectedId && list.isPending) return <p className="adm-muted">{t('admin.kit.table.loading')}</p>;
      return <p className="adm-muted">{t('admin.verification.pick')}</p>;
    }
    return (
      <article className="adm-ver" data-testid="verification-item" data-verification={item.id}>
        <h2 className="adm-panel-title">
          {t('admin.verification.itemTitle', {
            type: label(CHECK_TYPES, 'admin.orgs.check', item.verification_type, t),
            name: item.organization.name,
          })}
        </h2>
        <div className="adm-ver-panels">
          <section aria-labelledby="ver-data-t" className="adm-stack">
            <h3 id="ver-data-t" className="adm-subtitle">
              {t('admin.verification.data')}
            </h3>
            <SubmittedData
              item={item}
              org={org.data ?? decidedHere?.org ?? null}
              unavailable={pending && org.isError}
              reload={pending ? async () => (await org.refetch()).data ?? null : undefined}
            />
          </section>
          <section aria-labelledby="ver-docs-t" className="adm-stack">
            <h3 id="ver-docs-t" className="adm-subtitle">
              {t('admin.verification.docs.title')}
            </h3>
            {pending && purpose ? (
              <DocumentViewer ids={item.submitted_document_ids} purpose={purpose} />
            ) : (
              <p className="adm-muted">{t('admin.verification.docs.closed')}</p>
            )}
          </section>
        </div>
      </article>
    );
  };

  const decisionPanel = () => {
    if (!item) return <p className="adm-muted">{t('admin.verification.pickFirst')}</p>;
    if (decidedHere) {
      const orgNow = after.data?.items[0] ?? null;
      return (
        <div data-testid="decision-done" className="adm-stack">
          <p>{t(`admin.verification.done.${decidedHere.result.status === 'verified' ? 'verified' : 'rejected'}`)}</p>
          <p data-testid="org-verification-now">
            {orgNow
              ? t('admin.verification.orgNow', {
                  status: label(VERIFICATION_STATUSES, 'admin.orgs.verification', orgNow.verification_status, t),
                })
              : t('admin.kit.table.loading')}
          </p>
          {orgNow?.verification_status === 'verified' ? <p className="adm-muted">{t('admin.verification.badgeNext')}</p> : null}
          <p>
            <Link href={orgHref(item.organization.id, null, 'verification')}>{t('admin.verification.openOrg')}</Link>
          </p>
        </div>
      );
    }
    if (item.status !== 'pending')
      return <p>{t('admin.verification.alreadyDecided', { status: label(CHECK_STATUSES, 'admin.orgs.checkStatus', item.status, t) })}</p>;
    if (!canDecide) return <p data-testid="cannot-decide">{t('admin.verification.cannotDecide')}</p>;
    const items = checklistFor(item.verification_type);
    return (
      <div className="adm-stack">
        <fieldset className="adm-checklist" data-testid="checklist">
          <legend>{t('admin.verification.checklist')}</legend>
          {items.map((c) => (
            <Check
              key={c}
              checked={ticked.includes(c)}
              onChange={(e) => setTicked((xs) => (e.target.checked ? [...xs, c] : xs.filter((x) => x !== c)))}
            >
              {t(`admin.verification.check.${c}`)}
            </Check>
          ))}
        </fieldset>
        {isLocationCheck(item.verification_type) && farApart ? (
          <Banner tone="warn" icon="pin" title={t('admin.verification.far.title')}>
            <p className="pwa-banner-text">{t('admin.verification.far.text')}</p>
            {purpose ? (
              <p className="pwa-banner-text">
                <Link href={orgHref(item.organization.id, purpose, 'locations')}>{t('admin.verification.far.link')}</Link>
              </p>
            ) : null}
          </Banner>
        ) : null}
        <div className="adm-actions">
          <Button
            variant="primary"
            icon="check"
            aria-keyshortcuts="A"
            disabled={!!block || busy}
            aria-describedby={block ? 'approve-block' : undefined}
            onClick={() => start('verified')}
          >
            {t('admin.verification.approve')}
          </Button>
          <Button variant="danger" icon="close" aria-keyshortcuts="R" disabled={busy} onClick={() => start('rejected')}>
            {t('admin.verification.reject')}
          </Button>
        </div>
        {block ? (
          <p id="approve-block" className="adm-muted" data-testid="approve-block">
            {t(`admin.verification.block.${block}`)}
          </p>
        ) : null}
        <p className="adm-muted">{t('admin.verification.noMoreInfo')}</p>
      </div>
    );
  };

  const messageProblem = rejectionProblem(message);
  return (
    <div className="adm-page" data-testid="verification-page">
      <h1 className="adm-page-title">{t('admin.verification.title')}</h1>
      <p className="adm-measure">{t('admin.verification.intro')}</p>
      <CaseLayout
        labels={{
          list: t('admin.verification.listLabel'),
          item: t('admin.verification.itemLabel'),
          decision: t('admin.verification.decisionLabel'),
        }}
        list={
          <DataTable
            id="verifications"
            caption={t('admin.verification.listLabel')}
            columns={columns}
            rows={rows}
            rowKey={(v) => v.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.verification.empty')}
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
        item={itemPanel()}
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.verification.decisionLabel')}</h2>
            {decisionPanel()}
            {action.state.status === 'failed' ? <ActionNotice state={action.state} /> : null}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={dialog === 'rejected' ? 'verification_reject' : 'verification_approve'}
        title={dialog ? t(`admin.verification.dialog.${dialog}.title`) : ''}
        confirmLabel={dialog ? t(`admin.verification.dialog.${dialog}.button`) : ''}
        confirmVariant={dialog === 'rejected' ? 'danger' : 'primary'}
        summary={
          item && dialog ? (
            <>
              <p>
                <Bidi>{item.organization.name}</Bidi> · {label(CHECK_TYPES, 'admin.orgs.check', item.verification_type, t)}
              </p>
              <p className="adm-muted">{t(`admin.verification.dialog.${dialog}.effect`)}</p>
              <p className="adm-muted">
                {t('admin.verification.dialog.checklist', { n: ticked.length, total: checklistFor(item.verification_type).length })}
              </p>
              {dialog === 'rejected' ? (
                <TextField
                  multiline
                  rows={3}
                  label={t('admin.verification.message')}
                  hint={t('admin.verification.messageHint')}
                  error={messageTried && messageProblem ? t(`admin.verification.messageProblem.${messageProblem}`) : undefined}
                  value={message}
                  maxLength={500}
                  required
                  onChange={(e) => setMessage(e.target.value)}
                />
              ) : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="verification-decision"
      />
    </div>
  );
}

function SubmittedData({
  item,
  org,
  unavailable,
  reload,
}: {
  item: QueueItem;
  org: StaffOrgView | null;
  unavailable: boolean;
  /** The purpose-bound re-read for Reveal (none once the check is decided). */
  reload?: () => Promise<StaffOrgView | null>;
}) {
  const t = useT();
  const f = useFormat();
  const check = item.location_check;
  const primary = org ? (org.locations.find((l) => l.id === org.primary_location_id) ?? org.locations[0] ?? null) : null;
  return (
    <>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.orgs.profile.name')}</dt>
          <dd>
            <Bidi>{item.organization.name}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.orgs.col.type')}</dt>
          <dd>{label(ORG_TYPES, 'admin.orgs.type', item.organization.organization_type, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.orgs.col.verification')}</dt>
          <dd>{label(VERIFICATION_STATUSES, 'admin.orgs.verification', item.organization.verification_status, t)}</dd>
        </div>
        {org ? (
          <>
            <div>
              <dt>{t('admin.orgs.profile.legalName')}</dt>
              <dd>{org.legal_name ? <Bidi>{org.legal_name}</Bidi> : '—'}</dd>
            </div>
            <MaskedField
              label={t('admin.orgs.profile.email')}
              kind="email"
              value={org.contact_email}
              onReveal={reload ? async () => (await reload())?.contact_email ?? null : undefined}
            />
            <MaskedField
              label={t('admin.orgs.profile.phone')}
              kind="phone"
              value={org.contact_phone}
              onReveal={reload ? async () => (await reload())?.contact_phone ?? null : undefined}
            />
            <div>
              <dt>{t('admin.orgs.locations.address')}</dt>
              <dd>
                {primary ? (
                  <Bidi>
                    {[primary.address_line_1, primary.address_line_2, primary.city, primary.postal_code].filter(Boolean).join('، ')}
                  </Bidi>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </>
        ) : null}
        {check ? (
          <div>
            <dt>{t('admin.orgs.locations.distance')}</dt>
            <dd data-testid="ver-distance">
              {check.distance_m == null
                ? t('admin.orgs.locations.noDistance')
                : t('admin.orgs.locations.distanceText', { d: f.distance(check.distance_m), m: check.threshold_m })}{' '}
              <span className="adm-chip" data-tone={check.location_check_status === 'far_apart' ? 'danger' : 'neutral'}>
                {check.location_check_status === 'far_apart'
                  ? t('admin.verification.pinFar')
                  : check.location_check_status === 'consistent'
                    ? t('admin.verification.pinOk')
                    : t('admin.verification.pinUnchecked')}
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('admin.verification.col.reports')}</dt>
          <dd>{f.number(item.wrong_location_reports)}</dd>
        </div>
      </dl>
      {unavailable ? (
        <p className="adm-muted" data-testid="ver-org-unavailable">
          {t('admin.verification.orgUnavailable')}
        </p>
      ) : null}
      <p className="adm-muted">{t('admin.verification.notInContract')}</p>
      {org ? (
        <p>
          <Link href={orgHref(org.id, purposeOf('verification', item.id), 'locations')}>{t('admin.verification.openLocations')}</Link>
        </p>
      ) : null}
    </>
  );
}
