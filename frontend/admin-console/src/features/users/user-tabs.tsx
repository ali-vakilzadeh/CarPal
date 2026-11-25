'use client';
// The A-USR-02 tabs on backend S23 reads (AC14-2, BR-16), each under the page's work item (PURP; a record outside it
// answers PURPOSE_RECORD_MISMATCH): Vehicles (brand, model, year, status; VIN last four, plate last two; never
// documents), Appointments (business, vehicle, type, status, dates; no staff read of the full record, so the row links
// to the business), Consents (read-only: the active consents, then the full history with the text version and the
// channel) and Sessions & devices (sessions and push devices without tokens; Sign out everywhere stays in the header).
import Link from 'next/link';
import type { ConsentRecord, StaffAppointmentRow, StaffPushDevice, StaffUserSession, StaffVehicleRow } from '@carpal/api-contracts';
import { DataTable, useCursorPaging, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, CONSENT_TYPES, VEHICLE_STATUSES, consentState, type ConsentState } from './user-logic';

/** Rows per page of a tab (admin pages hold at most 100). */
const TAB_PAGE = 50;

function label(list: readonly string[], prefix: string, value: string, t: Translate): string {
  return list.includes(value) ? t(`${prefix}.${value}` as MessageKey) : t('admin.kit.unknown', { value });
}

/** A taxonomy label as the backend sends it: the text in its own language. */
function Localized({ v }: { v: { text: string; locale: 'en' | 'fa' } | null | undefined }) {
  if (!v) return <>—</>;
  return (
    <span lang={v.locale}>
      <Bidi>{v.text}</Bidi>
    </span>
  );
}

function paged(paging: ReturnType<typeof useCursorPaging>, next: string | null | undefined) {
  return {
    page: paging.page,
    hasPrev: paging.page > 1,
    hasNext: !!next,
    onPrev: paging.prev,
    onNext: () => next && paging.next(next),
  };
}

export function VehiclesTab({ userId, purpose }: { userId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(userId);
  const q = useApiQuery(
    'admin.user_vehicles',
    { path: { user_id: userId }, query: { limit: TAB_PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const columns: Column<StaffVehicleRow>[] = [
    {
      id: 'vehicle',
      header: t('admin.users.vehicles.col.vehicle'),
      pinned: true,
      cell: (v) => (
        <>
          <Localized v={v.brand} /> <Localized v={v.model} />
          {v.series ? (
            <>
              {' '}
              <Localized v={v.series} />
            </>
          ) : null}
        </>
      ),
    },
    { id: 'year', header: t('admin.users.vehicles.col.year'), align: 'end', cell: (v, c) => c.digits(String(v.year)) },
    {
      id: 'status',
      header: t('admin.users.vehicles.col.status'),
      cell: (v) => label(VEHICLE_STATUSES, 'admin.users.vehicles.status', v.status, t),
    },
    {
      id: 'vin',
      header: t('admin.users.vehicles.col.vin'),
      cell: (v) => (v.vin_last4 ? <Bidi ltr>{`•••• ${v.vin_last4}`}</Bidi> : '—'),
    },
    { id: 'plate', header: t('admin.users.vehicles.col.plate'), cell: (v) => (v.plate_masked ? <Bidi ltr>{v.plate_masked}</Bidi> : '—') },
    { id: 'added', header: t('admin.users.vehicles.col.added'), align: 'end', cell: (v) => f.date(v.created_at, 'dateShort') },
  ];
  return (
    <section data-testid="user-vehicles" className="adm-stack">
      <p className="adm-muted">{t('admin.users.vehicles.note')}</p>
      <DataTable
        id="user-vehicles"
        caption={t('admin.users.tab.vehicles')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(v) => v.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.users.vehicles.empty')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}

export function AppointmentsTab({ userId, purpose }: { userId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(userId);
  const q = useApiQuery(
    'admin.user_appointments',
    { path: { user_id: userId }, query: { limit: TAB_PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const columns: Column<StaffAppointmentRow>[] = [
    {
      id: 'business',
      header: t('admin.users.appointments.col.business'),
      pinned: true,
      cell: (a) =>
        a.provider ? (
          <Link href={`/orgs/${a.provider.id}`}>
            <Bidi>{a.provider.name}</Bidi>
          </Link>
        ) : (
          t('admin.users.appointments.businessGone')
        ),
    },
    {
      id: 'vehicle',
      header: t('admin.users.appointments.col.vehicle'),
      cell: (a, c) =>
        a.vehicle ? (
          <>
            <Localized v={a.vehicle.brand} /> <Localized v={a.vehicle.model} /> {c.digits(String(a.vehicle.year))}
          </>
        ) : (
          '—'
        ),
    },
    {
      id: 'type',
      header: t('admin.users.appointments.col.type'),
      cell: (a) => label(APPOINTMENT_TYPES, 'admin.users.appointments.type', a.appointment_type, t),
    },
    {
      id: 'status',
      header: t('admin.users.appointments.col.status'),
      cell: (a) => (
        <>
          {label(APPOINTMENT_STATUSES, 'admin.users.appointments.status', a.status, t)}
          {a.safety_flag ? (
            <>
              {' '}
              <Badge tone="danger">{t('admin.users.appointments.safety')}</Badge>
            </>
          ) : null}
        </>
      ),
    },
    {
      id: 'fleet',
      header: t('admin.users.appointments.col.fleet'),
      defaultHidden: true,
      cell: (a) => (a.requester_organization ? <Bidi>{a.requester_organization.name}</Bidi> : '—'),
    },
    { id: 'requested', header: t('admin.users.appointments.col.requested'), align: 'end', cell: (a) => f.date(a.created_at, 'dateShort') },
    {
      id: 'confirmed',
      header: t('admin.users.appointments.col.confirmed'),
      align: 'end',
      cell: (a) => (a.confirmed_start_at ? f.date(a.confirmed_start_at, 'dateTime') : '—'),
    },
    {
      id: 'completed',
      header: t('admin.users.appointments.col.completed'),
      align: 'end',
      cell: (a) => (a.completed_at ? f.date(a.completed_at, 'dateShort') : '—'),
    },
  ];
  return (
    <section data-testid="user-appointments" className="adm-stack">
      <p className="adm-muted">{t('admin.users.appointments.note')}</p>
      <DataTable
        id="user-appointments"
        caption={t('admin.users.tab.appointments')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(a) => a.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.users.appointments.empty')}
        shortcuts={false}
        paging={paged(paging, q.data?.next_cursor)}
      />
    </section>
  );
}

const STATE_TONE: Record<ConsentState, 'success' | 'signal' | 'neutral' | 'danger'> = {
  granted: 'success',
  reconsent: 'signal',
  paused: 'danger',
  withdrawn: 'neutral',
  expired: 'neutral',
  declined: 'neutral',
};

function ConsentStateBadge({ c }: { c: ConsentRecord }) {
  const t = useT();
  const s = consentState(c);
  return <Badge tone={STATE_TONE[s]}>{t(`admin.users.consents.state.${s}`)}</Badge>;
}

export function ConsentsTab({ userId, purpose }: { userId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging(userId);
  const active = useApiQuery(
    'admin.user_consents',
    { path: { user_id: userId }, query: { active: true, limit: 100 }, purpose },
    { retry: false },
  );
  const history = useApiQuery(
    'admin.user_consents',
    { path: { user_id: userId }, query: { limit: TAB_PAGE, ...(paging.cursor ? { cursor: paging.cursor } : {}) }, purpose },
    { retry: false },
  );
  const sharedWith = (c: ConsentRecord) =>
    c.granted_to_organization ? (
      <Bidi>{c.granted_to_organization.name}</Bidi>
    ) : c.granted_to_type ? (
      t(`admin.users.consents.to.${c.granted_to_type}`)
    ) : (
      '—'
    );
  const columns = (dated: 'current' | 'history'): Column<ConsentRecord>[] => [
    {
      id: 'type',
      header: t('admin.users.consents.col.type'),
      pinned: true,
      cell: (c) => label(CONSENT_TYPES, 'admin.policies.key', c.consent_type, t),
    },
    { id: 'state', header: t('admin.users.consents.col.state'), cell: (c) => <ConsentStateBadge c={c} /> },
    { id: 'to', header: t('admin.users.consents.col.sharedWith'), cell: sharedWith },
    {
      id: 'text',
      header: t('admin.users.consents.col.text'),
      cell: (c) => (
        <>
          <Bidi ltr>{c.policy_version}</Bidi>
          {c.confirmed_policy_version && c.confirmed_policy_version !== c.policy_version ? (
            <> {t('admin.users.consents.confirmedUnder', { version: c.confirmed_policy_version })}</>
          ) : null}
        </>
      ),
    },
    { id: 'source', header: t('admin.users.consents.col.source'), cell: (c) => t(`admin.users.consents.source.${c.source}`) },
    {
      id: 'granted',
      header: t('admin.users.consents.col.granted'),
      align: 'end',
      cell: (c) => (c.granted_at ? f.date(c.granted_at, 'dateShort') : '—'),
    },
    ...(dated === 'history'
      ? [
          {
            id: 'withdrawn',
            header: t('admin.users.consents.col.withdrawn'),
            align: 'end' as const,
            cell: (c: ConsentRecord) => (c.withdrawn_at ? f.date(c.withdrawn_at, 'dateShort') : '—'),
          },
        ]
      : []),
    {
      id: 'expires',
      header: t('admin.users.consents.col.expires'),
      align: 'end',
      defaultHidden: dated === 'history',
      cell: (c) => (c.expires_at ? f.date(c.expires_at, 'dateShort') : '—'),
    },
  ];
  return (
    <section data-testid="user-consents" className="adm-stack">
      <p className="adm-muted">{t('admin.users.consents.note')}</p>
      <h3 className="adm-subtitle">{t('admin.users.consents.current')}</h3>
      <DataTable
        id="user-consents-current"
        caption={t('admin.users.consents.current')}
        columns={columns('current')}
        rows={active.data?.items}
        rowKey={(c) => c.id}
        loading={active.isPending}
        error={active.error}
        onRetry={() => void active.refetch()}
        emptyText={t('admin.users.consents.noneActive')}
        shortcuts={false}
      />
      <h3 className="adm-subtitle">{t('admin.users.consents.history')}</h3>
      <DataTable
        id="user-consents-history"
        caption={t('admin.users.consents.history')}
        columns={columns('history')}
        rows={history.data?.items}
        rowKey={(c) => c.id}
        loading={history.isPending}
        error={history.error}
        onRetry={() => void history.refetch()}
        emptyText={t('admin.users.consents.empty')}
        shortcuts={false}
        paging={paged(paging, history.data?.next_cursor)}
      />
    </section>
  );
}

export function SessionsTab({ userId, purpose }: { userId: string; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery('admin.user_sessions', { path: { user_id: userId }, purpose }, { retry: false });
  const sessions: Column<StaffUserSession>[] = [
    {
      id: 'device',
      header: t('admin.users.sessions.col.device'),
      pinned: true,
      cell: (s) => (
        <>
          <Bidi>{s.device_label}</Bidi>
          {s.staff ? (
            <>
              {' '}
              <Badge tone="accent">{t('admin.users.sessions.staff')}</Badge>
            </>
          ) : null}
        </>
      ),
    },
    { id: 'client', header: t('admin.users.sessions.col.client'), cell: (s) => <Bidi ltr>{s.client_id}</Bidi> },
    { id: 'country', header: t('admin.users.sessions.col.country'), cell: (s) => (s.country ? <Bidi ltr>{s.country}</Bidi> : '—') },
    { id: 'acr', header: t('admin.users.sessions.col.assurance'), cell: (s) => t(`admin.users.sessions.acr.${s.acr}`) },
    { id: 'started', header: t('admin.users.sessions.col.started'), align: 'end', cell: (s) => f.date(s.created_at, 'dateTime') },
    { id: 'seen', header: t('admin.users.sessions.col.lastSeen'), align: 'end', cell: (s) => f.date(s.last_seen_at, 'dateTime') },
  ];
  const devices: Column<StaffPushDevice>[] = [
    {
      id: 'platform',
      header: t('admin.users.devices.col.platform'),
      pinned: true,
      cell: (d) => t(`admin.users.devices.platform.${d.platform}`),
    },
    { id: 'app', header: t('admin.users.devices.col.app'), cell: (d) => (d.app_version ? <Bidi ltr>{d.app_version}</Bidi> : '—') },
    {
      id: 'language',
      header: t('admin.users.devices.col.language'),
      cell: (d) => (d.locale ? t(`admin.users.devices.locale.${d.locale}`) : '—'),
    },
    {
      id: 'status',
      header: t('admin.users.devices.col.status'),
      cell: (d) => <Badge tone={d.status === 'active' ? 'success' : 'neutral'}>{t(`admin.users.devices.status.${d.status}`)}</Badge>,
    },
    { id: 'added', header: t('admin.users.devices.col.added'), align: 'end', cell: (d) => f.date(d.created_at, 'dateShort') },
    {
      id: 'seen',
      header: t('admin.users.devices.col.lastSeen'),
      align: 'end',
      cell: (d) => (d.last_seen_at ? f.date(d.last_seen_at, 'dateTime') : '—'),
    },
  ];
  const data = q.data;
  return (
    <section data-testid="user-sessions" className="adm-stack">
      <p className="adm-muted">{t('admin.users.sessions.note')}</p>
      <h3 className="adm-subtitle">{t('admin.users.sessions.title')}</h3>
      {data && data.sessions_total > data.sessions.length ? (
        <p className="adm-muted" data-testid="sessions-more">
          {t('admin.users.sessions.more', { shown: f.number(data.sessions.length), total: f.number(data.sessions_total) })}
        </p>
      ) : null}
      <DataTable
        id="user-sessions"
        caption={t('admin.users.sessions.title')}
        columns={sessions}
        rows={data?.sessions}
        rowKey={(s) => s.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.users.sessions.empty')}
        shortcuts={false}
      />
      <h3 className="adm-subtitle">{t('admin.users.devices.title')}</h3>
      <DataTable
        id="user-devices"
        caption={t('admin.users.devices.title')}
        columns={devices}
        rows={data?.push_devices}
        rowKey={(d) => d.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.users.devices.empty')}
        shortcuts={false}
      />
    </section>
  );
}
