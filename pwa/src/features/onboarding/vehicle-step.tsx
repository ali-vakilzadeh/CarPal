'use client';
// W-ONB-01 step 2 "Your first car" (C-ONB-01 on the web). vehicles.create needs brand, model and year, and the VIN
// decoder works on a saved vehicle only (vehicles.vin_decode {V}/{id}, DI-32), so the car is chosen from the list
// (brand → model → series, year) with an optional pasted VIN; after saving, the decoder's suggestions are offered
// ("This VIN suggests 2011; you entered 2012" → Use / Keep, applied with vehicles.update). A VIN already in another
// garage answers 409 DUPLICATE with vin_transfer_available: "Did you buy this car?" asks its owner for a transfer
// (vehicles.transfer_request, BA-04; the owner is never shown). Instead of "Scan VIN", "Continue on your phone" shows a
// QR code that opens this step on the phone.
import type { Vehicle, VehicleWrite } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { Dialog } from '@/components/shell/dialog';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient } from '@/lib/api/query';
import { useBrowserValue } from '@/lib/browser-value';
import { toLatinDigits } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { QrCode } from './qr';
import type { StepProps } from './steps';
import { cleanVin, vinProblem, VIN_LENGTH } from './vin';

export type SavedVehicle = Vehicle;

const FIRST_YEAR = 1950;
const MAX_MILEAGE_KM = 2_000_000;

type Suggested = Partial<Omit<VehicleWrite, 'vin'>>;
type Decode = { state: 'reading' } | { state: 'failed' } | { state: 'none' } | { state: 'suggested'; suggested: Suggested };
type Conflict = null | { kind: 'mine' } | { kind: 'transfer'; vin: string; result?: 'sent' | 'pending' | 'notFound' };

export function VehicleStep({
  saving,
  onNext,
  onSkip,
  saved,
  onSaved,
}: StepProps & { saved: SavedVehicle | null; onSaved: (v: SavedVehicle) => void }) {
  const t = useT();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { setActive } = useActiveVehicle();
  const [vin, setVin] = useState('');
  const [pick, setPick] = useState<VehiclePick>(EMPTY_PICK);
  const [year, setYear] = useState('');
  const [mileage, setMileage] = useState('');
  const [nickname, setNickname] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'vin' | 'pick' | 'year' | 'mileage', MessageKey>>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [decode, setDecode] = useState<Decode>({ state: 'none' });
  const [sheet, setSheet] = useState<'vin' | 'phone' | null>(null);

  const cleaned = cleanVin(vin);

  const runDecode = async (v: Vehicle) => {
    setDecode({ state: 'reading' });
    try {
      const d = await api.api('vehicles.vin_decode', { path: { vehicle_id: v.id } });
      if (d.decode_status === 'failed') return setDecode({ state: 'failed' });
      setDecode({ state: 'suggested', suggested: d.suggested });
    } catch {
      // 503 UNAVAILABLE(decoder) and friends: the chosen details stand (GD-13); no suggestion to show.
      setDecode({ state: 'none' });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setConflict(null);
    const found: typeof errors = {};
    const problem = vinProblem(cleaned);
    if (problem)
      found.vin =
        problem === 'letters'
          ? 'onboarding.vehicle.vinLetters'
          : problem === 'length'
            ? 'onboarding.vehicle.vinLength'
            : 'onboarding.vehicle.vinInvalid';
    if (!pick.brandId || !pick.modelId) found.pick = 'onboarding.vehicle.pickRequired';
    if (!year) found.year = 'onboarding.vehicle.yearRequired';
    const km = mileage.trim() ? Number(toLatinDigits(mileage).replace(/[^\d]/g, '')) : null;
    if (km !== null && (!Number.isInteger(km) || km < 0 || km > MAX_MILEAGE_KM)) found.mileage = 'onboarding.vehicle.mileageInvalid';
    setErrors(found);
    if (Object.keys(found).length) return;

    const body: VehicleWrite = {
      brand_node_id: pick.brandId!,
      model_node_id: pick.modelId!,
      ...(pick.seriesId ? { series_node_id: pick.seriesId } : {}),
      year: Number(year),
      ...(cleaned ? { vin: cleaned } : {}),
      ...(km !== null ? { mileage_km: km } : {}),
      ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
    };
    setBusy(true);
    try {
      const res = await api.call('vehicles.create', { body });
      onSaved(res.data);
      setEtag(res.etag);
      setActive(res.data.id);
      void queryClient.invalidateQueries({ queryKey: apiQueryKey('vehicles.list').slice(0, 1) });
      if (cleaned) void runDecode(res.data);
    } catch (err) {
      if (!(err instanceof ApiProblem)) setFormError('onboarding.saveFailed');
      else if (err.code === 'DUPLICATE')
        setConflict(err.vinTransferAvailable && cleaned ? { kind: 'transfer', vin: cleaned } : { kind: 'mine' });
      else if (err.code === 'VIN_INVALID') setErrors({ vin: 'onboarding.vehicle.vinInvalid' });
      else if (err.code === 'TAXONOMY_MISMATCH') setFormError('onboarding.vehicle.taxonomyMismatch');
      else if (err.code === 'VEHICLE_LIMIT_REACHED' || err.code === 'ENTITLEMENT_REQUIRED') setFormError('onboarding.vehicle.limit');
      else if (err.field('/vin')) setErrors({ vin: 'onboarding.vehicle.vinInvalid' });
      else if (err.field('/year')) setErrors({ year: 'onboarding.vehicle.yearRequired' });
      else setFormError(err.code === 'NETWORK' ? 'auth.errors.network' : 'onboarding.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const apply = async (changes: Suggested) => {
    if (!saved) return;
    try {
      const res = await api.call('vehicles.update', {
        path: { vehicle_id: saved.id },
        body: changes,
        ifMatch: etag ?? `"v${saved.version}"`,
      });
      onSaved(res.data);
      setEtag(res.etag);
      void queryClient.invalidateQueries({ queryKey: apiQueryKey('vehicles.list').slice(0, 1) });
    } catch {
      setFormError('onboarding.saveFailed');
    }
    setDecode({ state: 'none' });
  };

  if (saved)
    return (
      <SavedCar
        vehicle={saved}
        decode={decode}
        error={formError}
        onApply={(c) => void apply(c)}
        onKeep={() => setDecode({ state: 'none' })}
        saving={saving}
        onNext={onNext}
      />
    );

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <p className="pwa-text-body">{t('onboarding.vehicle.intro')}</p>
      <VehiclePicker value={pick} onChange={setPick} />
      {errors.pick ? <FieldError text={t(errors.pick)} /> : null}
      <YearSelect value={year} onChange={setYear} error={errors.year ? t(errors.year) : undefined} />
      <TextField
        label={t('onboarding.vehicle.vin')}
        value={vin}
        onChange={(e) => setVin(e.target.value)}
        onBlur={() => setVin(cleaned)}
        dir="ltr"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={VIN_LENGTH + 8}
        hint={t('onboarding.vehicle.vinHint')}
        error={errors.vin ? t(errors.vin) : undefined}
      />
      <div className="flex flex-wrap gap-3">
        <button type="button" className="pwa-link inline-flex items-center gap-1" onClick={() => setSheet('vin')}>
          <Icon name="help" size={20} />
          {t('onboarding.vehicle.whereVin')}
        </button>
        <button type="button" className="pwa-link inline-flex items-center gap-1" onClick={() => setSheet('phone')}>
          <Icon name="phone" size={20} />
          {t('onboarding.vehicle.phone')}
        </button>
      </div>
      <TextField
        label={t('onboarding.vehicle.mileage')}
        value={mileage}
        onChange={(e) => setMileage(e.target.value)}
        inputMode="numeric"
        end={<span className="pwa-text-caption">{t('onboarding.vehicle.km')}</span>}
        error={errors.mileage ? t(errors.mileage) : undefined}
      />
      <TextField
        label={t('onboarding.vehicle.nickname')}
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder={t('onboarding.vehicle.nicknamePlaceholder')}
        maxLength={60}
      />
      {conflict?.kind === 'mine' ? <Banner tone="warn" text={t('onboarding.vehicle.duplicateMine')} /> : null}
      {conflict?.kind === 'transfer' ? <TransferRequest vin={conflict.vin} onDone={onNext} /> : null}
      {formError ? <Banner tone="danger" text={t(formError)} /> : null}
      <div className="pwa-onb-actions">
        <Button type="submit" variant="primary" loading={busy} disabled={saving}>
          {t('onboarding.vehicle.save')}
        </Button>
        <Button variant="ghost" disabled={busy || saving} onClick={onSkip}>
          {t('onboarding.skip')}
        </Button>
      </div>
      <Dialog name="where-vin" open={sheet === 'vin'} onClose={() => setSheet(null)} title={t('onboarding.vehicle.whereVin')}>
        <p className="pwa-text-body">{t('onboarding.vehicle.whereVinText')}</p>
      </Dialog>
      <Dialog name="on-phone" open={sheet === 'phone'} onClose={() => setSheet(null)} title={t('onboarding.vehicle.phone')}>
        <PhoneHandoff />
      </Dialog>
    </form>
  );
}

function FieldError({ text }: { text: string }) {
  return (
    <p className="cp-field-hint pwa-error-text" role="alert">
      <Icon name="alert" size={16} />
      {text}
    </p>
  );
}

function YearSelect({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const last = new Date().getFullYear() + 1;
  const years = Array.from({ length: last - FIRST_YEAR + 1 }, (_, i) => last - i);
  return (
    <div className={cx('cp-field', !!error && 'is-error')}>
      <label className="cp-field-label" htmlFor={id}>
        {t('onboarding.vehicle.year')}
      </label>
      <div className="cp-field-box pwa-select-box">
        <select
          id={id}
          className="cp-field-input pwa-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-d` : undefined}
        >
          <option value="">{t('onboarding.vehicle.chooseYear')}</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {f.digits(y)}
            </option>
          ))}
        </select>
        <Icon name="down" size={20} />
      </div>
      {error ? (
        <p id={`${id}-d`} className="cp-field-hint">
          <Icon name="alert" size={16} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Continue on your phone": a QR code that opens this step in the app (or the mobile web) on a phone. */
function PhoneHandoff() {
  const t = useT();
  const locale = useLocale();
  const origin = useBrowserValue<string | null>(() => location.origin, null);
  const url = origin ? `${origin}/${locale}/onboarding?step=vehicle` : null;
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="pwa-text-body">{t('onboarding.vehicle.phoneText')}</p>
      {url ? <QrCode value={url} label={t('onboarding.vehicle.qrLabel')} className="pwa-qr" /> : null}
    </div>
  );
}

function TransferRequest({ vin, onDone }: { vin: string; onDone: () => void }) {
  const t = useT();
  const api = useApiClient();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'sent' | 'pending' | 'notFound' | 'error' | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      await api.api('vehicles.transfer_request', { body: { vin, ...(message.trim() ? { message: message.trim() } : {}) } });
      setResult('sent');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'DUPLICATE') setResult('pending');
      else if (err instanceof ApiProblem && err.code === 'REFERENCE_NOT_FOUND') setResult('notFound');
      else setResult('error');
    } finally {
      setBusy(false);
    }
  };
  if (result === 'sent' || result === 'pending')
    return (
      <Banner tone="success" text={t(result === 'sent' ? 'onboarding.vehicle.transferSent' : 'onboarding.vehicle.transferPending')}>
        <div className="pwa-banner-actions">
          <Button size="sm" variant="primary" onClick={onDone}>
            {t('onboarding.next')}
          </Button>
        </div>
      </Banner>
    );
  return (
    <Banner tone="info" icon="car" title={t('onboarding.vehicle.transferTitle')} text={t('onboarding.vehicle.transferText')}>
      <div className="flex flex-col gap-3 pt-2">
        <TextField
          multiline
          label={t('onboarding.vehicle.transferMessage')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={2}
        />
        {result === 'notFound' ? <p className="pwa-text-caption">{t('onboarding.vehicle.transferNotFound')}</p> : null}
        {result === 'error' ? <p className="pwa-text-caption">{t('onboarding.saveFailed')}</p> : null}
        <div>
          <Button size="sm" loading={busy} onClick={() => void send()}>
            {t('onboarding.vehicle.transferSend')}
          </Button>
        </div>
      </div>
    </Banner>
  );
}

function SavedCar({
  vehicle,
  decode,
  error,
  onApply,
  onKeep,
  saving,
  onNext,
}: {
  vehicle: Vehicle;
  decode: Decode;
  error: MessageKey | null;
  onApply: (changes: Suggested) => void;
  onKeep: () => void;
  saving: boolean;
  onNext: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const label = useVehicleLabel(vehicle) ?? '';
  const suggested = decode.state === 'suggested' ? decode.suggested : {};
  const yearDiffers = typeof suggested.year === 'number' && suggested.year !== vehicle.year;
  const others = Object.fromEntries(
    Object.entries(suggested).filter(
      ([k, v]) => k !== 'year' && v !== undefined && v !== (vehicle as unknown as Record<string, unknown>)[k],
    ),
  ) as Suggested;
  return (
    <div className="flex flex-col gap-5">
      <Banner tone="success" text={t('onboarding.vehicle.saved', { vehicle: label })} />
      {decode.state === 'reading' ? (
        <p className="pwa-text-caption" role="status">
          {t('onboarding.vehicle.decoding')}
        </p>
      ) : null}
      {decode.state === 'failed' ? <Banner tone="plain" text={t('onboarding.vehicle.decodeFailed')} /> : null}
      {yearDiffers ? (
        <Banner
          tone="info"
          icon="scan"
          title={t('onboarding.vehicle.suggestYear', { suggested: f.digits(suggested.year!), entered: f.digits(vehicle.year) })}
          text={t('onboarding.vehicle.basis')}
        >
          <div className="pwa-banner-actions">
            <Button size="sm" onClick={() => onApply({ year: suggested.year! })}>
              {t('onboarding.vehicle.useSuggested', { year: f.digits(suggested.year!) })}
            </Button>
            <Button size="sm" variant="ghost" onClick={onKeep}>
              {t('onboarding.vehicle.keepEntered', { year: f.digits(vehicle.year) })}
            </Button>
          </div>
        </Banner>
      ) : null}
      {Object.keys(others).length ? (
        <Banner tone="info" icon="scan" text={t('onboarding.vehicle.suggestOther')}>
          <div className="pwa-banner-actions">
            <Button size="sm" onClick={() => onApply(others)}>
              {t('onboarding.vehicle.applyOther')}
            </Button>
          </div>
        </Banner>
      ) : null}
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <div className="pwa-onb-actions">
        <Button variant="primary" loading={saving} onClick={onNext}>
          {t('onboarding.next')}
        </Button>
      </div>
    </div>
  );
}
