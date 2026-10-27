'use client';
// W-GAR-01 My Garage (mirrors C-GARAGE-01/02/06/08/09): master–detail at /<locale>/garage/<vehicle-id>/<tab>. Left
// (300 px from 1024 px wide): the plan line, ownership requests, the vehicle list with status chips and the collapsed
// Sold & inactive group, Add vehicle (the plan-limit modal at the limit). Right: the selected vehicle — header with
// photo, names, inline mileage, VIN, completeness and actions — and the tabs Overview · Service History · Issues ·
// Documents · Reminders as URL routes. /<locale>/garage alone opens the browser's active vehicle (DI-27), or the
// empty state. Phones stack the list above the detail.
import type { Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard, SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { DocumentsTab } from './documents-tab';
import { HistoryTab } from './history-tab';
import { useSubscription, useVehicle, useVehicles } from './hooks';
import { IssuesTab } from './issues-tab';
import { garagePath, groupVehicles, planLine, recordPath, TABS, vehicleChips, type GarageTab, type VehicleChip } from './model';
import { useVehicleTitle, useModelName } from './names';
import { OverviewTab } from './overview-tab';
import { PlanLimitDialog } from './plan-limit';
import { RemindersTab } from './reminders-tab';
import { OwnershipRequests } from './transfers';
import { VehicleHeader } from './vehicle-header';

const TAB_LABEL: Record<GarageTab, MessageKey> = {
  overview: 'garage.tabs.overview',
  history: 'garage.tabs.history',
  issues: 'garage.tabs.issues',
  documents: 'garage.tabs.documents',
  reminders: 'garage.tabs.reminders',
};

const CHIP: Record<
  VehicleChip,
  { label: MessageKey; tone: 'signal' | 'danger' | 'neutral' | 'accent'; icon: 'alert' | 'wrench' | 'calendar' }
> = {
  safetyIssue: { label: 'garage.chip.safety', tone: 'danger', icon: 'alert' },
  openIssue: { label: 'garage.chip.openIssue', tone: 'signal', icon: 'alert' },
  serviceDue: { label: 'garage.chip.serviceDue', tone: 'neutral', icon: 'calendar' },
  inRepair: { label: 'garage.chip.inRepair', tone: 'accent', icon: 'wrench' },
};

export function GarageScreen({ vehicleId, tab }: { vehicleId: string | null; tab: GarageTab }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const vehicles = useVehicles();
  const { active } = useActiveVehicle();
  const list = useMemo(() => vehicles.data?.items ?? [], [vehicles.data]);

  // /garage → the active vehicle's page (or the first one).
  useEffect(() => {
    if (vehicleId || !vehicles.data) return;
    const target = active ?? groupVehicles(list).inUse[0] ?? list[0];
    if (target) router.replace(garagePath(locale, target.id, 'overview'));
  }, [vehicleId, vehicles.data, active, list, locale, router]);

  return (
    <div className="pwa-wide-page pwa-garage">
      <aside className="pwa-garage-master" aria-labelledby="garage-title">
        <MasterHeader vehicles={list} />
        <OwnershipRequests />
        {vehicles.isPending ? (
          <SkeletonList count={2} label={t('garage.loading')} />
        ) : vehicles.isError ? (
          <ErrorState error={vehicles.error} onRetry={() => void vehicles.refetch()} compact />
        ) : (
          <VehicleList vehicles={list} selected={vehicleId} />
        )}
      </aside>
      <section className="pwa-garage-detail" aria-label={t('garage.detailLabel')}>
        {vehicleId ? (
          <VehicleDetail vehicleId={vehicleId} tab={tab} />
        ) : vehicles.data && list.length === 0 ? (
          <EmptyGarage />
        ) : (
          <SkeletonCard lines={5} />
        )}
      </section>
    </div>
  );
}

function MasterHeader({ vehicles }: { vehicles: readonly Vehicle[] }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const sub = useSubscription();
  const plan = planLine(sub.data, vehicles);
  const [limitOpen, setLimitOpen] = useState(false);
  const free = sub.data?.plan.plan_key === 'individual_free';
  return (
    <div className="pwa-garage-master-head">
      <h1 id="garage-title" className="pwa-garage-title">
        {t('shell.nav.garage')}
      </h1>
      {plan.max !== null ? (
        <p className="pwa-text-caption" data-testid="plan-line">
          {t(free ? 'garage.plan.lineFree' : 'garage.plan.line', { used: f.digits(plan.used), max: f.digits(plan.max) })}
        </p>
      ) : null}
      {plan.atLimit ? (
        <Button variant="secondary" icon="plus" block onClick={() => setLimitOpen(true)}>
          {t('garage.addVehicle')}
        </Button>
      ) : (
        <Link href={`/${locale}/garage/add`} className={buttonClass({ variant: 'secondary', block: true })}>
          <Icon name="plus" size={20} />
          <span className="cp-btn-label">{t('garage.addVehicle')}</span>
        </Link>
      )}
      <PlanLimitDialog
        open={limitOpen}
        onClose={() => setLimitOpen(false)}
        onFreed={() => {
          setLimitOpen(false);
          router.push(`/${locale}/garage/add`);
        }}
      />
    </div>
  );
}

function VehicleList({ vehicles, selected }: { vehicles: readonly Vehicle[]; selected: string | null }) {
  const t = useT();
  const f = useFormat();
  const { inUse, parked } = groupVehicles(vehicles);
  return (
    <nav aria-label={t('garage.listLabel')}>
      <ul className="pwa-vehicle-list">
        {inUse.map((v) => (
          <VehicleCard key={v.id} vehicle={v} selected={v.id === selected} />
        ))}
      </ul>
      {parked.length > 0 ? (
        <details className="pwa-parked" open={parked.some((v) => v.id === selected)}>
          <summary className="pwa-parked-summary">{t('garage.parked', { count: parked.length, n: f.digits(parked.length) })}</summary>
          <ul className="pwa-vehicle-list">
            {parked.map((v) => (
              <VehicleCard key={v.id} vehicle={v} selected={v.id === selected} />
            ))}
          </ul>
        </details>
      ) : null}
    </nav>
  );
}

function VehicleCard({ vehicle: v, selected }: { vehicle: Vehicle; selected: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const title = useVehicleTitle(v);
  const { full } = useModelName(v);
  const chips = vehicleChips(v, todayIso(f.timeZone));
  return (
    <li>
      <Link
        href={garagePath(locale, v.id, 'overview')}
        className={cx('pwa-vehicle-card', selected && 'is-selected')}
        aria-current={selected ? 'page' : undefined}
      >
        <span className="pwa-vehicle-thumb" aria-hidden="true">
          {v.primary_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed URL on the media host
            <img src={v.primary_photo_url} alt="" />
          ) : (
            <Icon name="car" size={28} />
          )}
        </span>
        <span className="pwa-vehicle-card-body">
          <span className="pwa-vehicle-card-title" dir="auto">
            <bdi>{title}</bdi>
          </span>
          <span className="pwa-text-caption" dir="auto">
            <bdi>{full}</bdi>
          </span>
          {v.mileage_km !== undefined ? (
            <span className="pwa-text-caption">{t('garage.mileageValue', { km: f.number(v.mileage_km) })}</span>
          ) : null}
          {chips.length > 0 || v.status === 'sold' || v.status === 'inactive' ? (
            <span className="pwa-vehicle-chips">
              {v.status === 'sold' || v.status === 'inactive' || v.status === 'archived' ? (
                <Badge tone="neutral">{t(`garage.status.${v.status}`)}</Badge>
              ) : null}
              {chips.map((c) => (
                <Badge key={c} tone={CHIP[c].tone} icon={CHIP[c].icon}>
                  {c === 'openIssue'
                    ? t('garage.chip.openIssues', { count: v.open_issue_count, n: f.digits(v.open_issue_count) })
                    : t(CHIP[c].label)}
                </Badge>
              ))}
            </span>
          ) : null}
          {v.profile_completeness < 100 && (v.status === 'active' || v.status === 'in_repair') ? (
            <span className="pwa-text-caption">{t('garage.complete', { percent: f.digits(v.profile_completeness) })}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function EmptyGarage() {
  const t = useT();
  const locale = useLocale();
  return (
    <StateView
      kind="empty"
      t={t}
      title={t('garage.empty.title')}
      text={t('garage.empty.text')}
      action={
        <Link href={`/${locale}/garage/add`} className={buttonClass({ variant: 'primary' })}>
          <Icon name="plus" size={20} />
          <span className="cp-btn-label">{t('garage.addVehicle')}</span>
        </Link>
      }
    />
  );
}

function VehicleDetail({ vehicleId, tab }: { vehicleId: string; tab: GarageTab }) {
  const t = useT();
  const locale = useLocale();
  const vehicle = useVehicle(vehicleId);
  if (vehicle.isPending) return <SkeletonCard lines={6} />;
  if (vehicle.isError) {
    const kind = stateFromProblem(vehicle.error);
    if (kind === 'notFound')
      return (
        <StateView
          kind="notFound"
          t={t}
          title={t('garage.notFound')}
          action={
            <Link href={`/${locale}/garage`} className={buttonClass({ variant: 'secondary' })}>
              <span className="cp-btn-label">{t('garage.backToGarage')}</span>
            </Link>
          }
        />
      );
    return <ErrorState error={vehicle.error} onRetry={() => void vehicle.refetch()} />;
  }
  const v = vehicle.data;
  const readOnly = v.status === 'sold' || v.status === 'inactive' || v.status === 'archived';
  return (
    <div className="pwa-vehicle-detail">
      <VehicleHeader vehicle={v} readOnly={readOnly} />
      {readOnly ? <Banner tone="plain" icon="lock" text={t('garage.readOnly')} /> : <QuickActions vehicle={v} />}
      <nav className="pwa-garage-tabs" aria-label={t('garage.tabs.label')}>
        {TABS.map((id) => (
          <Link
            key={id}
            href={garagePath(locale, v.id, id)}
            className={cx('pwa-garage-tab', id === tab && 'is-active')}
            aria-current={id === tab ? 'page' : undefined}
            scroll={false}
          >
            {t(TAB_LABEL[id])}
          </Link>
        ))}
      </nav>
      <div className="pwa-garage-panel">
        {tab === 'overview' ? <OverviewTab vehicle={v} readOnly={readOnly} /> : null}
        {tab === 'history' ? <HistoryTab vehicle={v} readOnly={readOnly} /> : null}
        {tab === 'issues' ? <IssuesTab vehicle={v} readOnly={readOnly} /> : null}
        {tab === 'documents' ? <DocumentsTab vehicle={v} readOnly={readOnly} /> : null}
        {tab === 'reminders' ? <RemindersTab vehicle={v} readOnly={readOnly} /> : null}
      </div>
    </div>
  );
}

/** Report an issue · Add record · Add document · Book service (C-GARAGE-02). */
function QuickActions({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const locale = useLocale();
  const { setActive } = useActiveVehicle();
  const link = (href: string, icon: 'alert' | 'plus' | 'doc' | 'calendar', label: MessageKey, onClick?: () => void) => (
    <Link href={href} className={buttonClass({ variant: 'secondary', size: 'sm' })} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span className="cp-btn-label">{t(label)}</span>
    </Link>
  );
  return (
    <div className="pwa-quick-actions" role="group" aria-label={t('garage.quick.label')}>
      {link(`${garagePath(locale, v.id, 'issues')}?modal=issue-add`, 'alert', 'garage.quick.reportIssue')}
      {link(recordPath(locale, v.id, 'new'), 'plus', 'garage.quick.addRecord')}
      {link(`${garagePath(locale, v.id, 'documents')}?modal=document-add`, 'doc', 'garage.quick.addDocument')}
      {link(`/${locale}/search`, 'calendar', 'garage.quick.bookService', () => setActive(v.id))}
    </div>
  );
}
