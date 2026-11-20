'use client';
// Platform audit log (AC13.T1, Docs/23 A-AUD-01, Docs/40 admin.audit_search; ADM only, rate-limited, the search itself
// is audited): who changed what, when and why. Staff fill the filters (entity type and id, actor id, action, a window of
// at most 93 days) and press Search; nothing is read before that. The log is append-only: nobody can edit or delete an
// entry, and the console offers no such action. The operation matches entity type, actor and action exactly and has no
// filter by actor type or by a group of actions, and no export (DI-38); the actor's type is shown on every row instead.
// IP and device are not in AuditEntry (Docs/23 asks for them masked; DI-38).
import { useState, type FormEvent } from 'react';
import type { AuditEntry } from '@carpal/api-contracts';
import { DataTable, EntityChip, useCursorPaging, type Column } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useApiQuery } from '@/lib/api/query';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@/lib/config/audit-catalog';
import { parseReason } from '@/lib/config/reasons';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { defaultDays, type SearchWindow } from './search-window';
import { useUrlSearch } from './use-url-search';
import { WindowField, windowDraftProblem, type WindowDraft } from './window-field';

const KEYS = ['entity_type', 'entity_id', 'actor_id', 'action'] as const;
const PAGE = 50;
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page of an entity the audit log names, where the console has one. */
export function entityHref(type: string, id: string): string | undefined {
  if (type === 'user_account' || type === 'user') return `/users/${encodeURIComponent(id)}`;
  if (type === 'organization') return `/orgs/${encodeURIComponent(id)}`;
  return undefined;
}

type Draft = Record<(typeof KEYS)[number], string> & { window: WindowDraft };

export function AuditPage() {
  const t = useT();
  const f = useFormat();
  const search = useUrlSearch(KEYS);
  const [draft, setDraft] = useState<Draft>(() => {
    const days = search.window?.kind === 'days' ? search.window : defaultDays(Date.now(), f.timeZone);
    return {
      ...search.values,
      window: {
        choice: search.window?.kind === 'preset' ? search.window.preset : search.window ? 'days' : '7',
        from: days.from,
        to: days.to,
      },
    };
  });
  const [tried, setTried] = useState(false);
  const problems = {
    entity_id: draft.entity_id.trim() && !ID_RE.test(draft.entity_id.trim()) ? 'id' : null,
    actor_id: draft.actor_id.trim() && !ID_RE.test(draft.actor_id.trim()) ? 'id' : null,
    window: windowDraftProblem(draft.window),
  };
  const valid = !problems.entity_id && !problems.actor_id && !problems.window;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!valid) return;
    const w: SearchWindow =
      draft.window.choice === 'days'
        ? { kind: 'days', from: draft.window.from, to: draft.window.to }
        : { kind: 'preset', preset: draft.window.choice };
    search.submit(draft, w);
  };
  const set = (k: (typeof KEYS)[number], v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="adm-page" data-testid="audit-page">
      <h1 className="adm-page-title">{t('admin.audit.title')}</h1>
      <p className="adm-measure">{t('admin.audit.intro')}</p>
      <Banner tone="info" text={t('admin.audit.appendOnly')} />
      <form className="adm-search" noValidate onSubmit={onSubmit} aria-labelledby="audit-search-title" data-testid="audit-search">
        <h2 id="audit-search-title" className="adm-section-title">
          {t('admin.audit.search.title')}
        </h2>
        <div className="adm-search-row">
          <TextFilter
            id="audit-entity-type"
            label={t('admin.audit.search.entityType')}
            value={draft.entity_type}
            onChange={(v) => set('entity_type', v)}
            list={AUDIT_ENTITY_TYPES}
            maxLength={60}
          />
          <TextFilter
            id="audit-entity-id"
            label={t('admin.audit.search.entityId')}
            value={draft.entity_id}
            onChange={(v) => set('entity_id', v)}
            error={tried && problems.entity_id ? t('admin.audit.search.badId') : undefined}
          />
          <TextFilter
            id="audit-action"
            label={t('admin.audit.search.action')}
            value={draft.action}
            onChange={(v) => set('action', v)}
            list={AUDIT_ACTIONS}
            maxLength={80}
          />
          <TextFilter
            id="audit-actor-id"
            label={t('admin.audit.search.actorId')}
            value={draft.actor_id}
            onChange={(v) => set('actor_id', v)}
            error={tried && problems.actor_id ? t('admin.audit.search.badId') : undefined}
          />
          <WindowField draft={draft.window} onChange={(w) => setDraft((d) => ({ ...d, window: w }))} tried={tried} />
          <Button type="submit" icon="search">
            {t('admin.audit.search.submit')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.audit.search.recorded')}</p>
      </form>
      {search.instants ? (
        <AuditResults key={`${search.at}-${JSON.stringify(search.values)}`} filters={search.values} instants={search.instants} />
      ) : (
        <p className="adm-muted" data-testid="audit-idle">
          {t('admin.audit.idle')}
        </p>
      )}
    </div>
  );
}

export function TextFilter({
  id,
  label,
  value,
  onChange,
  list,
  maxLength = 36,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  list?: readonly string[];
  maxLength?: number;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="adm-filter">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="adm-input"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        list={list ? `${id}-list` : undefined}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {list ? (
        <datalist id={`${id}-list`}>
          {list.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ) : null}
      {hint && !error ? (
        <span id={`${id}-hint`} className="adm-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="adm-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function AuditResults({ filters, instants }: { filters: Record<(typeof KEYS)[number], string>; instants: { from: string; to: string } }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging('audit');
  const body = {
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    from: instants.from,
    to: instants.to,
    limit: PAGE,
    ...(paging.cursor ? { cursor: paging.cursor } : {}),
  };
  const q = useApiQuery('admin.audit_search', { body }, { staleTime: Infinity, gcTime: 60_000 });
  const columns: Column<AuditEntry>[] = [
    {
      id: 'time',
      header: t('admin.audit.col.time'),
      pinned: true,
      cell: (e, ctx) => <time dateTime={e.created_at}>{ctx.digits(f.date(e.created_at, 'dateTime'))}</time>,
    },
    {
      id: 'actor',
      header: t('admin.audit.col.actor'),
      cell: (e) => (
        <>
          <Bidi>{e.actor_display}</Bidi> <span className="adm-muted">({t(`admin.kit.audit.actor.${e.actor_type}` as MessageKey)})</span>
        </>
      ),
    },
    { id: 'action', header: t('admin.audit.col.action'), cell: (e) => <Bidi ltr>{e.action}</Bidi> },
    {
      id: 'entity',
      header: t('admin.audit.col.entity'),
      cell: (e) => (
        <span className="adm-audit-entity">
          <Bidi ltr>{e.entity_type}</Bidi>
          <EntityChip type={e.entity_type} id={e.entity_id} href={entityHref(e.entity_type, e.entity_id)} />
        </span>
      ),
    },
    {
      id: 'change',
      header: t('admin.audit.col.change'),
      cell: (e) =>
        e.previous_state_summary || e.new_state_summary ? (
          <span className="adm-audit-change">
            {e.previous_state_summary ? <Bidi>{e.previous_state_summary}</Bidi> : <span className="adm-muted">—</span>}
            <span aria-hidden="true"> → </span>
            <span className="sr-only">{t('admin.audit.becomes')}</span>
            {e.new_state_summary ? <Bidi>{e.new_state_summary}</Bidi> : <span className="adm-muted">—</span>}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'reason',
      header: t('admin.audit.col.reason'),
      cell: (e) => {
        const r = e.reason ? parseReason(e.reason) : null;
        if (!r) return '—';
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
      },
    },
    {
      id: 'request',
      header: t('admin.audit.col.request'),
      defaultHidden: true,
      cell: (e) => (e.request_id ? <Bidi ltr>{e.request_id}</Bidi> : '—'),
    },
  ];
  return (
    <section aria-labelledby="audit-results-title" data-testid="audit-results">
      <h2 id="audit-results-title" className="adm-section-title">
        {t('admin.audit.results')}
      </h2>
      <p className="adm-muted">
        {t('admin.audit.between', { from: f.date(instants.from, 'dateTime'), to: f.date(instants.to, 'dateTime') })}
      </p>
      <DataTable
        id="audit"
        caption={t('admin.audit.results')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(e) => e.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.audit.empty')}
        shortcuts={false}
        paging={{
          page: paging.page,
          hasPrev: paging.page > 1,
          hasNext: !!q.data?.next_cursor,
          onPrev: paging.prev,
          onNext: () => q.data?.next_cursor && paging.next(q.data.next_cursor),
        }}
      />
    </section>
  );
}
