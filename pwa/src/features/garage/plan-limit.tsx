'use client';
// C-PLAN-01 Vehicle Limit (W-GAR-03: "at the 6th active vehicle the limit panel opens in a modal and keeps the entered
// data"). Opens on Add vehicle at the limit and on 409 VEHICLE_LIMIT_REACHED from vehicles.create / status_change
// (the server enforces ENT(max_vehicles); this only explains it). Lists the vehicles in use, each with Mark as sold /
// Mark as inactive; freeing a slot calls onFreed, so the form that opened it can save again with its data intact.
// "Manage a company fleet instead?" explains fleet plans (set up on the web portal). "Contact us" is left out until a
// support channel exists (OQ-18).
import type { Vehicle } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { useRefresh, useSubscription, useVehicles, VEHICLE_OPS } from './hooks';
import { countsTowardLimit, planLine } from './model';
import { useModelName, useVehicleTitle } from './names';

export function PlanLimitDialog({
  open,
  onClose,
  onFreed,
  exceptId,
}: {
  open: boolean;
  onClose: () => void;
  onFreed: () => void;
  exceptId?: string;
}) {
  const t = useT();
  const f = useFormat();
  const vehicles = useVehicles();
  const sub = useSubscription();
  const list = (vehicles.data?.items ?? []).filter((v) => countsTowardLimit(v) && v.id !== exceptId);
  const plan = planLine(sub.data, vehicles.data?.items ?? []);
  return (
    <Dialog name="plan-limit" open={open} onClose={onClose} title={t('garage.limit.title')}>
      <p className="pwa-text-body">{t('garage.limit.text', { max: f.digits(plan.max ?? 5) })}</p>
      <p className="pwa-text-caption">{t('garage.limit.hint')}</p>
      <ul className="pwa-plain-list" aria-label={t('garage.limit.listLabel')}>
        {list.map((v) => (
          <LimitRow key={v.id} vehicle={v} onFreed={onFreed} />
        ))}
      </ul>
      <Banner tone="plain" icon="truck" title={t('garage.limit.fleetTitle')} text={t('garage.limit.fleetText')} />
    </Dialog>
  );
}

function LimitRow({ vehicle: v, onFreed }: { vehicle: Vehicle; onFreed: () => void }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const title = useVehicleTitle(v);
  const { full } = useModelName(v);
  const [busy, setBusy] = useState<'sold' | 'inactive' | null>(null);
  const [failed, setFailed] = useState(false);
  const set = async (status: 'sold' | 'inactive') => {
    setBusy(status);
    setFailed(false);
    try {
      await api.api('vehicles.status_change', { path: { vehicle_id: v.id }, body: { status } });
      await refresh(...VEHICLE_OPS);
      toast(t('garage.limit.freed'));
      onFreed();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="pwa-limit-row">
      <span className="pwa-limit-name" dir="auto">
        <bdi>{title}</bdi>
        <span className="pwa-text-caption">
          <bdi>{full}</bdi>
        </span>
      </span>
      <span className="pwa-inline-buttons">
        <Button size="sm" variant="secondary" loading={busy === 'sold'} disabled={!!busy} onClick={() => void set('sold')}>
          {t('garage.limit.markSold')}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'inactive'} disabled={!!busy} onClick={() => void set('inactive')}>
          {t('garage.limit.markInactive')}
        </Button>
      </span>
      {failed ? <span className="pwa-text-caption pwa-error-text">{t('garage.saveFailed')}</span> : null}
    </li>
  );
}
