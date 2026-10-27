'use client';
// C-GARAGE-09 Vehicle Status and Export (web: a dialog from the vehicle header). Status: Active (counts toward the
// plan), Inactive (frees a slot), Sold (frees a slot, history kept) through vehicles.status_change; going back to
// Active at the limit answers 409 VEHICLE_LIMIT_REACHED (the plan-limit panel). Export: the buyer-friendly print view
// (with or without costs) or the full data as a JSON file built in the browser from the vehicle's records.
// "Shared consents for this car": the active consents scoped to this vehicle, each withdrawable (SEC-AZ-8: takes
// effect on the next request).
import type { ConsentRecord, ServiceRecord, Vehicle, VehicleStatus } from '@carpal/api-contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { cx } from '@/components/ds/cx';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { PAGE, useRefresh, VEHICLE_OPS } from './hooks';
import { garagePath, STATUS_CHOICES } from './model';
import { useVehicleTitle } from './names';
import { PlanLimitDialog } from './plan-limit';

const STATUS_TEXT: Record<(typeof STATUS_CHOICES)[number], MessageKey> = {
  active: 'garage.statusDialog.activeText',
  inactive: 'garage.statusDialog.inactiveText',
  sold: 'garage.statusDialog.soldText',
};

export function StatusDialog({ vehicle: v, open, onClose }: { vehicle: Vehicle; open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const title = useVehicleTitle(v);
  const current: VehicleStatus = v.status === 'in_repair' ? 'active' : v.status;
  const [status, setStatus] = useState<VehicleStatus>(current);
  const [confirmSold, setConfirmSold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [limit, setLimit] = useState(false);
  const [costs, setCosts] = useState(true);
  const [exporting, setExporting] = useState(false);

  const save = async () => {
    if (status === current) return onClose();
    if (status === 'sold' && !confirmSold) return setConfirmSold(true);
    setBusy(true);
    setError(null);
    try {
      await api.api('vehicles.status_change', { path: { vehicle_id: v.id }, body: { status } });
      await refresh(...VEHICLE_OPS);
      toast(t('garage.statusDialog.saved'));
      setConfirmSold(false);
      onClose();
    } catch (err) {
      if (err instanceof ApiProblem && (err.code === 'VEHICLE_LIMIT_REACHED' || err.code === 'ENTITLEMENT_REQUIRED')) setLimit(true);
      else setError(err instanceof ApiProblem && err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const records: ServiceRecord[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: ServiceRecord[]; next_cursor: string | null } = await api.api('service_records.list', {
          path: { vehicle_id: v.id },
          query: { limit: PAGE, ...(cursor ? { cursor } : {}) },
        });
        records.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor && records.length < 1000);
      const data = { exported_at: new Date().toISOString(), vehicle: v, service_records: costs ? records : records.map(withoutCosts) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `carpal-${v.id}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('garage.statusDialog.exportFailed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog
      name="vehicle-status"
      open={open}
      onClose={onClose}
      title={t('garage.statusAndExport')}
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('garage.statusDialog.save')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </>
      }
    >
      <fieldset className="pwa-choice-list">
        <legend className="cp-field-label">{t('garage.statusDialog.status')}</legend>
        {STATUS_CHOICES.map((s) => (
          <label key={s} className={cx('pwa-choice', status === s && 'is-selected')}>
            <input
              type="radio"
              name={`status-${v.id}`}
              value={s}
              checked={status === s}
              onChange={() => {
                setStatus(s);
                setConfirmSold(false);
              }}
            />
            <span>
              <span className="pwa-choice-title">{t(`garage.status.${s}`)}</span>
              <span className="pwa-text-caption">{t(STATUS_TEXT[s])}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {confirmSold ? (
        <Banner
          tone="warn"
          title={t('garage.statusDialog.soldConfirmTitle', { name: title })}
          text={t('garage.statusDialog.soldConfirmText', { name: title })}
        />
      ) : null}
      {error ? <Banner tone="danger" text={t(error)} /> : null}

      <section className="flex flex-col gap-3" aria-labelledby={`export-${v.id}`}>
        <h3 id={`export-${v.id}`} className="pwa-section-title">
          {t('garage.export.title')}
        </h3>
        <Check checked={costs} onChange={(e) => setCosts(e.target.checked)}>
          {t('garage.export.includeCosts')}
        </Check>
        <div className="pwa-inline-buttons">
          <Button
            size="sm"
            variant="secondary"
            icon="doc"
            onClick={() => router.push(`${garagePath(locale, v.id, 'print')}${costs ? '' : '?costs=0'}`)}
          >
            {t('garage.export.pdf')}
          </Button>
          <Button size="sm" variant="ghost" icon="download" loading={exporting} onClick={() => void exportData()}>
            {t('garage.export.data')}
          </Button>
        </div>
        <p className="pwa-text-caption">{t('garage.export.hint')}</p>
      </section>

      <SharedConsents vehicle={v} />
      <PlanLimitDialog open={limit} onClose={() => setLimit(false)} onFreed={() => setLimit(false)} exceptId={v.id} />
    </Dialog>
  );
}

function withoutCosts(r: ServiceRecord): Omit<ServiceRecord, 'cost' | 'cost_breakdown'> {
  const copy: Partial<ServiceRecord> = { ...r };
  delete copy.cost;
  delete copy.cost_breakdown;
  return copy as Omit<ServiceRecord, 'cost' | 'cost_breakdown'>;
}

function SharedConsents({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const consents = useApiQuery('consents.list', { query: { active: true, limit: PAGE } });
  const [busy, setBusy] = useState<string | null>(null);
  const mine = (consents.data?.items ?? []).filter(
    (c: ConsentRecord) => c.scope_entity_type === 'vehicle' && c.scope_entity_id === v.id && c.granted,
  );
  if (mine.length === 0) return null;
  const withdraw = async (c: ConsentRecord) => {
    setBusy(c.id);
    try {
      await api.api('consents.withdraw', { path: { consent_id: c.id } });
      await consents.refetch();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`consents-${v.id}`}>
      <h3 id={`consents-${v.id}`} className="pwa-section-title">
        {t('garage.consents.title')}
      </h3>
      <ul className="pwa-plain-list">
        {mine.map((c) => (
          <li key={c.id} className="pwa-row">
            <span className="flex-1">
              {t('garage.consents.item', { type: c.consent_type.replaceAll('_', ' ') })}
              {c.granted_at ? <span className="pwa-text-caption"> · {f.date(c.granted_at)}</span> : null}
            </span>
            <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => void withdraw(c)}>
              {t('garage.consents.withdraw')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
