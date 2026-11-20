'use client';
// Staff & permissions (AC14.T2, Docs/23 A-STAFF-01, Docs/40 §23.2, backend S13, DQ-09..DQ-11). Platform admins see
// every staff member (admin.staff_list: masked email, platform roles, number of security keys, last sign-in, status)
// with role and status filters. A member's panel changes roles (a grant waits for a second admin, a removal works at
// once; admin.platform_role_grant / _revoke, as on the user page of AC10), disables the member at once (every role
// suspended, every session ended, their pending four-eyes requests rejected: DQ-11; never oneself and never the last
// active admin) and asks to enable a disabled member again (four-eyes, DQ-10). Invitations and staff access requests
// have no operation in contract 1.5.0, so they are not offered (no dead buttons, D-98, DI-39); a new staff member is
// created with backend pnpm staff:bootstrap and given roles here. No reset of another member's keys (DQ-04): a lost key
// goes through Recovery requests.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { StaffMember } from '@carpal/api-contracts';
import {
  ActionNotice,
  AuditDrawer,
  CaseLayout,
  DataTable,
  ReasonDialog,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { PLATFORM_ROLES, platformRole, type PlatformRole } from '@/features/users';

const PAGE_SIZE = 100;
const LIST_KEY = ['admin.staff_list'] as const;
/** A linked member (?member=, e.g. from the break-glass notice) is looked up across this many pages of 100 (BR-43). */
const LOOKUP_PAGES = 50;

/**
 * The member a link names when it is not on the page on screen: admin.staff_list has no id filter and is ordered by id
 * (oldest first), so the lookup reads the pages until it finds them. Under the list's key, so a change refreshes it.
 */
function useLinkedMember(id: string | null, onScreen: boolean) {
  const api = useApiClient();
  return useQuery<StaffMember | null, ApiProblem>({
    queryKey: [...LIST_KEY, 'member', id],
    enabled: !!id && !onScreen,
    queryFn: async ({ signal }) => {
      let cursor: string | undefined;
      for (let i = 0; i < LOOKUP_PAGES; i++) {
        const r = await api.api('admin.staff_list', { query: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, signal });
        const m = r.items.find((x) => x.user_id === id);
        if (m) return m;
        if (!r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return null;
    },
  });
}

/** Roles a member does not hold yet (contract order). */
export function missingRoles(member: Pick<StaffMember, 'platform_roles'>): PlatformRole[] {
  return PLATFORM_ROLES.filter((r) => !member.platform_roles.includes(r));
}

export function StaffPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const myId = session.data?.staff?.id ?? null;
  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'role',
        label: t('admin.staffDir.filter.role'),
        allowAll: true,
        options: PLATFORM_ROLES.map((r) => ({ value: r, label: platformRole(r, t) })),
      },
      {
        key: 'status',
        label: t('admin.staffDir.filter.status'),
        allowAll: true,
        options: (['active', 'disabled'] as const).map((s) => ({ value: s, label: t(`admin.staffDir.status.${s}`) })),
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const list = useApiQuery('admin.staff_list', {
    query: { limit: PAGE_SIZE, ...filters.query, ...(paging.cursor ? { cursor: paging.cursor } : {}) },
  });
  const items = list.data?.items;
  const memberId = params.get('member');
  const onScreen = items?.find((m) => m.user_id === memberId) ?? null;
  const linked = useLinkedMember(memberId, !!onScreen || !items);
  const selected = onScreen ?? linked.data ?? null;
  const select = (m: StaffMember) => {
    const q = new URLSearchParams(params);
    q.set('member', m.user_id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const columns: Column<StaffMember>[] = [
    {
      id: 'name',
      header: t('admin.staffDir.col.name'),
      pinned: true,
      cell: (m) => (
        <>
          <Bidi>{m.display_name}</Bidi>
          {m.user_id === myId ? <span className="adm-muted"> {t('admin.staffDir.you')}</span> : null}
        </>
      ),
    },
    { id: 'email', header: t('admin.staffDir.col.email'), cell: (m) => (m.email_masked ? <Bidi ltr>{m.email_masked}</Bidi> : '—') },
    {
      id: 'roles',
      header: t('admin.staffDir.col.roles'),
      cell: (m) => (m.platform_roles.length ? m.platform_roles.map((r) => platformRole(r, t)).join(', ') : '—'),
    },
    {
      id: 'keys',
      header: t('admin.staffDir.col.keys'),
      align: 'end',
      cell: (m) =>
        m.passkey_count === undefined ? (
          '—'
        ) : m.passkey_count === 0 ? (
          <Badge tone="danger">{t('admin.staffDir.noKey')}</Badge>
        ) : (
          f.number(m.passkey_count)
        ),
    },
    {
      id: 'last',
      header: t('admin.staffDir.col.lastSignIn'),
      cell: (m) => (m.last_sign_in_at ? f.date(m.last_sign_in_at, 'dateTime') : t('admin.staffDir.never')),
    },
    {
      id: 'status',
      header: t('admin.staffDir.col.status'),
      cell: (m) => <Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{t(`admin.staffDir.status.${m.status}`)}</Badge>,
    },
  ];

  return (
    <div className="adm-page" data-testid="staff-page">
      <h1 className="adm-page-title">{t('admin.staffDir.title')}</h1>
      <p className="adm-measure">{t('admin.staffDir.intro')}</p>
      <p className="adm-muted adm-measure" data-testid="staff-gaps">
        {t('admin.staffDir.gaps')}
      </p>
      <CaseLayout
        labels={{ list: t('admin.staffDir.listLabel'), item: t('admin.staffDir.itemLabel'), decision: t('admin.staffDir.historyLabel') }}
        list={
          <DataTable
            id="staff"
            caption={t('admin.staffDir.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(m) => m.user_id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.staffDir.empty')}
            selectedKey={selected?.user_id ?? null}
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
          selected ? (
            <MemberPanel key={selected.user_id} member={selected} isMe={selected.user_id === myId} />
          ) : memberId && linked.isFetching ? (
            <p role="status">{t('admin.work.loading')}</p>
          ) : memberId && linked.data === null ? (
            <p data-testid="staff-not-found">{t('admin.staffDir.notFound')}</p>
          ) : (
            <p className="adm-muted">{t('admin.staffDir.pick')}</p>
          )
        }
        decision={
          <>
            <p>
              <Link href="/approvals">{t('admin.staffDir.approvalsLink')}</Link>
            </p>
            {selected ? (
              <>
                <h2 className="adm-panel-title">{t('admin.staffDir.historyLabel')}</h2>
                <AuditDrawer entityType="user" entityId={selected.user_id} label={selected.display_name} />
              </>
            ) : null}
          </>
        }
      />
    </div>
  );
}

type Dialog = { kind: 'grant' | 'revoke'; role: PlatformRole } | { kind: 'disable' } | { kind: 'enable' };

function MemberPanel({ member, isMe }: { member: StaffMember; isMe: boolean }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const queryClient = useQueryClient();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const [role, setRole] = useState<PlatformRole | ''>('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [last, setLast] = useState<Dialog | null>(null);
  const grant = useAdminAction('admin.platform_role_grant', { target: member.user_id });
  const revoke = useAdminAction('admin.platform_role_revoke', { target: member.user_id, onOutcome: refresh });
  const disable = useAdminAction('admin.staff_disable', { target: member.user_id, onOutcome: refresh });
  const enable = useAdminAction('admin.staff_enable', { target: member.user_id });
  const actions = [grant, revoke, disable, enable];
  const busy = actions.some((a) => a.state.status === 'busy');
  const active = member.status === 'active';
  const grantable = missingRoles(member);
  const canRoles = canCall('admin.platform_role_grant', roles);
  const open = (d: Dialog) => {
    for (const a of actions) a.reset();
    setDialog(d);
  };
  const submit = (reason: string) => {
    const d = dialog;
    setDialog(null);
    if (!d) return;
    setLast(d);
    const user_id = member.user_id;
    if (d.kind === 'grant') void grant.run({ path: { user_id }, body: { role: d.role, reason }, reason });
    else if (d.kind === 'revoke') void revoke.run({ path: { user_id, role: d.role }, reason });
    else if (d.kind === 'disable') void disable.run({ path: { user_id }, body: { reason }, reason });
    else void enable.run({ path: { user_id }, body: { reason }, reason });
  };
  const dialogTitle = !dialog
    ? ''
    : dialog.kind === 'grant' || dialog.kind === 'revoke'
      ? t(`admin.users.staff.dialog.${dialog.kind}`, { role: platformRole(dialog.role, t) })
      : t(`admin.staffDir.dialog.${dialog.kind}`, { name: member.display_name });

  return (
    <article data-testid="staff-member" data-member={member.user_id} data-status={member.status}>
      <h2 className="adm-panel-title">
        <Bidi>{member.display_name}</Bidi>
      </h2>
      <dl className="adm-facts">
        <dt>{t('admin.staffDir.col.email')}</dt>
        <dd>{member.email_masked ? <Bidi ltr>{member.email_masked}</Bidi> : '—'}</dd>
        <dt>{t('admin.staffDir.col.keys')}</dt>
        <dd>{member.passkey_count === undefined ? '—' : f.number(member.passkey_count)}</dd>
        <dt>{t('admin.staffDir.col.lastSignIn')}</dt>
        <dd>{member.last_sign_in_at ? f.date(member.last_sign_in_at, 'dateTime') : t('admin.staffDir.never')}</dd>
        <dt>{t('admin.staffDir.col.status')}</dt>
        <dd>{t(`admin.staffDir.status.${member.status}`)}</dd>
      </dl>

      <section aria-labelledby={`${uid}-roles`} className="adm-panel" data-testid="staff-member-roles">
        <h3 id={`${uid}-roles`} className="adm-section-title">
          {t('admin.users.staff.title')}
        </h3>
        {member.platform_roles.length ? (
          <ul className="adm-stack">
            {member.platform_roles.map((r) => (
              <li key={r} data-testid="staff-role" data-role={r}>
                {platformRole(r, t)}
                {!active ? ` (${t('admin.staffDir.suspendedRole')})` : ''}{' '}
                {canRoles && active ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    loading={revoke.state.status === 'busy' && last?.kind === 'revoke' && last.role === r}
                    onClick={() => open({ kind: 'revoke', role: r })}
                  >
                    {t('admin.users.staff.revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('admin.users.staff.none')}</p>
        )}
        {canRoles && active && grantable.length ? (
          <div className="adm-actions">
            <div className="cp-field">
              <label className="cp-field-label" htmlFor={`${uid}-role`}>
                {t('admin.users.staff.role')}
              </label>
              <div className="cp-field-box">
                <select
                  id={`${uid}-role`}
                  className="cp-field-input adm-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as PlatformRole | '')}
                >
                  <option value="">{t('admin.users.staff.choose')}</option>
                  {grantable.map((r) => (
                    <option key={r} value={r}>
                      {platformRole(r, t)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !role}
              loading={grant.state.status === 'busy'}
              onClick={() => role && open({ kind: 'grant', role })}
            >
              {t('admin.users.staff.grant')}
            </Button>
          </div>
        ) : null}
        <ActionNotice state={grant.state} />
        <ActionNotice
          state={revoke.state}
          applied={last?.kind === 'revoke' ? t('admin.users.staff.revoked', { role: platformRole(last.role, t) }) : undefined}
        />
      </section>

      <section aria-labelledby={`${uid}-access`} className="adm-panel" data-testid="staff-member-access">
        <h3 id={`${uid}-access`} className="adm-section-title">
          {t('admin.staffDir.access.title')}
        </h3>
        {isMe ? (
          <p className="adm-muted" data-testid="staff-self">
            {t('admin.staffDir.access.self')}
          </p>
        ) : active ? (
          <>
            <p className="adm-muted">{t('admin.staffDir.access.disableText')}</p>
            <Button variant="danger" disabled={busy} loading={disable.state.status === 'busy'} onClick={() => open({ kind: 'disable' })}>
              {t('admin.staffDir.access.disable')}
            </Button>
          </>
        ) : (
          <>
            <p className="adm-muted">{t('admin.staffDir.access.enableText')}</p>
            <Button variant="secondary" disabled={busy} loading={enable.state.status === 'busy'} onClick={() => open({ kind: 'enable' })}>
              {t('admin.staffDir.access.enable')}
            </Button>
          </>
        )}
        <ActionNotice state={disable.state} applied={t('admin.staffDir.access.disabled', { name: member.display_name })} />
        <ActionNotice state={enable.state} />
      </section>

      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={
          dialog?.kind === 'revoke'
            ? 'role_revoke'
            : dialog?.kind === 'grant'
              ? 'role_grant'
              : dialog?.kind === 'enable'
                ? 'staff_enable'
                : 'staff_disable'
        }
        title={dialogTitle}
        confirmLabel={
          dialog?.kind === 'revoke'
            ? t('admin.users.staff.revoke')
            : dialog?.kind === 'grant'
              ? t('admin.users.staff.grant')
              : dialog?.kind === 'enable'
                ? t('admin.staffDir.access.enable')
                : t('admin.staffDir.access.disable')
        }
        confirmVariant={dialog?.kind === 'revoke' || dialog?.kind === 'disable' ? 'danger' : 'primary'}
        summary={
          dialog ? (
            <p className="adm-muted">
              {dialog.kind === 'grant' || dialog.kind === 'revoke'
                ? t(`admin.users.staff.effect.${dialog.kind}`)
                : t(`admin.staffDir.effect.${dialog.kind}`)}
            </p>
          ) : null
        }
        onSubmit={submit}
        name="staff-member"
      />
    </article>
  );
}
