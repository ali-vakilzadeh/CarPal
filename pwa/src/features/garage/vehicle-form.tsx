'use client';
// W-GAR-03 Add / Edit Vehicle (C-GARAGE-03, C-PLAN-01): one page in two columns — the form on the left (VIN first,
// then the car and its details with "From VIN" / "You entered" tags), the live card preview with the completeness
// meter and "Scan on your phone" on the right (one column on phones). The decoder works on a saved car only
// (vehicles.vin_decode, DI-32): adding a car with a VIN saves it and opens its edit page with the decoder's
// suggestions (?decode=1); "Read details from VIN" on the edit page does the same. Applying a suggestion tags the field
// "From VIN"; editing it again makes it "You entered". A new VIN on an existing car asks "Re-decode and replace
// fields?" after saving. Add at the plan's limit → the C-PLAN-01 modal (server 409 VEHICLE_LIMIT_REACHED) and the
// entered data stays. A VIN in another garage (409 DUPLICATE + vin_transfer_available) → "Did you buy this car?"
// (BA-04). Edits send If-Match; 412 → reload without losing input. Leaving with changes asks first.
import type { Vehicle, VehicleWrite, VinDecodeResult } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { Meter } from '@/components/ds/meter';
import { TextField } from '@/components/ds/text-field';
import { DateField } from '@/components/fields/date-field';
import { SelectField } from '@/components/fields/select-field';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard } from '@/components/shell/skeleton';
import { useToast } from '@/components/shell/toast';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { discardGroup, releaseGroup, UploadZone, useUploads, whenReady } from '@/features/media';
import { cleanVin, QrCode, vinProblem, VIN_LENGTH } from '@/features/onboarding';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useBrowserValue } from '@/lib/browser-value';
import { todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useRefresh, useVehicle, VEHICLE_OPS } from './hooks';
import { completenessEstimate, garagePath, parseMileage } from './model';
import { useModelName, useNodeNames } from './names';
import { PlanLimitDialog } from './plan-limit';
import { TransferAsk } from './transfers';

const TRANSMISSIONS = ['manual', 'automatic', 'cvt', 'dct', 'other'] as const;
const DRIVETRAINS = ['fwd', 'rwd', 'awd', '4wd'] as const;
const BODIES = ['sedan', 'hatchback', 'wagon', 'coupe', 'convertible', 'suv', 'pickup', 'van', 'minivan', 'other'] as const;
const FIRST_YEAR = 1950;

interface Form {
  vin: string;
  pick: VehiclePick;
  year: string;
  engine: string;
  fuel: string;
  transmission: string;
  drivetrain: string;
  body: string;
  color: string;
  plate: string;
  nickname: string;
  mileage: string;
  ownedSince: string;
  notes: string;
}

type Field = keyof Form | 'brand';
type Source = 'vin' | 'user';

function fromVehicle(v: Vehicle | null): Form {
  return {
    vin: '',
    pick: v ? { brandId: v.brand_node_id, modelId: v.model_node_id, seriesId: v.series_node_id ?? null } : EMPTY_PICK,
    year: v ? String(v.year) : '',
    engine: v?.engine_type_node_id ?? '',
    fuel: v?.fuel_type_node_id ?? '',
    transmission: v?.transmission ?? '',
    drivetrain: v?.drivetrain ?? '',
    body: v?.body_style ?? '',
    color: v?.color ?? '',
    plate: v?.license_plate ?? '',
    nickname: v?.nickname ?? '',
    mileage: v?.mileage_km !== undefined ? String(v.mileage_km) : '',
    ownedSince: v?.ownership_start_date ?? '',
    notes: v?.notes ?? '',
  };
}

export function VehicleFormScreen({ vehicleId }: { vehicleId: string | null }) {
  const vehicle = useVehicle(vehicleId);
  if (vehicleId && vehicle.isPending) return <SkeletonCard lines={8} />;
  if (vehicleId && vehicle.isError) return <ErrorState error={vehicle.error} onRetry={() => void vehicle.refetch()} />;
  return <VehicleForm key={vehicleId ?? 'new'} vehicle={vehicle.data ?? null} onReload={() => vehicle.refetch()} />;
}

function VehicleForm({ vehicle, onReload }: { vehicle: Vehicle | null; onReload: () => Promise<unknown> }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const { setActive } = useActiveVehicle();
  const editing = !!vehicle;
  const group = `vehicle-photo:${vehicle?.id ?? 'new'}`;
  const photos = useUploads(group);
  const photo = photos.find((u) => u.state.phase !== 'failed') ?? null;
  const [form, setForm] = useState<Form>(() => fromVehicle(vehicle));
  const [sources, setSources] = useState<Partial<Record<Field, Source>>>({});
  const [errors, setErrors] = useState<Partial<Record<'vin' | 'pick' | 'year' | 'mileage', MessageKey>>>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(false);
  const [freed, setFreed] = useState(false);
  const [conflict, setConflict] = useState<'none' | 'stale' | 'reloaded'>('none');
  const [duplicate, setDuplicate] = useState<null | { transfer: boolean; vin: string }>(null);
  // Opened right after adding a car with a VIN: its details are read once (?decode=1).
  const decodeOnOpen = search.get('decode') === '1' && !!vehicle?.vin_present;
  const [decode, setDecode] = useState<DecodeState>(() => (decodeOnOpen ? { state: 'reading' } : { state: 'idle' }));
  const [touched, setTouched] = useState(false);
  const [askRedecode, setAskRedecode] = useState(false);
  const [phone, setPhone] = useState(false);
  const dirty = useRef(false);

  const set = <K extends keyof Form>(k: K, value: Form[K]) => {
    dirty.current = true;
    setTouched(true);
    setForm((cur) => ({ ...cur, [k]: value }));
    setSources((s) => (s[k] ? { ...s, [k]: 'user' } : s));
  };

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  const runDecode = async (v: Vehicle) => {
    setDecode({ state: 'reading' });
    setDecode(await readVin(api, v.id));
  };

  useEffect(() => {
    if (!vehicle || !decodeOnOpen) return;
    let stop = false;
    void readVin(api, vehicle.id).then((d) => !stop && setDecode(d));
    return () => {
      stop = true;
    };
  }, [api, vehicle, decodeOnOpen]);

  const differences = useMemo(() => {
    if (decode.state !== 'suggested') return [];
    const s = decode.result.suggested;
    const out: { field: Field; apply: (f: Form) => Form }[] = [];
    const cmp = (field: Field, value: string | undefined, current: string, apply: (f: Form) => Form) => {
      if (value !== undefined && value !== '' && value !== current) out.push({ field, apply });
    };
    cmp('brand', s.brand_node_id, form.pick.brandId ?? '', (x) => ({
      ...x,
      pick: { brandId: s.brand_node_id!, modelId: s.model_node_id ?? null, seriesId: s.series_node_id ?? null },
    }));
    if (s.brand_node_id === undefined || s.brand_node_id === form.pick.brandId)
      cmp('pick', s.model_node_id ?? s.series_node_id, (s.model_node_id ? form.pick.modelId : form.pick.seriesId) ?? '', (x) => ({
        ...x,
        pick: { ...x.pick, ...(s.model_node_id ? { modelId: s.model_node_id } : {}), seriesId: s.series_node_id ?? x.pick.seriesId },
      }));
    cmp('year', s.year !== undefined ? String(s.year) : undefined, form.year, (x) => ({ ...x, year: String(s.year) }));
    cmp('engine', s.engine_type_node_id, form.engine, (x) => ({ ...x, engine: s.engine_type_node_id! }));
    cmp('fuel', s.fuel_type_node_id, form.fuel, (x) => ({ ...x, fuel: s.fuel_type_node_id! }));
    cmp('transmission', s.transmission, form.transmission, (x) => ({ ...x, transmission: s.transmission! }));
    cmp('drivetrain', s.drivetrain, form.drivetrain, (x) => ({ ...x, drivetrain: s.drivetrain! }));
    cmp('body', s.body_style, form.body, (x) => ({ ...x, body: s.body_style! }));
    cmp('color', s.color, form.color, (x) => ({ ...x, color: s.color! }));
    return out;
  }, [decode, form]);

  const applyDecoded = () => {
    dirty.current = true;
    setForm((cur) => differences.reduce((acc, d) => d.apply(acc), cur));
    setSources((s) => ({ ...s, ...Object.fromEntries(differences.map((d) => [d.field, 'vin'])) }));
    setDecode({ state: 'idle' });
  };

  const body = (): VehicleWrite | null => {
    const e: typeof errors = {};
    const vin = cleanVin(form.vin);
    const vp = vinProblem(vin);
    if (vp)
      e.vin =
        vp === 'letters'
          ? 'onboarding.vehicle.vinLetters'
          : vp === 'length'
            ? 'onboarding.vehicle.vinLength'
            : 'onboarding.vehicle.vinInvalid';
    if (!form.pick.brandId || !form.pick.modelId) e.pick = 'onboarding.vehicle.pickRequired';
    if (!form.year) e.year = 'onboarding.vehicle.yearRequired';
    const km = form.mileage.trim() ? parseMileage(form.mileage) : null;
    if (!editing && form.mileage.trim() && km === null) e.mileage = 'garage.mileage.invalid';
    setErrors(e);
    if (Object.keys(e).length) return null;
    const opt = <T,>(value: T | '', key: string) => (value === '' ? {} : { [key]: value });
    return {
      brand_node_id: form.pick.brandId!,
      model_node_id: form.pick.modelId!,
      ...(form.pick.seriesId ? { series_node_id: form.pick.seriesId } : {}),
      year: Number(form.year),
      ...(vin ? { vin } : {}),
      ...opt(form.engine, 'engine_type_node_id'),
      ...opt(form.fuel, 'fuel_type_node_id'),
      ...opt(form.transmission, 'transmission'),
      ...opt(form.drivetrain, 'drivetrain'),
      ...opt(form.body, 'body_style'),
      ...opt(form.color.trim().slice(0, 50), 'color'),
      ...opt(form.plate.trim().slice(0, 20), 'license_plate'),
      ...opt(form.nickname.trim().slice(0, 60), 'nickname'),
      ...opt(form.ownedSince, 'ownership_start_date'),
      ...opt(form.notes.trim().slice(0, 2000), 'notes'),
      ...(!editing && km !== null ? { mileage_km: km } : {}),
    } as VehicleWrite;
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setFormError(null);
    setDuplicate(null);
    const b = body();
    if (!b) return;
    setBusy(true);
    try {
      if (photo) {
        const asset = await whenReady(photo.id);
        if (asset) b.primary_photo_media_id = asset.id;
      }
      if (vehicle) {
        const vinChanged = !!b.vin;
        const saved = await api.api('vehicles.update', { path: { vehicle_id: vehicle.id }, body: b });
        releaseGroup(group);
        dirty.current = false;
        await refresh(...VEHICLE_OPS);
        if (vinChanged) {
          setForm((cur) => ({ ...cur, vin: '' }));
          setAskRedecode(true);
          toast(t('garage.form.vehicleSaved'));
          void onReload();
          return;
        }
        toast(t('garage.form.vehicleSaved'));
        router.push(garagePath(locale, saved.id, 'overview'));
      } else {
        const created = await api.api('vehicles.create', { body: b });
        releaseGroup(group);
        dirty.current = false;
        setActive(created.id);
        await refresh(...VEHICLE_OPS);
        toast(t('garage.form.vehicleSaved'));
        router.push(
          created.vin_present ? `${garagePath(locale, created.id, 'edit')}?decode=1` : garagePath(locale, created.id, 'overview'),
        );
      }
    } catch (err) {
      if (!(err instanceof ApiProblem)) setFormError('garage.saveFailed');
      else if (err.code === 'VEHICLE_LIMIT_REACHED' || err.code === 'ENTITLEMENT_REQUIRED') setLimit(true);
      else if (err.code === 'DUPLICATE') setDuplicate({ transfer: err.vinTransferAvailable && !!b.vin, vin: b.vin ?? '' });
      else if (err.versionMismatch) setConflict('stale');
      else if (err.code === 'VIN_INVALID' || err.field('/vin')) setErrors({ vin: 'onboarding.vehicle.vinInvalid' });
      else if (err.code === 'TAXONOMY_MISMATCH') setFormError('onboarding.vehicle.taxonomyMismatch');
      else setFormError(err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const estimate = completenessEstimate({
    vin: vehicle?.vin_present || form.vin ? 'x' : '',
    series_node_id: form.pick.seriesId ?? '',
    engine_type_node_id: form.engine,
    fuel_type_node_id: form.fuel,
    transmission: form.transmission,
    drivetrain: form.drivetrain,
    body_style: form.body,
    color: form.color,
    license_plate: form.plate,
    nickname: form.nickname,
    mileage_km: form.mileage,
    ownership_start_date: form.ownedSince,
    primary_photo_media_id: photo || vehicle?.primary_photo_media_id ? 'x' : '',
  });

  const tag = (field: Field) =>
    sources[field] ? (
      <Badge tone={sources[field] === 'vin' ? 'accent' : 'neutral'} icon={sources[field] === 'vin' ? 'scan' : 'edit'}>
        {t(sources[field] === 'vin' ? 'garage.form.fromVin' : 'garage.form.youEntered')}
      </Badge>
    ) : null;

  const backHref = vehicle ? garagePath(locale, vehicle.id, 'overview') : `/${locale}/garage`;
  return (
    <form className="pwa-vehicle-form" onSubmit={(e) => void save(e)} noValidate>
      <div className="pwa-form-head">
        <Link href={backHref} className="pwa-link">
          ← {t(vehicle ? 'garage.form.backToCar' : 'garage.backToGarage')}
        </Link>
        <h1 className="pwa-page-title">{t(vehicle ? 'garage.form.editVehicle' : 'garage.addVehicle')}</h1>
      </div>
      {conflict === 'stale' ? (
        <Banner tone="warn" title={t('garage.form.conflictTitle')} text={t('garage.form.conflictText')}>
          <div className="pwa-banner-actions">
            <Button size="sm" onClick={() => void onReload().then(() => setConflict('reloaded'))}>
              {t('garage.form.reload')}
            </Button>
          </div>
        </Banner>
      ) : null}
      {conflict === 'reloaded' ? <Banner tone="info" text={t('garage.form.reloaded')} /> : null}
      {freed ? <Banner tone="success" text={t('garage.limit.freed')} /> : null}
      <div className="pwa-form-columns">
        <div className="pwa-form-main">
          <section className="flex flex-col gap-3" aria-labelledby="vin-title">
            <h2 id="vin-title" className="pwa-section-title">
              {t('garage.form.vinTitle')}
            </h2>
            {vehicle?.vin_present ? (
              <p className="pwa-text-caption">
                {t('garage.form.vinOnFile', { last4: vehicle.vin_last4 ?? '' })}{' '}
                <Button size="sm" variant="ghost" icon="scan" loading={decode.state === 'reading'} onClick={() => void runDecode(vehicle)}>
                  {t('garage.form.readVin')}
                </Button>
              </p>
            ) : null}
            <TextField
              label={t(vehicle?.vin_present ? 'garage.form.newVin' : 'onboarding.vehicle.vin')}
              value={form.vin}
              onChange={(e) => set('vin', e.target.value)}
              onPaste={(e) => {
                e.preventDefault();
                set('vin', cleanVin(e.clipboardData.getData('text')));
              }}
              onBlur={() => setForm((cur) => ({ ...cur, vin: cleanVin(cur.vin) }))}
              dir="ltr"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={VIN_LENGTH + 8}
              hint={t('garage.form.vinHint')}
              error={errors.vin ? t(errors.vin) : undefined}
            />
            <div>
              <Button size="sm" variant="ghost" icon="phone" onClick={() => setPhone(true)}>
                {t('garage.form.scanOnPhone')}
              </Button>
            </div>
            {decode.state === 'reading' ? (
              <p className="pwa-text-caption" role="status">
                {t('onboarding.vehicle.decoding')}
              </p>
            ) : null}
            {decode.state === 'failed' ? <Banner tone="plain" text={t('onboarding.vehicle.decodeFailed')} /> : null}
            {decode.state === 'suggested' && differences.length === 0 ? <Banner tone="success" text={t('garage.form.vinMatches')} /> : null}
            {decode.state === 'suggested' && differences.length > 0 ? (
              <Banner
                tone="info"
                icon="scan"
                title={t('garage.form.vinSuggests', { count: differences.length })}
                text={t('onboarding.vehicle.basis')}
              >
                <div className="pwa-banner-actions">
                  <Button size="sm" onClick={applyDecoded}>
                    {t('garage.form.applyVin')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDecode({ state: 'idle' })}>
                    {t('garage.form.keepMine')}
                  </Button>
                </div>
              </Banner>
            ) : null}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="car-title">
            <h2 id="car-title" className="pwa-section-title">
              {t('garage.form.carTitle')} {tag('brand') ?? tag('pick')}
            </h2>
            <VehiclePicker
              value={form.pick}
              onChange={(pick) => {
                dirty.current = true;
                setForm((cur) => ({ ...cur, pick }));
                setSources((s) => (s.brand || s.pick ? { ...s, brand: 'user', pick: 'user' } : s));
              }}
            />
            {errors.pick ? <p className="cp-field-hint pwa-error-text">{t(errors.pick)}</p> : null}
            <Tagged tag={tag('year')}>
              <SelectField
                label={t('onboarding.vehicle.year')}
                value={form.year}
                onChange={(y) => set('year', y)}
                placeholder={t('onboarding.vehicle.chooseYear')}
                options={years().map((y) => ({ value: String(y), label: f.digits(y) }))}
                error={errors.year ? t(errors.year) : undefined}
              />
            </Tagged>
          </section>

          <Details form={form} set={set} tag={tag} />

          <section className="flex flex-col gap-3" aria-labelledby="own-title">
            <h2 id="own-title" className="pwa-section-title">
              {t('garage.form.yoursTitle')}
            </h2>
            <TextField
              label={t('garage.form.nickname')}
              value={form.nickname}
              onChange={(e) => set('nickname', e.target.value)}
              maxLength={60}
              placeholder={t('onboarding.vehicle.nicknamePlaceholder')}
            />
            <TextField
              label={t('garage.form.plateOptional')}
              value={form.plate}
              onChange={(e) => set('plate', e.target.value)}
              maxLength={20}
              hint={t('garage.form.plateHint')}
            />
            {!editing ? (
              <TextField
                label={t('garage.history.mileage')}
                value={form.mileage}
                onChange={(e) => set('mileage', e.target.value)}
                inputMode="numeric"
                end={<span className="pwa-text-caption">{t('garage.km')}</span>}
                error={errors.mileage ? t(errors.mileage) : undefined}
              />
            ) : (
              <p className="pwa-text-caption">{t('garage.form.mileageInHeader')}</p>
            )}
            <DateField
              label={t('garage.form.ownedSince')}
              value={form.ownedSince}
              onChange={(d) => set('ownedSince', d)}
              optional
              max={todayIso(f.timeZone)}
            />
            <TextField
              multiline
              rows={3}
              label={t('garage.form.notes')}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              maxLength={2000}
            />
          </section>
          {duplicate?.transfer ? <TransferAsk vin={duplicate.vin} /> : null}
          {duplicate && !duplicate.transfer ? <Banner tone="warn" text={t('garage.form.duplicateMine')} /> : null}
          {formError ? <Banner tone="danger" text={t(formError)} /> : null}
        </div>

        <aside className="pwa-form-side" aria-label={t('garage.form.preview')}>
          <PreviewCard vehicle={vehicle} form={form} photoUrl={photo?.previewUrl ?? null} />
          <Meter value={vehicle && !touched ? vehicle.profile_completeness : estimate} label={t('garage.completeness')} />
          <p className="pwa-text-caption">
            {t('garage.complete', { percent: f.digits(vehicle && !touched ? vehicle.profile_completeness : estimate) })}
          </p>
          <UploadZone
            group={group}
            purpose="vehicle_photo"
            label={t('garage.form.photo')}
            multiple={false}
            hint={t('garage.form.photoHint')}
          />
        </aside>
      </div>
      <div className="pwa-sticky-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {t('common.actions.save')}
        </Button>
        <Link
          href={backHref}
          className={buttonClass({ variant: 'ghost' })}
          onClick={(e) => {
            if (dirty.current && !window.confirm(t('garage.form.discardVehicle'))) e.preventDefault();
            else {
              dirty.current = false;
              discardGroup(group);
            }
          }}
        >
          <span className="cp-btn-label">{t('common.actions.cancel')}</span>
        </Link>
      </div>
      <PlanLimitDialog
        open={limit}
        onClose={() => setLimit(false)}
        onFreed={() => {
          setLimit(false);
          setFreed(true);
        }}
      />
      <Dialog
        name="vin-redecode"
        open={askRedecode}
        onClose={() => setAskRedecode(false)}
        title={t('garage.form.redecodeTitle')}
        footer={
          <>
            <Button
              variant="primary"
              onClick={() => {
                setAskRedecode(false);
                if (vehicle) void runDecode(vehicle);
              }}
            >
              {t('garage.form.redecode')}
            </Button>
            <Button variant="ghost" onClick={() => setAskRedecode(false)}>
              {t('garage.form.keepCurrent')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('garage.form.redecodeText')}</p>
      </Dialog>
      <Dialog name="vehicle-phone" open={phone} onClose={() => setPhone(false)} title={t('garage.form.scanOnPhone')}>
        <PhoneQr />
      </Dialog>
    </form>
  );
}

type DecodeState = { state: 'idle' | 'reading' | 'failed' | 'none' } | { state: 'suggested'; result: VinDecodeResult };

async function readVin(api: ApiClient, vehicleId: string): Promise<DecodeState> {
  try {
    const result = await api.api('vehicles.vin_decode', { path: { vehicle_id: vehicleId } });
    return result.decode_status === 'failed' ? { state: 'failed' } : { state: 'suggested', result };
  } catch {
    // 503 UNAVAILABLE(decoder), 409 no VIN: the entered details stand (GD-13).
    return { state: 'none' };
  }
}

function years(): number[] {
  const last = new Date().getFullYear() + 2;
  return Array.from({ length: last - FIRST_YEAR + 1 }, (_, i) => last - i);
}

function Tagged({ tag, children }: { tag: ReactNode; children: ReactNode }) {
  return (
    <div className="pwa-tagged-field">
      {children}
      {tag ? <div className="pwa-field-tag">{tag}</div> : null}
    </div>
  );
}

function Details({ form, set, tag }: { form: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; tag: (f: Field) => ReactNode }) {
  const t = useT();
  const engines = useNodeNames('engine_type');
  const fuels = useNodeNames('fuel_type');
  return (
    <section className="flex flex-col gap-3" aria-labelledby="details-title">
      <h2 id="details-title" className="pwa-section-title">
        {t('garage.form.detailsTitle')}
      </h2>
      <div className="pwa-form-grid">
        <Tagged tag={tag('engine')}>
          <SelectField
            label={t('garage.form.engine')}
            value={form.engine}
            onChange={(x) => set('engine', x)}
            placeholder={t('garage.form.notSet')}
            options={engines.nodes.map((n) => ({ value: n.id, label: n.name.text }))}
          />
        </Tagged>
        <Tagged tag={tag('fuel')}>
          <SelectField
            label={t('garage.form.fuel')}
            value={form.fuel}
            onChange={(x) => set('fuel', x)}
            placeholder={t('garage.form.notSet')}
            options={fuels.nodes.map((n) => ({ value: n.id, label: n.name.text }))}
          />
        </Tagged>
        <Tagged tag={tag('transmission')}>
          <SelectField
            label={t('garage.form.transmission')}
            value={form.transmission}
            onChange={(x) => set('transmission', x)}
            placeholder={t('garage.form.notSet')}
            options={TRANSMISSIONS.map((x) => ({ value: x, label: t(`garage.enum.transmission.${x}`) }))}
          />
        </Tagged>
        <Tagged tag={tag('drivetrain')}>
          <SelectField
            label={t('garage.form.drivetrain')}
            value={form.drivetrain}
            onChange={(x) => set('drivetrain', x)}
            placeholder={t('garage.form.notSet')}
            options={DRIVETRAINS.map((x) => ({ value: x, label: t(`garage.enum.drivetrain.${x}`) }))}
          />
        </Tagged>
        <Tagged tag={tag('body')}>
          <SelectField
            label={t('garage.form.bodyStyle')}
            value={form.body}
            onChange={(x) => set('body', x)}
            placeholder={t('garage.form.notSet')}
            options={BODIES.map((x) => ({ value: x, label: t(`garage.enum.body.${x}`) }))}
          />
        </Tagged>
        <Tagged tag={tag('color')}>
          <TextField label={t('garage.form.color')} value={form.color} onChange={(e) => set('color', e.target.value)} maxLength={50} />
        </Tagged>
      </div>
    </section>
  );
}

function PreviewCard({ vehicle, form, photoUrl }: { vehicle: Vehicle | null; form: Form; photoUrl: string | null }) {
  const t = useT();
  const f = useFormat();
  const ref =
    form.pick.brandId && form.pick.modelId && form.year
      ? {
          brand_node_id: form.pick.brandId,
          model_node_id: form.pick.modelId,
          year: Number(form.year),
          ...(form.pick.seriesId ? { series_node_id: form.pick.seriesId } : {}),
        }
      : null;
  const { model, full } = useModelName(ref);
  const url = photoUrl ?? vehicle?.primary_photo_url ?? null;
  return (
    <div className="pwa-preview-card" aria-live="polite" data-testid="vehicle-preview">
      <span className="pwa-vehicle-photo">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- local blob: preview or a signed media URL
          <img src={url} alt="" />
        ) : (
          <Icon name="car" size={48} />
        )}
      </span>
      <span className="pwa-vehicle-card-title" dir="auto">
        <bdi>{form.nickname.trim() || model || t('garage.form.yourCar')}</bdi>
      </span>
      {full ? (
        <span className="pwa-text-caption" dir="auto">
          <bdi>{full}</bdi>
        </span>
      ) : null}
      {form.color ? <span className="pwa-text-caption">{form.color}</span> : null}
      {form.mileage && parseMileage(form.mileage) !== null ? (
        <span className="pwa-text-caption">{t('garage.mileageValue', { km: f.number(parseMileage(form.mileage)!) })}</span>
      ) : null}
    </div>
  );
}

/** "Scan on your phone": a QR code that opens the add-vehicle page on a phone (camera VIN scanning in the app). */
function PhoneQr() {
  const t = useT();
  const locale = useLocale();
  const origin = useBrowserValue<string | null>(() => location.origin, null);
  const url = origin ? `${origin}/${locale}/garage/add` : null;
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="pwa-text-body">{t('garage.form.phoneText')}</p>
      {url ? <QrCode value={url} label={t('onboarding.vehicle.qrLabel')} className="pwa-qr" /> : null}
    </div>
  );
}
