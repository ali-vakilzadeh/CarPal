'use client';
// DRV-WEB fleet driver views (P12.T4; Docs/02 WP19, Docs/55 §10.4 F-ISSUE-01). A fleet driver signs in to the
// consumer PWA like anyone else (the hosted sign-in); the fleets come from me.memberships_list (role fleet_driver).
//   /<locale>/drive                         the vehicles assigned to me in each fleet (vehicles.list on the fleet
//                                           route returns only those, SEC-AZ-7), queued reports waiting to be sent
//   /<locale>/drive/<org>/<vehicle>         one vehicle: status, mileage (Update mileage = vehicles.mileage_add),
//                                           my reports with the fleet approval state, appointments (status only)
//   /<locale>/drive/<org>/<vehicle>/report  F-ISSUE-01: shortcuts, what happens, urgency, "Vehicle feels unsafe",
//                                           photos, odometer, the optional guided check (triage.start, DRV), Save
//                                           draft and Submit to manager; offline it is queued and sent later
// Drivers read and report only (BA-22, backend OQ-15): no fleet manager features, no appointment requests.
import type { Appointment, UrgencyLevel, Vehicle, VehicleIssue } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Urgency } from '@/components/ds/urgency';
import { SkeletonCard, SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { AppointmentStatusBadge } from '@/features/appointments';
import { parseMileage, urgencyStyle, useModelName } from '@/features/garage';
import { UploadZone, discardGroup, releaseGroup, uploadsOf, whenReady } from '@/features/media';
import { useOnline } from '@/features/pwa';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useFlag } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import {
  SHORTCUTS,
  URGENCIES,
  approvalKey,
  driverFleets,
  reportUrgency,
  validateReport,
  withDraft,
  withQueued,
  withoutDraft,
  type DriverFleet,
  type ReportDraft,
  type ReportError,
  type Shortcut,
} from './model';
import { isNetworkProblem, sendReport, useDriverStore, useQueueSync } from './store';

export const drivePath = (locale: string, orgId?: string, vehicleId?: string, report = false) =>
  orgId && vehicleId ? `/${locale}/drive/${orgId}/${vehicleId}${report ? '/report' : ''}` : `/${locale}/drive`;

function useUserId(): string | null {
  const s = useSession();
  return s.data?.signed_in ? (s.data.user?.id ?? null) : null;
}

/** The fleets I drive for. */
function useDriverFleets() {
  const q = useApiQuery('me.memberships_list', { query: { status: 'active', limit: 50 } }, { staleTime: 5 * 60_000 });
  const fleets = useMemo(() => (q.data ? driverFleets(q.data.items) : null), [q.data]);
  return { ...q, fleets };
}

/** Sends the offline queue whenever a driver page is open and the network is back. */
function QueueSync() {
  const t = useT();
  const toast = useToast();
  const api = useApiClient();
  const locale = useLocale();
  const userId = useUserId();
  const titleOf = useCallback((d: ReportDraft) => (d.shortcut ? t(`driver.shortcut.${d.shortcut}`) : null), [t]);
  const onSent = useCallback((n: number) => toast(t('driver.queue.sent', { count: n })), [toast, t]);
  const onDropped = useCallback((n: number) => toast(t('driver.queue.dropped', { count: n })), [toast, t]);
  useQueueSync(api, userId, { locale, titleOf, onSent, onDropped });
  return null;
}

function VehicleName({ v }: { v: Vehicle }) {
  const { full } = useModelName(v);
  return <bdi>{v.nickname || full}</bdi>;
}

function PlateLine({ v }: { v: Vehicle }) {
  const t = useT();
  const f = useFormat();
  const parts = [
    v.license_plate ? t('driver.vehicle.plate', { plate: v.license_plate }) : null,
    v.mileage_km != null ? t('driver.vehicle.mileage', { km: f.number(v.mileage_km) }) : null,
  ].filter(Boolean);
  return parts.length ? <p className="pwa-text-caption m-0">{parts.join(' · ')}</p> : null;
}

// ---------------------------------------------------------------- home

function FleetVehicles({ fleet }: { fleet: DriverFleet }) {
  const t = useT();
  const locale = useLocale();
  const q = useApiQuery('vehicles.list', { path: { org_id: fleet.orgId }, query: { limit: 50 } });
  return (
    <section className="pwa-stack-sm" aria-labelledby={`fleet-${fleet.orgId}`}>
      <h2 id={`fleet-${fleet.orgId}`} className="pwa-text-label m-0">
        <bdi>{fleet.name}</bdi>
      </h2>
      {!q.data ? (
        q.isPending ? (
          <SkeletonList count={2} label={t('driver.loading')} />
        ) : (
          <StateView
            kind={stateFromProblem(q.error)}
            t={t}
            compact
            action={<Button onClick={() => void q.refetch()}>{t('common.actions.retry')}</Button>}
          />
        )
      ) : q.data.items.length === 0 ? (
        <StateView kind="empty" t={t} compact title={t('driver.noVehicleTitle')} text={t('driver.noVehicleText')} />
      ) : (
        <ul className="pwa-drive-list">
          {q.data.items.map((v) => (
            <li key={v.id} className="pwa-card pwa-drive-card">
              <Link href={drivePath(locale, fleet.orgId, v.id)} className="pwa-drive-card-link">
                <Icon name="car" />
                <span className="pwa-stack-xs">
                  <span className="pwa-text-label">
                    <VehicleName v={v} />
                  </span>
                  <PlateLine v={v} />
                </span>
              </Link>
              <div className="pwa-inline-buttons">
                {v.open_issue_count > 0 ? (
                  <Badge tone="signal">{t('driver.vehicle.openIssues', { count: v.open_issue_count })}</Badge>
                ) : null}
                <Link href={drivePath(locale, fleet.orgId, v.id, true)} className={buttonClass({ variant: 'primary', size: 'sm' })}>
                  <Icon name="flag" size={20} />
                  <span className="cp-btn-label">{t('driver.report')}</span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QueuedReports() {
  const t = useT();
  const userId = useUserId();
  const [store] = useDriverStore(userId);
  if (store.queue.length === 0) return null;
  return <Banner tone="warn" icon="offline" title={t('driver.queue.title', { count: store.queue.length })} text={t('driver.queue.text')} />;
}

export function DriverHome() {
  const t = useT();
  const f = useDriverFleets();
  return (
    <div className="pwa-drive">
      <QueueSync />
      <div className="pwa-page-head">
        <h1 className="pwa-text-title m-0">{t('driver.title')}</h1>
      </div>
      <p className="m-0">{t('driver.intro')}</p>
      <QueuedReports />
      {!f.fleets ? (
        f.isPending ? (
          <SkeletonList count={2} label={t('driver.loading')} />
        ) : (
          <StateView
            kind={stateFromProblem(f.error)}
            t={t}
            action={<Button onClick={() => void f.refetch()}>{t('common.actions.retry')}</Button>}
          />
        )
      ) : f.fleets.length === 0 ? (
        <StateView kind="empty" t={t} title={t('driver.noFleetTitle')} text={t('driver.noFleetText')} />
      ) : (
        f.fleets.map((fleet) => <FleetVehicles key={fleet.orgId} fleet={fleet} />)
      )}
    </div>
  );
}

// ---------------------------------------------------------------- vehicle

function MileageForm({ orgId, v }: { orgId: string; v: Vehicle }) {
  const t = useT();
  const toast = useToast();
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useDriverRefresh();
  if (!open)
    return (
      <Button size="sm" icon="gauge" onClick={() => setOpen(true)}>
        {t('driver.mileage.update')}
      </Button>
    );
  const save = async () => {
    const km = parseMileage(value);
    if (km === null) return setError('driver.errors.mileage');
    setBusy(true);
    setError(null);
    try {
      const log = await api.api('vehicles.mileage_add', {
        path: { org_id: orgId, vehicle_id: v.id },
        body: { mileage_km: km, recorded_at: new Date().toISOString() },
      });
      toast(t(log.lower_than_previous ? 'driver.mileage.savedLower' : 'driver.mileage.saved'));
      setOpen(false);
      setValue('');
      await qc.refresh();
    } catch (err) {
      setError(isNetworkProblem(err) ? 'driver.errors.offline' : 'driver.errors.failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pwa-stack-sm pwa-drive-mileage">
      <TextField
        label={t('driver.mileage.label')}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        hint={v.mileage_km != null ? t('driver.mileage.last', { km: v.mileage_km }) : undefined}
        error={error ? t(error) : undefined}
      />
      <div className="pwa-inline-buttons">
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Re-reads the driver's vehicle views after a change. */
function useDriverRefresh() {
  const queryClient = useQueryClient();
  return {
    refresh: () =>
      Promise.all(
        (['vehicles.get', 'vehicles.list', 'issues.list'] as const).map((op) => queryClient.invalidateQueries({ queryKey: [op] })),
      ).then(() => undefined),
  };
}

function IssueRow({ i }: { i: VehicleIssue }) {
  const t = useT();
  const f = useFormat();
  const approval = approvalKey(i);
  return (
    <li className="pwa-card pwa-stack-xs" data-testid="driver-issue">
      <div className="pwa-inline-buttons">
        <span className="pwa-text-label" dir="auto">
          {i.title}
        </span>
        <Urgency level={urgencyStyle(i.urgency_level)} label={t(`garage.urgency.${i.urgency_level}`)} />
      </div>
      <p className="pwa-text-caption m-0">
        {t(`driver.issueStatus.${i.status}`)} · {f.date(i.created_at, 'date')}
        {approval ? ` · ${t(`driver.approval.${approval}`)}` : ''}
      </p>
    </li>
  );
}

function AppointmentRow({ a }: { a: Appointment }) {
  const t = useT();
  const f = useFormat();
  const when = a.confirmed_start_at ?? a.proposed_start_at;
  return (
    <li className="pwa-card pwa-stack-xs" data-testid="driver-appointment">
      <div className="pwa-inline-buttons">
        <span className="pwa-text-label">
          <bdi>{a.provider.name}</bdi>
        </span>
        <AppointmentStatusBadge a={a} t={t} />
      </div>
      {when ? <p className="pwa-text-caption m-0">{f.date(when, 'dateTime')}</p> : null}
    </li>
  );
}

export function DriverVehicle({ orgId, vehicleId }: { orgId: string; vehicleId: string }) {
  const t = useT();
  const locale = useLocale();
  const path = { org_id: orgId, vehicle_id: vehicleId };
  const v = useApiQuery('vehicles.get', { path });
  const issues = useApiQuery('issues.list', { path, query: { limit: 20 } });
  const appointments = useApiQuery('appointments.list', { path: { org_id: orgId }, query: { vehicle_id: vehicleId, limit: 10 } });

  if (!v.data)
    return v.isPending ? (
      <SkeletonCard lines={5} />
    ) : (
      <div className="pwa-drive">
        <h1 className="sr-only">{t('driver.title')}</h1>
        <StateView
          kind={stateFromProblem(v.error)}
          t={t}
          action={
            <Link href={drivePath(locale)} className={buttonClass({})}>
              <span className="cp-btn-label">{t('driver.back')}</span>
            </Link>
          }
        />
      </div>
    );
  const vehicle = v.data;
  return (
    <div className="pwa-drive">
      <QueueSync />
      <Link href={drivePath(locale)} className="pwa-link">
        <Icon name="back" size={16} /> {t('driver.back')}
      </Link>
      <div className="pwa-page-head">
        <h1 className="pwa-text-title m-0">
          <VehicleName v={vehicle} />
        </h1>
        <Link href={drivePath(locale, orgId, vehicleId, true)} className={buttonClass({ variant: 'primary' })}>
          <Icon name="flag" size={20} />
          <span className="cp-btn-label">{t('driver.report')}</span>
        </Link>
      </div>
      <section className="pwa-card pwa-stack-sm" aria-labelledby="drv-facts">
        <h2 id="drv-facts" className="pwa-text-label m-0">
          {t('driver.vehicle.facts')}
        </h2>
        <p className="m-0">
          {t('driver.vehicle.status')}: <strong>{t(`garage.status.${vehicle.status}`)}</strong>
        </p>
        <PlateLine v={vehicle} />
        <MileageForm orgId={orgId} v={vehicle} />
      </section>
      <section className="pwa-stack-sm" aria-labelledby="drv-issues">
        <h2 id="drv-issues" className="pwa-text-label m-0">
          {t('driver.vehicle.reports')}
        </h2>
        {!issues.data ? (
          issues.isPending ? (
            <SkeletonList count={2} label={t('driver.loading')} />
          ) : (
            <StateView kind={stateFromProblem(issues.error)} t={t} compact />
          )
        ) : issues.data.items.length === 0 ? (
          <p className="pwa-text-caption m-0">{t('driver.vehicle.noReports')}</p>
        ) : (
          <ul className="pwa-drive-list">
            {issues.data.items.map((i) => (
              <IssueRow key={i.id} i={i} />
            ))}
          </ul>
        )}
      </section>
      <section className="pwa-stack-sm" aria-labelledby="drv-appointments">
        <h2 id="drv-appointments" className="pwa-text-label m-0">
          {t('driver.vehicle.appointments')}
        </h2>
        <p className="pwa-text-caption m-0">{t('driver.vehicle.appointmentsHint')}</p>
        {!appointments.data ? (
          appointments.isPending ? (
            <SkeletonList count={1} label={t('driver.loading')} />
          ) : (
            <StateView kind={stateFromProblem(appointments.error)} t={t} compact />
          )
        ) : appointments.data.items.length === 0 ? (
          <p className="pwa-text-caption m-0">{t('driver.vehicle.noAppointments')}</p>
        ) : (
          <ul className="pwa-drive-list">
            {appointments.data.items.map((a) => (
              <AppointmentRow key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- report (F-ISSUE-01)

const ERROR_TEXT: Record<ReportError, MessageKey> = {
  vehicle: 'driver.errors.vehicle',
  description: 'driver.errors.description',
  mileage: 'driver.errors.mileage',
};

interface Suggestion {
  urgency: UrgencyLevel | null;
  areas: string[];
  safety: boolean;
  doNotDrive: boolean;
}

function GuidedCheck({
  vehicleId,
  description,
  onSuggestion,
}: {
  vehicleId: string;
  description: string;
  onSuggestion: (s: Suggestion | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const enabled = useFlag('ai.triage.enabled');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'off' | 'failed' | 'done'>('idle');
  if (!enabled) return null;
  const run = async () => {
    setBusy(true);
    try {
      const s = await api.api('triage.start', {
        body: { vehicle_id: vehicleId, text: description.trim().slice(0, 2000), locale: locale === 'en' ? 'en' : 'fa' },
      });
      onSuggestion({
        urgency: s.urgency_level,
        areas: s.likely_systems.map((x) => x.label.text).slice(0, 3),
        safety: s.safety.flag,
        doNotDrive: s.safety.do_not_drive,
      });
      setState('done');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'AI_UNAVAILABLE') {
        const safety = err.safety;
        onSuggestion(
          safety?.flag
            ? { urgency: null, areas: [], safety: true, doNotDrive: !!(safety as { do_not_drive?: boolean }).do_not_drive }
            : null,
        );
        setState('off');
      } else setState('failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pwa-stack-sm">
      <div>
        <Button size="sm" icon="spark" loading={busy} disabled={[...description.trim()].length < 10} onClick={() => void run()}>
          {t('driver.form.check')}
        </Button>
      </div>
      <p className="pwa-text-caption m-0">
        {t(state === 'off' ? 'driver.form.checkOff' : state === 'failed' ? 'driver.form.checkFailed' : 'driver.form.checkHint')}
      </p>
    </div>
  );
}

function newDraft(orgId: string, vehicleId: string): ReportDraft {
  return {
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    orgId,
    vehicleId,
    shortcut: null,
    description: '',
    urgency: 'medium',
    unsafe: false,
    mileage: '',
    savedAt: new Date().toISOString(),
  };
}

export function DriverReport({ orgId, vehicleId }: { orgId: string; vehicleId: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const api = useApiClient();
  const online = useOnline();
  const userId = useUserId();
  const [store, update] = useDriverStore(userId);
  const vehicle = useApiQuery('vehicles.get', { path: { org_id: orgId, vehicle_id: vehicleId } });
  const saved = store.drafts[vehicleId];
  const [d, setD] = useState<ReportDraft>(() => newDraft(orgId, vehicleId));
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState<ReportError[]>([]);
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [useSuggested, setUseSuggested] = useState(false);
  const [sent, setSent] = useState<{ queued: boolean } | null>(null);
  const group = `driver-issue:${vehicleId}`;
  const qc = useDriverRefresh();

  // A saved draft of this vehicle comes back once (state adjusted while rendering, React's "previous renders" pattern).
  if (saved && !restored) {
    setRestored(true);
    setD(saved);
  }

  const set = (patch: Partial<ReportDraft>) => setD((x) => ({ ...x, ...patch }));
  const urgency = reportUrgency(d.urgency, d.unsafe, useSuggested ? (suggestion?.urgency ?? null) : null);
  const titleText = d.shortcut ? t(`driver.shortcut.${d.shortcut}`) : null;
  const showSafety = urgency === 'safety_critical' || suggestion?.safety;

  const saveDraft = () => {
    update((s) => withDraft(s, { ...d, savedAt: new Date().toISOString() }));
    toast(t('driver.form.draftSaved'));
  };

  const queue = (draft: ReportDraft) => {
    discardGroup(group);
    update((s) => withQueued(s, draft));
    setSent({ queued: true });
  };

  const submit = async () => {
    const km = d.mileage.trim() ? parseMileage(d.mileage) : null;
    const e = validateReport(d, km);
    setErrors(e);
    if (e.length) return;
    const draft: ReportDraft = { ...d, urgency, savedAt: new Date().toISOString() };
    if (!online) return queue(draft);
    setBusy(true);
    setFormError(null);
    try {
      const assets = await Promise.all(
        uploadsOf(group)
          .filter((u) => u.state.phase !== 'failed')
          .map((u) => whenReady(u.id)),
      );
      const mediaIds = assets.filter((a) => a !== null).map((a) => a.id);
      const result = await sendReport(api, draft, { title: titleText, locale, mediaIds });
      releaseGroup(group);
      update((s) => withoutDraft(s, vehicleId));
      if (result.mileageFailed) toast(t('driver.mileage.failed'));
      await qc.refresh();
      setSent({ queued: false });
    } catch (err) {
      if (isNetworkProblem(err)) queue(draft);
      else if (err instanceof ApiProblem && err.code === 'MEDIA_NOT_READY') setFormError('driver.errors.media');
      else if (err instanceof ApiProblem && err.field('/description')) setErrors(['description']);
      else setFormError(err instanceof ApiProblem && err.status === 404 ? 'driver.errors.notAssigned' : 'driver.errors.failed');
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <div className="pwa-drive" data-testid="driver-report-done">
        <h1 className="sr-only">{t('driver.form.title')}</h1>
        <StateView
          kind="empty"
          t={t}
          title={t(sent.queued ? 'driver.done.queuedTitle' : 'driver.done.title')}
          text={t(sent.queued ? 'driver.done.queuedText' : 'driver.done.text')}
          action={
            <Link href={drivePath(locale, orgId, vehicleId)} className={buttonClass({ variant: 'primary' })}>
              <span className="cp-btn-label">{t('driver.done.back')}</span>
            </Link>
          }
        />
      </div>
    );

  if (!vehicle.data && !vehicle.isPending)
    return (
      <div className="pwa-drive">
        <h1 className="sr-only">{t('driver.form.title')}</h1>
        <StateView kind={stateFromProblem(vehicle.error)} t={t} />
      </div>
    );

  return (
    <div className="pwa-drive">
      <QueueSync />
      <Link href={drivePath(locale, orgId, vehicleId)} className="pwa-link">
        <Icon name="back" size={16} /> {t('driver.backToVehicle')}
      </Link>
      <h1 className="pwa-text-title m-0">{t('driver.form.title')}</h1>
      {vehicle.data ? (
        <p className="m-0">
          {t('driver.form.vehicle')}:{' '}
          <strong>
            <VehicleName v={vehicle.data} />
          </strong>
        </p>
      ) : (
        <SkeletonCard lines={1} />
      )}
      {!online ? <Banner tone="warn" icon="offline" text={t('driver.form.offline')} /> : null}
      {restored && saved ? <Banner tone="info" icon="doc" text={t('driver.form.draftRestored')} /> : null}
      <form
        className="pwa-stack pwa-card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="pwa-stack-sm">
          <legend className="pwa-text-label">{t('driver.form.shortcuts')}</legend>
          <div className="pwa-chip-row">
            {SHORTCUTS.map((s: Shortcut) => (
              <button
                key={s}
                type="button"
                className={cx('cp-chip', d.shortcut === s && 'is-selected')}
                aria-pressed={d.shortcut === s}
                onClick={() => set({ shortcut: d.shortcut === s ? null : s })}
              >
                {t(`driver.shortcut.${s}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <TextField
          multiline
          rows={4}
          label={t('driver.form.description')}
          value={d.description}
          maxLength={3000}
          onChange={(e) => set({ description: e.target.value })}
          hint={t('driver.form.descriptionHint')}
          error={errors.includes('description') ? t(ERROR_TEXT.description) : undefined}
        />
        <fieldset className="pwa-stack-sm">
          <legend className="pwa-text-label">{t('driver.form.urgency')}</legend>
          <div className="pwa-chip-row">
            {URGENCIES.map((u) => (
              <label key={u} className={cx('cp-chip', d.urgency === u && 'is-selected')}>
                <input type="radio" name="urgency" className="sr-only" checked={d.urgency === u} onChange={() => set({ urgency: u })} />
                {t(`garage.urgency.${u}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="pwa-check">
          <input type="checkbox" checked={d.unsafe} onChange={(e) => set({ unsafe: e.target.checked })} />
          <span className="pwa-text-label">{t('driver.form.unsafe')}</span>
        </label>
        {showSafety ? (
          <SafetyBanner
            title={t(suggestion?.doNotDrive ? 'driver.safety.doNotDrive' : 'driver.safety.title')}
            text={t('driver.safety.text')}
          />
        ) : null}
        <GuidedCheck vehicleId={vehicleId} description={d.description} onSuggestion={setSuggestion} />
        {suggestion?.urgency || suggestion?.areas.length ? (
          <div className="pwa-stack-xs" data-testid="driver-suggestion">
            {suggestion.areas.length ? <p className="m-0">{t('driver.form.likelyArea', { area: suggestion.areas.join('، ') })}</p> : null}
            {suggestion.urgency ? (
              <label className="pwa-check">
                <input type="checkbox" checked={useSuggested} onChange={(e) => setUseSuggested(e.target.checked)} />
                <span>{t('driver.form.useSuggested', { urgency: t(`garage.urgency.${suggestion.urgency}`) })}</span>
              </label>
            ) : null}
            <p className="pwa-text-caption m-0">{t('driver.form.aiLabel')}</p>
          </div>
        ) : null}
        <p className="m-0">
          {t('driver.form.sendsAs')} <Urgency level={urgencyStyle(urgency)} label={t(`garage.urgency.${urgency}`)} />
        </p>
        {online ? (
          <UploadZone
            group={group}
            purpose="issue_photo"
            organizationId={orgId}
            label={t('driver.form.photos')}
            hint={t('driver.form.photosHint')}
          />
        ) : (
          <p className="pwa-text-caption m-0">{t('driver.form.photosOffline')}</p>
        )}
        <TextField
          label={t('driver.form.mileage')}
          inputMode="numeric"
          value={d.mileage}
          onChange={(e) => set({ mileage: e.target.value })}
          hint={t('driver.form.mileageHint')}
          error={errors.includes('mileage') ? t(ERROR_TEXT.mileage) : undefined}
        />
        {formError ? <Banner tone="danger" text={t(formError)} /> : null}
        <div className="pwa-inline-buttons">
          <Button type="submit" variant="primary" icon="send" loading={busy}>
            {t(online ? 'driver.form.submit' : 'driver.form.submitLater')}
          </Button>
          <Button type="button" onClick={saveDraft}>
            {t('driver.form.saveDraft')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              discardGroup(group);
              update((s) => withoutDraft(s, vehicleId));
              router.push(drivePath(locale, orgId, vehicleId));
            }}
          >
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** For the account menu: whether the user drives for a fleet (asked only once the menu opens). */
export function useIsDriver(enabled: boolean): boolean {
  const q = useApiQuery('me.memberships_list', { query: { status: 'active', limit: 50 } }, { staleTime: 5 * 60_000, enabled });
  return !!q.data && driverFleets(q.data.items).length > 0;
}
