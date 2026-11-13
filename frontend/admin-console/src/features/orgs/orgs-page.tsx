'use client';
// Organizations (AC9.T1, Docs/23 A-ORG-01, Docs/40 admin.orgs_search). Staff find an organization by name (part of
// it), slug or id, filtered by status, verification and type; the saved views of Docs/23 that the contract can serve
// are links ("Pending verification", "Suspended"); "Possible duplicates" and "Location issues" need filters the search
// does not have (DI-31). The search answers narrow StaffOrgSearchRow rows without a purpose (backend S14, BR-35 part 1):
// no contact data and no exact points, only what a queue needs (GD-10, DI-31). A row opens the organization page with the
// organization's oldest pending verification as its purpose when it has one; otherwise the page asks for a work item.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { StaffOrgSearchRow, StaffOrgView } from '@carpal/api-contracts';
import { DataTable, useCursorPaging, useUrlFilters, type Column, type FilterDef } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useApiQuery } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { isId } from '../moderation/case-logic';
import { label, ORG_STATUSES, ORG_TYPES, orgHref, VERIFICATION_STATUSES, verificationPurposes } from './org-logic';

const PAGE_SIZE = 50;
const SEARCH_IN = ['name', 'slug', 'id'] as const;
type SearchIn = (typeof SEARCH_IN)[number];

export function OrgStatusChips({ org }: { org: Pick<StaffOrgView, 'status' | 'verification_status'> }) {
  const t = useT();
  return (
    <span className="adm-chips">
      <span className="adm-chip" data-tone={org.status === 'active' ? 'ok' : org.status === 'suspended' ? 'danger' : 'neutral'}>
        {label(ORG_STATUSES, 'admin.orgs.status', org.status, t)}
      </span>
      <span
        className="adm-chip"
        data-tone={org.verification_status === 'verified' ? 'ok' : org.verification_status === 'pending' ? 'warn' : 'neutral'}
      >
        {label(VERIFICATION_STATUSES, 'admin.orgs.verification', org.verification_status, t)}
      </span>
    </span>
  );
}

export function OrgsPage() {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'status',
        label: t('admin.orgs.filter.status'),
        options: ORG_STATUSES.map((s) => ({ value: s, label: t(`admin.orgs.status.${s}`) })),
        allowAll: true,
      },
      {
        key: 'verification_status',
        label: t('admin.orgs.filter.verification'),
        options: VERIFICATION_STATUSES.map((s) => ({ value: s, label: t(`admin.orgs.verification.${s}`) })),
        allowAll: true,
      },
      {
        key: 'organization_type',
        label: t('admin.orgs.filter.type'),
        options: ORG_TYPES.map((s) => ({ value: s, label: t(`admin.orgs.type.${s}`) })),
        allowAll: true,
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);

  // The search text lives in the URL too (?q=, ?in=name|slug|id), so a link or Back returns to the same list.
  const q = (params.get('q') ?? '').trim().slice(0, 120);
  const askedIn = params.get('in');
  const searchIn: SearchIn = SEARCH_IN.find((x) => x === askedIn) ?? 'name';
  const [text, setText] = useState(q);
  const [how, setHow] = useState<SearchIn>(searchIn);
  const [idError, setIdError] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (how === 'id' && v && !isId(v)) {
      setIdError(true);
      return;
    }
    setIdError(false);
    const p = new URLSearchParams(params);
    if (v) p.set('q', v);
    else p.delete('q');
    if (how !== 'name') p.set('in', how);
    else p.delete('in');
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const search: Record<string, string> = {};
  if (q) {
    if (searchIn === 'id' && isId(q)) search.organization_id = q.toLowerCase();
    else if (searchIn === 'slug') search.slug = q.toLowerCase();
    else if (searchIn === 'name' && q.length >= 2) search.name = q;
  }
  const body = { ...filters.query, ...search };
  const paging = useCursorPaging(JSON.stringify(body));
  const list = useApiQuery('admin.orgs_search', {
    body: { ...body, limit: PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) },
  });

  const open = (o: StaffOrgSearchRow) => router.push(orgHref(o.id, verificationPurposes(o)[0]?.purpose ?? null));

  const columns: Column<StaffOrgSearchRow>[] = [
    { id: 'name', header: t('admin.orgs.col.name'), pinned: true, cell: (o) => <Bidi>{o.name}</Bidi> },
    { id: 'type', header: t('admin.orgs.col.type'), cell: (o) => label(ORG_TYPES, 'admin.orgs.type', o.organization_type, t) },
    { id: 'city', header: t('admin.orgs.col.city'), cell: (o) => <Bidi>{o.city ?? '—'}</Bidi> },
    { id: 'plan', header: t('admin.orgs.col.plan'), cell: (o) => (o.plan_key ? planLabel(o.plan_key, t) : '—') },
    {
      id: 'verification',
      header: t('admin.orgs.col.verification'),
      cell: (o) => label(VERIFICATION_STATUSES, 'admin.orgs.verification', o.verification_status, t),
    },
    { id: 'status', header: t('admin.orgs.col.status'), cell: (o) => label(ORG_STATUSES, 'admin.orgs.status', o.status, t) },
    { id: 'members', header: t('admin.orgs.col.members'), align: 'end', cell: (o) => f.number(o.member_count) },
    { id: 'cases', header: t('admin.orgs.col.cases'), align: 'end', cell: (o) => f.number(o.open_cases) },
    {
      id: 'trust',
      header: t('admin.orgs.col.trust'),
      align: 'end',
      defaultHidden: true,
      cell: (o) => (o.trust_score == null ? '—' : f.number(o.trust_score)),
    },
    {
      id: 'created',
      header: t('admin.orgs.col.created'),
      cell: (o, ctx) => <time dateTime={o.created_at}>{ctx.digits(f.date(o.created_at, 'dateShort'))}</time>,
    },
  ];

  const view = (key: 'pending' | 'suspended') => (key === 'pending' ? '/orgs?verification_status=pending' : '/orgs?status=suspended');

  return (
    <div className="adm-page" data-testid="orgs-page">
      <h1 className="adm-page-title">{t('admin.orgs.title')}</h1>
      <p className="adm-measure">{t('admin.orgs.intro')}</p>
      <form className="adm-search" role="search" aria-label={t('admin.orgs.search.label')} onSubmit={submit}>
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={`${uid}-in`}>
            {t('admin.orgs.search.in')}
          </label>
          <div className="cp-field-box">
            <select id={`${uid}-in`} className="cp-field-input adm-select" value={how} onChange={(e) => setHow(e.target.value as SearchIn)}>
              {SEARCH_IN.map((x) => (
                <option key={x} value={x}>
                  {t(`admin.orgs.search.by.${x}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <TextField
          label={t('admin.orgs.search.text')}
          hint={t(`admin.orgs.search.hint.${how}`)}
          error={idError ? t('admin.orgs.search.idInvalid') : undefined}
          value={text}
          dir={how === 'name' ? 'auto' : 'ltr'}
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="secondary" icon="search">
          {t('admin.orgs.search.go')}
        </Button>
      </form>
      <nav className="adm-quick-views" aria-label={t('admin.orgs.views.label')}>
        <Link href={view('pending')} className="adm-tab">
          {t('admin.orgs.views.pending')}
        </Link>
        <Link href={view('suspended')} className="adm-tab">
          {t('admin.orgs.views.suspended')}
        </Link>
        {q || Object.keys(filters.query).length ? (
          <Link href="/orgs" className="adm-tab">
            {t('admin.orgs.views.all')}
          </Link>
        ) : null}
      </nav>
      <DataTable
        id="orgs"
        caption={t('admin.orgs.listLabel')}
        columns={columns}
        rows={list.data?.items}
        rowKey={(o) => o.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyText={t('admin.orgs.empty')}
        onSelect={open}
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
    </div>
  );
}
