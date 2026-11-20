'use client';
// Support inbox (AC14.T5, Docs/23 A-SUP-01, Docs/40 §23.5, backend S24, S25a; support staff and platform admins). The
// list (views Open / Waiting on the user / Solved / All, topic, "assigned to me") shows the team's clock (first
// response within 1 working day, stopped while waiting on the user) and never the message text. A ticket opens for its
// own purpose (ticket:<id>, SEC-ADM-5): the conversation (staff messages reach the requester as "CarPal"), the
// diagnostics the app attached, what it was turned into, and the internal resolution note. Actions, each with a reason:
// Assign (to oneself or a colleague with a support or admin role), Reply from a template in English or Persian that
// staff may edit (the ticket then waits on the user, or stays with the team), Turn into a moderation case, a privacy
// request, a dispute or a plan request (the requester's words carried along), and Close with an outcome. A ticket that
// waited 7 days on the user is closed by the system ("No response", no staff name, S25a). The requester's contact data
// opens on the user page for this ticket. Attachments (NP-08) and handing a bug to engineering (NP-12) are not offered.
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { StaffSupportTicket, StaffSupportTicketDetail, SupportOutcome, SupportReplyTemplate } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  problemText,
  ReasonDialog,
  SlaBadge,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  withPurpose,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { purposeOf } from '@/lib/api/client';
import { apiQueryKey, useApiQuery, useSession } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { SUPPORT_REPLIES, type ReplyLocale } from '@/lib/config/support-replies';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { CASE_SEVERITIES, enumLabel, MODERATION_REASONS } from '@/features/moderation';
import {
  CASE_TARGETS,
  CLOSE_OUTCOMES,
  CONVERSIONS,
  conversionOf,
  DISPUTE_TARGETS,
  DISPUTE_TYPES,
  EMPTY_CONVERSION,
  LINKED_OPS,
  linkedHref,
  OUTCOMES,
  PLAN_KEYS,
  REPLY_TEMPLATES,
  REQUEST_TYPES,
  SEVERITY_FLOOR_REASONS,
  statusesOf,
  STATUSES,
  ticketSla,
  TOPICS,
  VIEWS,
  type ConversionDraft,
  type ConversionProblem,
  type View,
} from './support-logic';

const PAGE_SIZE = 50;
const LIST_KEY = ['admin.support_tickets_list'] as const;
const GET_KEY = ['admin.support_ticket_get'] as const;

const label = (list: readonly string[], prefix: string, v: string | null | undefined, t: Translate) => enumLabel(list, prefix, v, t);
export const topicLabel = (v: string, t: Translate) => label(TOPICS, 'admin.support.topic', v, t);
export const statusLabel = (v: string, t: Translate) => label(STATUSES, 'admin.support.status', v, t);
const outcomeLabel = (v: string | null, t: Translate) => label(OUTCOMES, 'admin.support.outcome', v, t);
const statusTone = (s: string) => (s === 'new' ? 'signal' : s === 'waiting_on_team' ? 'accent' : s === 'solved' ? 'success' : 'neutral');

export function SupportPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'view',
        label: t('admin.support.filter.view'),
        defaultValue: 'open',
        options: VIEWS.map((v) => ({ value: v, label: t(`admin.support.view.${v}`) })),
      },
      {
        key: 'topic',
        label: t('admin.support.filter.topic'),
        allowAll: true,
        options: TOPICS.map((v) => ({ value: v, label: topicLabel(v, t) })),
      },
      {
        key: 'mine',
        label: t('admin.support.filter.mine'),
        allowAll: true,
        options: [{ value: 'true', label: t('admin.support.filter.mineOnly') }],
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const statuses = statusesOf((filters.values.view || 'open') as View);
  const query = {
    limit: PAGE_SIZE,
    ...(statuses.length ? { status: statuses } : {}),
    ...(filters.values.topic ? { topic: filters.values.topic as StaffSupportTicket['topic'] } : {}),
    ...(filters.values.mine ? { assigned_to_me: true } : {}),
  };
  const paging = useCursorPaging(JSON.stringify(query));
  const list = useApiQuery(
    'admin.support_tickets_list',
    { query: { ...query, ...(paging.cursor ? { cursor: paging.cursor } : {}) } },
    { refetchInterval: 60_000 },
  );
  const items = list.data?.items;
  const selectedId = params.get('ticket');
  // A solved ticket is closed to staff reads (the ticket:<id> purpose opens only while it is open): its row is enough.
  const solvedRow = items?.find((x) => x.id === selectedId && x.status === 'solved') ?? null;
  const select = (x: StaffSupportTicket) => {
    const q = new URLSearchParams(params);
    q.set('ticket', x.id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const columns: Column<StaffSupportTicket>[] = [
    { id: 'subject', header: t('admin.support.col.subject'), pinned: true, cell: (x) => <Bidi>{x.subject}</Bidi> },
    { id: 'topic', header: t('admin.support.col.topic'), cell: (x) => topicLabel(x.topic, t) },
    {
      id: 'requester',
      header: t('admin.support.col.requester'),
      cell: (x) => (
        <>
          <Bidi>{x.requester.display}</Bidi>
          {x.organization ? (
            <span className="adm-muted">
              {' · '}
              <Bidi>{x.organization.name}</Bidi>
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: 'status',
      header: t('admin.support.col.status'),
      cell: (x) => <Badge tone={statusTone(x.status)}>{statusLabel(x.status, t)}</Badge>,
    },
    {
      id: 'clock',
      header: t('admin.support.col.clock'),
      cell: (x) => {
        const sla = ticketSla(x, f.timeZone);
        return sla ? (
          <SlaBadge state={sla.state} text={t('admin.support.dueBy', { at: f.date(new Date(sla.due).toISOString(), 'dateTime') })} />
        ) : (
          '—'
        );
      },
    },
    {
      id: 'assignee',
      header: t('admin.support.col.assignee'),
      cell: (x) => (x.assignee ? <Bidi>{x.assignee.display}</Bidi> : t('admin.support.unassigned')),
    },
    { id: 'last', header: t('admin.support.col.last'), cell: (x) => f.date(x.last_message_at, 'dateTime') },
  ];

  return (
    <div className="adm-page" data-testid="support-page">
      <h1 className="adm-page-title">{t('admin.support.title')}</h1>
      <p className="adm-measure">{t('admin.support.intro')}</p>
      <CaseLayout
        labels={{ list: t('admin.support.listLabel'), item: t('admin.support.itemLabel'), decision: t('admin.support.actionsLabel') }}
        list={
          <DataTable
            id="support"
            caption={t('admin.support.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(x) => x.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.support.empty')}
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
          selectedId && !items && list.isPending ? (
            <p role="status">{t('admin.work.loading')}</p>
          ) : solvedRow ? (
            <SolvedTicket key={solvedRow.id} row={solvedRow} />
          ) : selectedId ? (
            <TicketView key={selectedId} ticketId={selectedId} />
          ) : (
            <p className="adm-muted">{t('admin.support.pick')}</p>
          )
        }
        decision={
          selectedId && items && !solvedRow ? (
            <TicketActions key={selectedId} ticketId={selectedId} />
          ) : (
            <p className="adm-muted">{t('admin.support.pickFirst')}</p>
          )
        }
      />
    </div>
  );
}

function useTicket(ticketId: string) {
  const purpose = purposeOf('ticket', ticketId);
  // Not read again on focus: once solved here, the purpose is closed and a new read would be refused.
  const q = useApiQuery(
    'admin.support_ticket_get',
    { path: { ticket_id: ticketId }, purpose },
    { retry: false, refetchOnWindowFocus: false },
  );
  return { q, purpose };
}

/** A solved ticket from its list row (no read: the purpose is closed), with its outcome. */
function SolvedTicket({ row }: { row: StaffSupportTicket }) {
  const t = useT();
  const f = useFormat();
  return (
    <article data-testid="support-ticket" data-ticket={row.id} data-status={row.status}>
      <h2 className="adm-panel-title">
        <Bidi>{row.subject}</Bidi>
      </h2>
      <dl className="adm-facts">
        <dt>{t('admin.support.col.requester')}</dt>
        <dd>
          <Bidi>{row.requester.display}</Bidi>
        </dd>
        <dt>{t('admin.support.col.outcome')}</dt>
        <dd data-testid="support-outcome">
          {outcomeLabel(row.outcome, t)}
          {row.solved_at ? ` · ${f.date(row.solved_at, 'dateTime')}` : ''}
          {row.outcome === 'no_response' ? ` · ${t('admin.support.bySystem')}` : ''}
        </dd>
      </dl>
      {row.linked_items.length ? <LinkedItems items={row.linked_items} /> : null}
      <p className="adm-muted" data-testid="support-solved-note">
        {t('admin.support.solvedNote')}
      </p>
    </article>
  );
}

function TicketView({ ticketId }: { ticketId: string }) {
  const t = useT();
  const f = useFormat();
  const { q, purpose } = useTicket(ticketId);
  if (q.isPending) return <p role="status">{t('admin.work.loading')}</p>;
  if (q.error && (q.error.status === 404 || q.error.purposeMismatch))
    return (
      <p data-testid="support-not-open" className="adm-measure">
        {t('admin.support.notOpen')}
      </p>
    );
  if (q.error || !q.data)
    return (
      <div className="adm-table-error">
        <Banner tone="danger" text={q.error ? problemText(q.error, t) : t('admin.kit.problem.other')} />
        <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  const x = q.data;
  const sla = ticketSla(x, f.timeZone);
  return (
    <article data-testid="support-ticket" data-ticket={x.id} data-status={x.status}>
      <h2 className="adm-panel-title">
        <Bidi>{x.subject}</Bidi>
      </h2>
      <p>
        <Badge tone={statusTone(x.status)}>{statusLabel(x.status, t)}</Badge>{' '}
        {sla ? (
          <SlaBadge state={sla.state} text={t('admin.support.dueBy', { at: f.date(new Date(sla.due).toISOString(), 'dateTime') })} />
        ) : null}
      </p>
      <dl className="adm-facts">
        <dt>{t('admin.support.col.topic')}</dt>
        <dd>
          {topicLabel(x.topic, t)}
          {x.app_area ? (
            <>
              {' · '}
              <Bidi ltr>{x.app_area}</Bidi>
            </>
          ) : null}
        </dd>
        <dt>{t('admin.support.col.requester')}</dt>
        <dd>
          <Link href={withPurpose(`/users/${x.requester.user_id}`, purpose)}>
            <Bidi>{x.requester.display}</Bidi>
          </Link>
          <span className="adm-muted"> {t('admin.support.contactHint')}</span>
        </dd>
        {x.organization ? (
          <>
            <dt>{t('admin.support.organization')}</dt>
            <dd>
              <Link href={withPurpose(`/orgs/${x.organization.id}`, purpose)}>
                <Bidi>{x.organization.name}</Bidi>
              </Link>
            </dd>
          </>
        ) : null}
        <dt>{t('admin.support.col.assignee')}</dt>
        <dd>{x.assignee ? <Bidi>{x.assignee.display}</Bidi> : t('admin.support.unassigned')}</dd>
        <dt>{t('admin.support.opened')}</dt>
        <dd>
          {f.date(x.created_at, 'dateTime')}
          {x.first_response_at ? ` · ${t('admin.support.firstResponse', { at: f.date(x.first_response_at, 'dateTime') })}` : ''}
        </dd>
        {x.status === 'solved' ? (
          <>
            <dt>{t('admin.support.col.outcome')}</dt>
            <dd data-testid="support-outcome">
              {outcomeLabel(x.outcome, t)}
              {x.solved_at ? ` · ${f.date(x.solved_at, 'dateTime')}` : ''}
              {x.outcome === 'no_response' ? ` · ${t('admin.support.bySystem')}` : ''}
            </dd>
          </>
        ) : null}
        {x.diagnostics ? (
          <>
            <dt>{t('admin.support.diagnostics')}</dt>
            <dd>
              <Bidi ltr>
                {[x.diagnostics.platform, x.diagnostics.app_version, x.diagnostics.os_version, x.diagnostics.screen]
                  .filter(Boolean)
                  .join(' · ')}
              </Bidi>
            </dd>
          </>
        ) : null}
      </dl>
      {x.linked_items.length ? <LinkedItems items={x.linked_items} /> : null}
      {x.resolution_note ? (
        <section className="adm-panel" aria-label={t('admin.support.resolutionNote')}>
          <h3 className="adm-section-title">{t('admin.support.resolutionNote')}</h3>
          <p>
            <Bidi>{x.resolution_note}</Bidi>
          </p>
        </section>
      ) : null}
      <Thread ticket={x} />
    </article>
  );
}

function LinkedItems({ items }: { items: StaffSupportTicketDetail['linked_items'] }) {
  const t = useT();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  return (
    <section aria-label={t('admin.support.linked')} data-testid="support-linked">
      <h3 className="adm-section-title">{t('admin.support.linked')}</h3>
      <ul className="adm-stack">
        {items.map((i) => {
          const op = LINKED_OPS[i.type as keyof typeof LINKED_OPS];
          const href = op && canCall(op, roles) ? linkedHref(i) : null;
          const text = `${label(Object.keys(LINKED_OPS), 'admin.support.linkedType', i.type, t)} ${i.id.slice(0, 8)}`;
          return <li key={`${i.type}-${i.id}`}>{href ? <Link href={href}>{text}</Link> : text}</li>;
        })}
      </ul>
    </section>
  );
}

function Thread({ ticket }: { ticket: StaffSupportTicketDetail }) {
  const t = useT();
  const f = useFormat();
  return (
    <section aria-label={t('admin.support.thread')} data-testid="support-thread">
      <h3 className="adm-section-title">{t('admin.support.thread')}</h3>
      <ol className="adm-thread">
        {ticket.items.map((m) => (
          <li key={m.id} className="adm-thread-item" data-author={m.author}>
            <p className="adm-muted">
              {m.author === 'staff'
                ? t('admin.support.staffMessage', { name: m.staff_author_display ?? '—' })
                : t('admin.support.requesterMessage', { name: m.author_display })}
              {' · '}
              {f.date(m.created_at, 'dateTime')}
              {m.template_key ? ` · ${label(REPLY_TEMPLATES, 'admin.support.template', m.template_key, t)}` : ''}
            </p>
            <p className="adm-thread-body">
              <Bidi>{m.body}</Bidi>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Dialog = { kind: 'assign'; to: string | null } | { kind: 'reply' } | { kind: 'convert' } | { kind: 'close' };

function TicketActions({ ticketId }: { ticketId: string }) {
  const t = useT();
  const locale = useLocale();
  const uid = useId();
  const queryClient = useQueryClient();
  const session = useSession();
  const myId = session.data?.staff?.id;
  const { q, purpose } = useTicket(ticketId);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    void queryClient.invalidateQueries({ queryKey: GET_KEY });
  };
  const assign = useAdminAction('admin.support_ticket_assign', { target: ticketId, onOutcome: refresh });
  const reply = useAdminAction('admin.support_ticket_reply', { target: ticketId, onOutcome: refresh });
  const convert = useAdminAction('admin.support_ticket_convert', { target: ticketId, onOutcome: refresh });
  // After Close the purpose is closed: the solved ticket stays from the answer instead of a new (refused) read.
  const close = useAdminAction('admin.support_ticket_close', {
    target: ticketId,
    onOutcome: (o) => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      if (o.kind === 'applied' && o.data)
        queryClient.setQueryData(
          apiQueryKey('admin.support_ticket_get', { path: { ticket_id: ticketId }, purpose }),
          (old: StaffSupportTicketDetail | undefined) => (old ? { ...old, ...o.data } : old),
        );
    },
  });
  const actions = [assign, reply, convert, close];
  const busy = actions.some((a) => a.state.status === 'busy');
  const staff = useApiQuery('admin.staff_list', { query: { status: 'active', limit: 100 } }, { staleTime: 5 * 60_000 });
  const colleagues = (staff.data?.items ?? []).filter(
    (s) => s.user_id !== myId && s.platform_roles.some((r) => r === 'platform_support' || r === 'platform_admin'),
  );
  const [assignee, setAssignee] = useState('');
  const [template, setTemplate] = useState<SupportReplyTemplate>('acknowledgement');
  const [replyLang, setReplyLang] = useState<ReplyLocale>(locale === 'fa' ? 'fa' : 'en');
  const [body, setBody] = useState(() => SUPPORT_REPLIES.acknowledgement[locale === 'fa' ? 'fa' : 'en']);
  const [waitOnTeam, setWaitOnTeam] = useState(false);
  const [replyTried, setReplyTried] = useState(false);
  const [conv, setConv] = useState<ConversionDraft>(EMPTY_CONVERSION);
  const [convTried, setConvTried] = useState(false);
  const [outcome, setOutcome] = useState<SupportOutcome>('answered');
  const [note, setNote] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  if (q.isPending || !q.data) return q.error ? null : <p role="status">{t('admin.work.loading')}</p>;
  const x = q.data;
  const solved = x.status === 'solved';
  const fill = (tpl: SupportReplyTemplate, lang: ReplyLocale) => setBody(SUPPORT_REPLIES[tpl][lang]);
  const open = (d: Dialog) => {
    for (const a of actions) a.reset();
    setDialog(d);
  };
  const conversion = conversionOf(conv, !!x.organization);
  const convProblems = 'problems' in conversion ? conversion.problems : [];
  const cErr = (p: ConversionProblem) => (convTried && convProblems.includes(p) ? t(`admin.support.convert.problem.${p}`) : undefined);
  const setC = (patch: Partial<ConversionDraft>) => setConv((c) => ({ ...c, ...patch }));
  const canClose = outcome !== 'converted' || x.linked_items.length > 0;
  const noteTooLong = note.length > 2000;

  const submit = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    const path = { ticket_id: ticketId };
    if (d.kind === 'assign') void assign.run({ path, body: { ...(d.to ? { assignee_user_id: d.to } : {}), reason }, reason });
    else if (d.kind === 'reply')
      void reply.run({
        path,
        body: { template_key: template, body: body.trim(), ...(waitOnTeam ? { status: 'waiting_on_team' } : {}), reason },
        reason,
        purpose,
      });
    else if (d.kind === 'convert' && 'value' in conversion)
      void convert.run({ path, body: { ...conversion.value, reason }, reason, purpose });
    else if (d.kind === 'close')
      void close.run({ path, body: { outcome, ...(note.trim() ? { resolution_note: note.trim() } : {}), reason }, reason, purpose });
  };

  return (
    <div data-testid="support-actions">
      <section aria-labelledby={`${uid}-assign`} className="adm-panel">
        <h2 id={`${uid}-assign`} className="adm-panel-title">
          {t('admin.support.assign.title')}
        </h2>
        {solved ? (
          <p className="adm-muted">{t('admin.support.assign.solved')}</p>
        ) : (
          <div className="adm-actions">
            {x.assignee?.user_id !== myId ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => open({ kind: 'assign', to: null })}>
                {t('admin.support.assign.me')}
              </Button>
            ) : null}
            {colleagues.length ? (
              <>
                <div className="cp-field">
                  <label className="cp-field-label" htmlFor={`${uid}-colleague`}>
                    {t('admin.support.assign.colleague')}
                  </label>
                  <div className="cp-field-box">
                    <select
                      id={`${uid}-colleague`}
                      className="cp-field-input adm-select"
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                    >
                      <option value="">{t('admin.support.assign.choose')}</option>
                      {colleagues.map((c) => (
                        <option key={c.user_id} value={c.user_id}>
                          {c.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Button size="sm" variant="secondary" disabled={busy || !assignee} onClick={() => open({ kind: 'assign', to: assignee })}>
                  {t('admin.support.assign.give')}
                </Button>
              </>
            ) : null}
          </div>
        )}
        <ActionNotice state={assign.state} applied={t('admin.support.assign.done')} />
      </section>

      <section aria-labelledby={`${uid}-reply`} className="adm-panel" data-testid="support-reply">
        <h2 id={`${uid}-reply`} className="adm-panel-title">
          {t('admin.support.reply.title')}
        </h2>
        {x.status === 'solved' ? <p className="adm-muted">{t('admin.support.reply.solved')}</p> : null}
        <form
          className="adm-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setReplyTried(true);
            if (!body.trim() || body.length > 4000) return;
            open({ kind: 'reply' });
          }}
        >
          <div className="cp-field">
            <label className="cp-field-label" htmlFor={`${uid}-tpl`}>
              {t('admin.support.reply.template')}
            </label>
            <div className="cp-field-box">
              <select
                id={`${uid}-tpl`}
                className="cp-field-input adm-select"
                value={template}
                onChange={(e) => {
                  const v = e.target.value as SupportReplyTemplate;
                  setTemplate(v);
                  fill(v, replyLang);
                }}
              >
                {REPLY_TEMPLATES.map((k) => (
                  <option key={k} value={k}>
                    {label(REPLY_TEMPLATES, 'admin.support.template', k, t)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className="adm-choices adm-choices-row">
            <legend>{t('admin.support.reply.language')}</legend>
            {(['en', 'fa'] as const).map((l) => (
              <label key={l} className="adm-radio">
                <input
                  type="radio"
                  name={`${uid}-lang`}
                  value={l}
                  checked={replyLang === l}
                  onChange={() => {
                    setReplyLang(l);
                    fill(template, l);
                  }}
                />
                {t(`admin.policies.locale.${l}`)}
              </label>
            ))}
          </fieldset>
          <TextField
            multiline
            rows={6}
            label={t('admin.support.reply.body')}
            hint={t('admin.support.reply.bodyHint')}
            error={replyTried && (!body.trim() || body.length > 4000) ? t('admin.support.reply.bodyRequired') : undefined}
            value={body}
            dir={replyLang === 'fa' ? 'rtl' : 'ltr'}
            lang={replyLang}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
          />
          <label className="adm-radio">
            <input type="checkbox" checked={waitOnTeam} onChange={(e) => setWaitOnTeam(e.target.checked)} />
            {t('admin.support.reply.keepWithTeam')}
          </label>
          <div className="adm-actions">
            <Button type="submit" variant="primary" loading={reply.state.status === 'busy'} disabled={busy}>
              {t('admin.support.reply.send')}
            </Button>
          </div>
        </form>
        <ActionNotice state={reply.state} applied={t('admin.support.reply.sent')} />
      </section>

      {!solved ? (
        <section aria-labelledby={`${uid}-convert`} className="adm-panel" data-testid="support-convert">
          <h2 id={`${uid}-convert`} className="adm-panel-title">
            {t('admin.support.convert.title')}
          </h2>
          <form
            className="adm-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setConvTried(true);
              if ('value' in conversion) open({ kind: 'convert' });
            }}
          >
            <Select
              id={`${uid}-into`}
              label={t('admin.support.convert.into')}
              value={conv.into}
              options={CONVERSIONS.map((k) => ({ value: k, label: t(`admin.support.convert.kind.${k}`) }))}
              error={cErr('into')}
              onChange={(v) => setC({ into: v as ConversionDraft['into'] })}
            />
            {conv.into === 'moderation_case' ? (
              <>
                <Select
                  id={`${uid}-ct`}
                  label={t('admin.support.convert.targetType')}
                  value={conv.caseTargetType}
                  options={CASE_TARGETS.map((k) => ({ value: k, label: label(CASE_TARGETS, 'admin.support.target', k, t) }))}
                  onChange={(v) => setC({ caseTargetType: v as ConversionDraft['caseTargetType'] })}
                />
                <TextField
                  label={t('admin.support.convert.targetId')}
                  hint={t('admin.support.convert.idHint')}
                  error={cErr('target')}
                  value={conv.caseTargetId}
                  dir="ltr"
                  autoComplete="off"
                  onChange={(e) => setC({ caseTargetId: e.target.value })}
                />
                <Select
                  id={`${uid}-mr`}
                  label={t('admin.support.convert.reason')}
                  value={conv.reason}
                  options={MODERATION_REASONS.map((k) => ({ value: k, label: t(`admin.cases.reason.${k}` as MessageKey) }))}
                  error={cErr('reason')}
                  onChange={(v) => setC({ reason: v as ConversionDraft['reason'] })}
                />
                <Select
                  id={`${uid}-sev`}
                  label={t('admin.support.convert.severity')}
                  value={conv.severity}
                  required
                  options={CASE_SEVERITIES.map((k) => ({ value: k, label: t(`admin.cases.severity.${k}` as MessageKey) }))}
                  onChange={(v) => setC({ severity: v as ConversionDraft['severity'] })}
                />
                {SEVERITY_FLOOR_REASONS.has(conv.reason) ? <p className="adm-muted">{t('admin.support.convert.floor')}</p> : null}
              </>
            ) : conv.into === 'privacy_request' ? (
              <Select
                id={`${uid}-rt`}
                label={t('admin.support.convert.requestType')}
                value={conv.requestType}
                options={REQUEST_TYPES.map((k) => ({ value: k, label: t(`admin.privacy.type.${k}` as MessageKey) }))}
                error={cErr('requestType')}
                onChange={(v) => setC({ requestType: v as ConversionDraft['requestType'] })}
              />
            ) : conv.into === 'dispute' ? (
              <>
                <Select
                  id={`${uid}-dt`}
                  label={t('admin.support.convert.targetType')}
                  value={conv.disputeTargetType}
                  options={DISPUTE_TARGETS.map((k) => ({ value: k, label: t(`admin.support.disputeTarget.${k}`) }))}
                  onChange={(v) => setC({ disputeTargetType: v as ConversionDraft['disputeTargetType'] })}
                />
                <TextField
                  label={t('admin.support.convert.targetId')}
                  hint={t('admin.support.convert.idHint')}
                  error={cErr('disputeTarget')}
                  value={conv.disputeTargetId}
                  dir="ltr"
                  autoComplete="off"
                  onChange={(e) => setC({ disputeTargetId: e.target.value })}
                />
                <Select
                  id={`${uid}-dty`}
                  label={t('admin.support.convert.disputeType')}
                  value={conv.disputeType}
                  options={DISPUTE_TYPES.map((k) => ({ value: k, label: t(`admin.disputes.type.${k}` as MessageKey) }))}
                  error={cErr('disputeType')}
                  onChange={(v) => setC({ disputeType: v as ConversionDraft['disputeType'] })}
                />
              </>
            ) : conv.into === 'plan_request' ? (
              <>
                {!x.organization ? <p className="cp-field-error">{t('admin.support.convert.problem.organization')}</p> : null}
                <Select
                  id={`${uid}-plan`}
                  label={t('admin.support.convert.plan')}
                  value={conv.planKey}
                  options={PLAN_KEYS.map((k) => ({ value: k, label: planLabel(k, t) }))}
                  error={cErr('planKey')}
                  onChange={(v) => setC({ planKey: v as ConversionDraft['planKey'] })}
                />
              </>
            ) : null}
            {conv.into ? (
              <TextField
                multiline
                rows={3}
                label={t('admin.support.convert.statement')}
                hint={t('admin.support.convert.statementHint')}
                error={cErr('statement')}
                value={conv.statement}
                maxLength={2000}
                onChange={(e) => setC({ statement: e.target.value })}
              />
            ) : null}
            <div className="adm-actions">
              <Button type="submit" variant="secondary" loading={convert.state.status === 'busy'} disabled={busy}>
                {t('admin.support.convert.submit')}
              </Button>
            </div>
          </form>
          <ActionNotice state={convert.state} applied={t('admin.support.convert.done')} />
        </section>
      ) : null}

      {!solved ? (
        <section aria-labelledby={`${uid}-close`} className="adm-panel" data-testid="support-close">
          <h2 id={`${uid}-close`} className="adm-panel-title">
            {t('admin.support.close.title')}
          </h2>
          <fieldset className="adm-choices">
            <legend>{t('admin.support.col.outcome')}</legend>
            {CLOSE_OUTCOMES.map((o) => (
              <label key={o} className="adm-radio">
                <input type="radio" name={`${uid}-outcome`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
                {outcomeLabel(o, t)}
              </label>
            ))}
          </fieldset>
          {!canClose ? <p className="cp-field-error">{t('admin.support.close.needsItem')}</p> : null}
          <TextField
            multiline
            rows={3}
            label={t('admin.support.close.note')}
            hint={t('admin.support.close.noteHint')}
            error={noteTooLong ? t('admin.support.close.noteTooLong') : undefined}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="adm-actions">
            <Button
              variant="primary"
              disabled={busy || !canClose || noteTooLong}
              loading={close.state.status === 'busy'}
              onClick={() => open({ kind: 'close' })}
            >
              {t('admin.support.close.submit')}
            </Button>
          </div>
        </section>
      ) : null}
      {/* Outside the section: a solved ticket no longer shows it. */}
      <ActionNotice state={close.state} applied={t('admin.support.close.done')} />

      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={
          dialog?.kind === 'close'
            ? 'support_close'
            : dialog?.kind === 'convert'
              ? 'support_convert'
              : dialog?.kind === 'assign'
                ? 'support_assign'
                : 'support_reply'
        }
        title={dialog ? t(`admin.support.dialog.${dialog.kind}`, { subject: x.subject }) : ''}
        confirmLabel={
          dialog?.kind === 'close'
            ? t('admin.support.close.submit')
            : dialog?.kind === 'convert'
              ? t('admin.support.convert.submit')
              : dialog?.kind === 'assign'
                ? t('admin.support.assign.confirm')
                : t('admin.support.reply.send')
        }
        summary={
          dialog?.kind === 'reply' ? (
            <p className="adm-muted">{t(waitOnTeam ? 'admin.support.reply.effectTeam' : 'admin.support.reply.effectUser')}</p>
          ) : dialog?.kind === 'close' ? (
            <p className="adm-muted">{t('admin.support.close.effect', { outcome: outcomeLabel(outcome, t) })}</p>
          ) : dialog?.kind === 'convert' ? (
            <p className="adm-muted">{t('admin.support.convert.effect')}</p>
          ) : null
        }
        onSubmit={submit}
        name="support"
      />
    </div>
  );
}

function Select({
  id,
  label: text,
  value,
  options,
  error,
  required,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  error?: string | undefined;
  required?: boolean;
  onChange: (v: string) => void;
}) {
  const t = useT();
  return (
    <div className="cp-field">
      <label className="cp-field-label" htmlFor={id}>
        {text}
      </label>
      <div className="cp-field-box">
        <select
          id={id}
          className="cp-field-input adm-select"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {required ? null : <option value="">{t('admin.support.choose')}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p id={`${id}-e`} className="cp-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
