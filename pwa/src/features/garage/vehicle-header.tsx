'use client';
// W-GAR-01 vehicle header (C-GARAGE-02 header, C-GARAGE-08 mileage): photo, nickname, model/series/year, mileage with
// inline edit (Enter saves, Esc cancels; a lower value asks "Mileage went down — correct a typo?" with Fix last entry /
// Save anyway; every save writes a mileage log through vehicles.mileage_add), the masked VIN with Reveal (aal2: a
// step-up sign-in comes back to this page, BA-11; only when vin_present, BA-29), the completeness meter, Edit,
// Status and export, and "Use for search" (the browser's active vehicle, DI-27).
import type { Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { Meter } from '@/components/ds/meter';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { loginUrl } from '@/lib/api/session';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { useMileage, useRefresh } from './hooks';
import { garagePath, mileageDrop, parseMileage } from './model';
import { useModelName, useVehicleTitle } from './names';
import { StatusDialog } from './status-dialog';

export function VehicleHeader({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const title = useVehicleTitle(v);
  const { full } = useModelName(v);
  const { active, setActive } = useActiveVehicle();
  const [statusOpen, setStatusOpen] = useState(false);
  return (
    <header className="pwa-vehicle-header">
      <div className="pwa-vehicle-photo">
        {v.primary_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URL on the media host
          <img src={v.primary_photo_url} alt={t('garage.photoOf', { name: title })} />
        ) : (
          <Icon name="car" size={48} />
        )}
      </div>
      <div className="pwa-vehicle-head-body">
        <div className="pwa-vehicle-head-title">
          <h2 className="pwa-vehicle-name" dir="auto">
            <bdi>{title}</bdi>
          </h2>
          {v.status !== 'active' ? (
            <Badge tone={v.status === 'in_repair' ? 'accent' : 'neutral'}>{t(`garage.status.${v.status}`)}</Badge>
          ) : null}
        </div>
        <p className="pwa-text-caption" dir="auto">
          <bdi>{full}</bdi>
        </p>
        <MileageLine vehicle={v} readOnly={readOnly} />
        {v.vin_present ? <VinLine vehicle={v} /> : null}
        <Meter
          value={v.profile_completeness}
          label={t('garage.completeness')}
          valueText={t('garage.complete', { percent: f.digits(v.profile_completeness) })}
          className="pwa-vehicle-meter"
        />
        <p className="pwa-text-caption">{t('garage.complete', { percent: f.digits(v.profile_completeness) })}</p>
        <div className="pwa-vehicle-head-actions">
          {!readOnly ? (
            <Link href={garagePath(locale, v.id, 'edit')} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <Icon name="edit" size={20} />
              <span className="cp-btn-label">{t('garage.edit')}</span>
            </Link>
          ) : null}
          <Button size="sm" variant="ghost" icon="sliders" onClick={() => setStatusOpen(true)}>
            {t('garage.statusAndExport')}
          </Button>
          {!readOnly && active?.id !== v.id ? (
            <Button size="sm" variant="ghost" icon="car" onClick={() => setActive(v.id)}>
              {t('garage.useForSearch')}
            </Button>
          ) : null}
        </div>
      </div>
      <StatusDialog vehicle={v} open={statusOpen} onClose={() => setStatusOpen(false)} />
    </header>
  );
}

function MileageLine({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const log = useMileage(v.id);
  const last = log.data?.items[0];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmLower, setConfirmLower] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const start = () => {
    setValue(v.mileage_km !== undefined ? String(v.mileage_km) : '');
    setError(null);
    setConfirmLower(false);
    setEditing(true);
  };

  const save = async (anyway = false) => {
    const km = parseMileage(value);
    if (km === null) return setError(t('garage.mileage.invalid'));
    if (!anyway && mileageDrop(v.mileage_km, km)) return setConfirmLower(true);
    setBusy(true);
    try {
      await api.api('vehicles.mileage_add', {
        path: { vehicle_id: v.id },
        body: { mileage_km: km, recorded_at: new Date().toISOString() },
      });
      await refresh('vehicles.get', 'vehicles.list', 'vehicles.mileage_list');
      setEditing(false);
      toast(t('garage.mileage.saved'));
    } catch (err) {
      setError(t(err instanceof ApiProblem && err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  };

  if (!editing)
    return (
      <p className="pwa-mileage-line">
        <Icon name="gauge" size={20} />
        <span>
          {v.mileage_km !== undefined ? t('garage.mileageValue', { km: f.number(v.mileage_km) }) : t('garage.mileage.none')}
          {last ? <span className="pwa-text-caption"> · {t('garage.mileage.updated', { when: f.relative(last.recorded_at) })}</span> : null}
        </span>
        {!readOnly ? (
          <Button size="sm" variant="ghost" icon="edit" onClick={start}>
            {t('garage.mileage.update')}
          </Button>
        ) : null}
      </p>
    );

  return (
    <div className="pwa-mileage-edit">
      <div className="cp-field">
        <label className="cp-field-label" htmlFor={`mileage-${v.id}`}>
          {t('garage.mileage.new')}
        </label>
        <div className="cp-field-box">
          <input
            ref={input}
            id={`mileage-${v.id}`}
            className="cp-field-input"
            inputMode="numeric"
            dir="ltr"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setConfirmLower(false);
              setError(null);
            }}
            onKeyDown={onKey}
            aria-invalid={error ? true : undefined}
            aria-describedby={`mileage-${v.id}-hint`}
          />
          <span className="pwa-text-caption">{t('garage.km')}</span>
        </div>
        <p id={`mileage-${v.id}-hint`} className="cp-field-hint">
          {error ?? (v.mileage_km !== undefined ? t('garage.mileage.last', { km: f.number(v.mileage_km) }) : t('garage.mileage.enterHint'))}
        </p>
      </div>
      {confirmLower ? (
        <Banner tone="warn" title={t('garage.mileage.lowerTitle')} text={t('garage.mileage.lowerText')}>
          <div className="pwa-banner-actions">
            <Button size="sm" variant="secondary" onClick={() => input.current?.focus()}>
              {t('garage.mileage.fix')}
            </Button>
            <Button size="sm" loading={busy} onClick={() => void save(true)}>
              {t('garage.mileage.saveAnyway')}
            </Button>
          </div>
        </Banner>
      ) : null}
      <div className="pwa-inline-buttons">
        <Button size="sm" variant="primary" loading={busy && !confirmLower} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}

function VinLine({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const api = useApiClient();
  const [vin, setVin] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');

  // Revealed VINs hide again after a minute.
  useEffect(() => {
    if (!vin) return;
    const timer = setTimeout(() => setVin(null), 60_000);
    return () => clearTimeout(timer);
  }, [vin]);

  const reveal = async () => {
    setState('busy');
    try {
      setVin((await api.api('vehicles.vin_reveal', { path: { vehicle_id: v.id } })).vin);
      setState('idle');
    } catch (err) {
      if (err instanceof ApiProblem && err.stepUp) {
        // aal2 (Docs/40 vehicles.vin_reveal): confirm it is you, then come back here.
        location.assign(loginUrl({ stepUp: err.stepUp.acrValues }));
        return;
      }
      setState('failed');
    }
  };

  return (
    <p className="pwa-vin-line">
      <span className="pwa-text-caption">{t('garage.vin')}</span>{' '}
      <bdi className="pwa-vin" dir="ltr" data-testid="vin">
        {vin ?? `•••••••••••••${v.vin_last4 ?? '••••'}`}
      </bdi>
      {vin ? (
        <Button size="sm" variant="ghost" icon="eye" onClick={() => setVin(null)}>
          {t('garage.vinHide')}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" icon="lock" loading={state === 'busy'} onClick={() => void reveal()}>
          {t('garage.vinReveal')}
        </Button>
      )}
      {state === 'failed' ? <span className="pwa-text-caption pwa-error-text">{t('garage.vinFailed')}</span> : null}
    </p>
  );
}
