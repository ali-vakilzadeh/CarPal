'use client';
// W-GAR-02 add / edit service record (C-GARAGE-05): a page with a two-column form — fields on the left, attachments
// and suggestions on the right (one column on phones). "What was done?" comes first; pasting or typing it suggests
// categories (taxonomy.suggest: "Brakes → Pad replacement", tap to accept). Date in the UI calendar (never in the
// future), mileage with the last reading as a hint (not a value), the shop (one of this car's earlier shops; a shop
// not on CarPal is kept by name in the description — the contract has no free-text shop field, DI-47), cost with
// currency, parts rows, warranty. Invoices and photos: drag and drop, paste or pick (the upload kit); saving is
// allowed while uploads run — they are attached when clean, also after leaving the page. A PDF makes the record an
// invoice upload (starts the invoice check). Before saving a new record with the date and category of an existing
// one: "This looks like a record you already added on …" (View it / Save anyway). New records keep a draft in this
// browser. Edits send If-Match; a 412 shows "This changed elsewhere — reload" and keeps the input (GD-09 am. 5).
import type { PartUsed, ServiceRecord, ServiceRecordWrite, TaxonomySuggestion, Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { IconButton } from '@/components/ds/icon-button';
import { TextField } from '@/components/ds/text-field';
import { DateField } from '@/components/fields/date-field';
import { SelectField } from '@/components/fields/select-field';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard } from '@/components/shell/skeleton';
import { useToast } from '@/components/shell/toast';
import { discardGroup, releaseGroup, uploadsOf, UploadZone, useUploads, whenReady } from '@/features/media';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useRegion } from '@/lib/config/client';
import { todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useRecord, useRecords, useRefresh, useVehicle } from './hooks';
import { findDuplicate, garagePath, parseAmount, parseMileage, recurringCount } from './model';
import { useNodeNames, useVehicleTitle } from './names';

type PartRow = { name: string; part_number: string; quantity: string };

interface Draft {
  description: string;
  systemId: string;
  taskId: string;
  date: string;
  mileage: string;
  providerId: string;
  shopName: string;
  amount: string;
  currency: string;
  warranty: string;
  parts: PartRow[];
}

const EMPTY: Draft = {
  description: '',
  systemId: '',
  taskId: '',
  date: '',
  mileage: '',
  providerId: '',
  shopName: '',
  amount: '',
  currency: '',
  warranty: '',
  parts: [],
};

const draftKey = (vehicleId: string) => `cp:record-draft:${vehicleId}`;

function fromRecord(r: ServiceRecord): Draft {
  return {
    description: r.description ?? '',
    systemId: r.service_system_node_id,
    taskId: r.service_task_node_id ?? '',
    date: r.service_date,
    mileage: r.mileage_km !== undefined ? String(r.mileage_km) : '',
    providerId: r.provider_organization_id ?? '',
    shopName: '',
    amount: r.cost?.amount ?? '',
    currency: r.cost?.currency ?? '',
    warranty: r.warranty_note ?? '',
    parts: (r.parts_used ?? []).map((p) => ({ name: p.name, part_number: p.part_number ?? '', quantity: String(p.quantity) })),
  };
}

type Errors = Partial<Record<'system' | 'date' | 'mileage' | 'amount' | 'parts' | 'description', MessageKey>>;

export function RecordFormScreen({ vehicleId, recordId }: { vehicleId: string; recordId: string | null }) {
  const t = useT();
  const vehicle = useVehicle(vehicleId);
  const record = useRecord(vehicleId, recordId);
  if (vehicle.isPending || (recordId && record.isPending)) return <SkeletonCard lines={8} />;
  if (vehicle.isError) return <ErrorState error={vehicle.error} onRetry={() => void vehicle.refetch()} />;
  if (recordId && record.isError) return <ErrorState error={record.error} onRetry={() => void record.refetch()} />;
  return (
    <RecordForm
      vehicle={vehicle.data}
      record={record.data ?? null}
      onReload={() => record.refetch()}
      key={recordId ?? 'new'}
      title={t(recordId ? 'garage.form.editRecord' : 'garage.form.addRecord')}
    />
  );
}

function RecordForm({
  vehicle: v,
  record,
  onReload,
  title,
}: {
  vehicle: Vehicle;
  record: ServiceRecord | null;
  onReload: () => Promise<unknown>;
  title: string;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const region = useRegion();
  const vehicleTitle = useVehicleTitle(v);
  const systems = useNodeNames('service_system');
  const history = useRecords(v.id);
  const all = useMemo(() => (history.data?.pages ?? []).flatMap((p) => p.items), [history.data]);
  const editing = !!record;
  const group = `record:${v.id}:${record?.id ?? 'new'}`;
  const uploads = useUploads(group);
  const today = todayIso(f.timeZone);
  const defaultCurrency = region.currency || 'IRR';

  const [d, setD] = useState<Draft>(() => {
    if (record) return fromRecord(record);
    try {
      const saved = localStorage.getItem(draftKey(v.id));
      if (saved) return { ...EMPTY, ...(JSON.parse(saved) as Partial<Draft>) };
    } catch {
      /* no storage: start empty */
    }
    return EMPTY;
  });
  const [restored] = useState(() => !record && JSON.stringify(d) !== JSON.stringify(EMPTY));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<MessageKey | null>(null);
  const [conflict, setConflict] = useState<'none' | 'stale' | 'reloaded'>('none');
  const [duplicate, setDuplicate] = useState<ServiceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const tasks = useNodeNames('service_task', d.systemId || null, !!d.systemId);
  const set = <K extends keyof Draft>(k: K, value: Draft[K]) => {
    dirty.current = true;
    setD((cur) => ({ ...cur, [k]: value, ...(k === 'systemId' ? { taskId: '' } : {}) }));
  };

  // Draft autosave for new records (C-GARAGE-05 "draft autosaved").
  useEffect(() => {
    if (editing) return;
    const timer = setTimeout(() => {
      try {
        if (JSON.stringify(d) === JSON.stringify(EMPTY)) localStorage.removeItem(draftKey(v.id));
        else localStorage.setItem(draftKey(v.id), JSON.stringify(d));
      } catch {
        /* storage blocked */
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [d, editing, v.id]);

  // Leaving with changes asks first (the browser's own prompt).
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  const suggestions = useCategorySuggestions(api, d.description, !d.systemId);
  const shops = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all) if (r.provider && !seen.has(r.provider.id)) seen.set(r.provider.id, r.provider.name);
    if (record?.provider && !seen.has(record.provider.id)) seen.set(record.provider.id, record.provider.name);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [all, record]);

  const validate = (): ServiceRecordWrite | null => {
    const e: Errors = {};
    if (!d.systemId) e.system = 'garage.form.errors.system';
    if (!d.date) e.date = 'garage.form.errors.date';
    else if (d.date > today) e.date = 'garage.form.errors.future';
    const km = d.mileage.trim() ? parseMileage(d.mileage) : null;
    if (d.mileage.trim() && km === null) e.mileage = 'garage.mileage.invalid';
    const amount = d.amount.trim() ? parseAmount(d.amount) : null;
    if (d.amount.trim() && amount === null) e.amount = 'garage.form.errors.amount';
    const parts: PartUsed[] = [];
    for (const p of d.parts) {
      if (!p.name.trim() && !p.part_number.trim()) continue;
      const qty = Number(p.quantity || '1');
      if (!p.name.trim() || !Number.isInteger(qty) || qty < 1 || qty > 10_000) e.parts = 'garage.form.errors.parts';
      else
        parts.push({
          name: p.name.trim().slice(0, 160),
          quantity: qty,
          ...(p.part_number.trim() ? { part_number: p.part_number.trim().slice(0, 100) } : {}),
        });
    }
    const shop = d.shopName.trim() && !d.providerId ? `${t('garage.form.shopLine', { name: d.shopName.trim() })}\n` : '';
    const description = (shop + d.description.trim()).trim();
    if (description.length > 4000) e.description = 'garage.form.errors.description';
    setErrors(e);
    if (Object.keys(e).length) return null;
    const hasPdf = uploadsOf(group).some((u) => u.state.kind === 'pdf' && u.state.phase !== 'failed');
    return {
      service_date: d.date,
      service_system_node_id: d.systemId,
      ...(d.taskId ? { service_task_node_id: d.taskId } : {}),
      ...(description ? { description } : {}),
      ...(parts.length ? { parts_used: parts } : {}),
      ...(amount ? { cost: { amount, currency: d.currency || defaultCurrency } } : {}),
      ...(d.warranty.trim() ? { warranty_note: d.warranty.trim().slice(0, 500) } : {}),
      ...(km !== null ? { mileage_km: km } : {}),
      ...(d.providerId ? { provider_organization_id: d.providerId } : {}),
      source_type: hasPdf ? 'invoice_upload' : 'user_manual',
      visibility: 'private',
    };
  };

  const save = async (e?: FormEvent, anyway = false) => {
    e?.preventDefault();
    setFormError(null);
    const body = validate();
    if (!body) return;
    if (!editing && !anyway) {
      const dup = findDuplicate(all, body);
      if (dup) return setDuplicate(dup);
    }
    setDuplicate(null);
    setBusy(true);
    try {
      let saved: ServiceRecord;
      if (record) {
        const { source_type: _source, ...patch } = body;
        void _source;
        saved = await api.api('service_records.update', { path: { vehicle_id: v.id, record_id: record.id }, body: patch });
      } else {
        saved = await api.api('service_records.create', { path: { vehicle_id: v.id }, body });
      }
      dirty.current = false;
      try {
        localStorage.removeItem(draftKey(v.id));
      } catch {
        /* storage blocked */
      }
      attachLater(
        api,
        v.id,
        saved.id,
        group,
        () => void refresh('service_records.list', 'service_records.get'),
        () => toast(t('garage.record.attachFailed')),
      );
      await refresh('service_records.list', 'service_records.get', 'vehicles.get', 'vehicles.list');
      const others = recurringCount(
        all.filter((r) => r.id !== saved.id),
        saved.service_system_node_id,
        saved.service_date,
      );
      toast(
        others >= 2
          ? t('garage.form.savedRecurring', { count: others + 1, name: systems.name(saved.service_system_node_id) ?? '' })
          : t('garage.form.saved', { name: vehicleTitle }),
      );
      router.push(garagePath(locale, v.id, 'history'));
    } catch (err) {
      if (err instanceof ApiProblem && err.versionMismatch) setConflict('stale');
      else if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') setFormError('garage.form.errors.notEditable');
      else if (err instanceof ApiProblem && err.field('/service_date')) setErrors({ date: 'garage.form.errors.date' });
      else setFormError(err instanceof ApiProblem && err.code === 'NETWORK' ? 'garage.offline' : 'garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    await onReload();
    setConflict('reloaded');
  };

  const cancelHref = garagePath(locale, v.id, 'history');
  return (
    <form className="pwa-record-form" onSubmit={(e) => void save(e)} noValidate>
      <div className="pwa-form-head">
        <Link href={cancelHref} className="pwa-link">
          ← {t('garage.form.backToHistory', { name: vehicleTitle })}
        </Link>
        <h1 className="pwa-page-title">{title}</h1>
      </div>
      {restored ? (
        <Banner tone="plain" text={t('garage.form.draftRestored')}>
          <div className="pwa-banner-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setD(EMPTY);
                discardGroup(group);
              }}
            >
              {t('garage.form.discardDraft')}
            </Button>
          </div>
        </Banner>
      ) : null}
      {conflict === 'stale' ? (
        <Banner tone="warn" title={t('garage.form.conflictTitle')} text={t('garage.form.conflictText')}>
          <div className="pwa-banner-actions">
            <Button size="sm" onClick={() => void reload()}>
              {t('garage.form.reload')}
            </Button>
          </div>
        </Banner>
      ) : null}
      {conflict === 'reloaded' ? <Banner tone="info" text={t('garage.form.reloaded')} /> : null}
      <div className="pwa-form-columns">
        <div className="pwa-form-main">
          <TextField
            multiline
            rows={4}
            label={t('garage.form.whatWasDone')}
            value={d.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={4000}
            hint={t('garage.form.whatHint')}
            error={errors.description ? t(errors.description) : undefined}
          />
          {suggestions.length > 0 ? (
            <div className="pwa-suggestions" role="group" aria-label={t('garage.form.suggestions')}>
              <span className="pwa-text-caption">{t('garage.form.suggestions')}</span>
              {suggestions.map((s) => (
                <Chip
                  key={s.node.id}
                  icon="plus"
                  toggle={false}
                  onClick={() => {
                    dirty.current = true;
                    if (s.node.type === 'service_task' && s.node.parent_id)
                      setD((cur) => ({ ...cur, systemId: s.node.parent_id!, taskId: s.node.id }));
                    else setD((cur) => ({ ...cur, systemId: s.node.id, taskId: '' }));
                  }}
                >
                  {s.node.type === 'service_task' ? `${systems.name(s.node.parent_id) ?? ''} → ${s.node.name.text}` : s.node.name.text}
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="pwa-form-grid">
            <SelectField
              label={t('garage.history.category')}
              value={d.systemId}
              onChange={(id) => set('systemId', id)}
              placeholder={t('garage.form.chooseCategory')}
              options={systems.nodes.map((n) => ({ value: n.id, label: n.name.text }))}
              error={errors.system ? t(errors.system) : undefined}
              required
            />
            <SelectField
              label={t('garage.form.task')}
              value={d.taskId}
              onChange={(id) => set('taskId', id)}
              placeholder={d.systemId ? t('garage.form.anyTask') : t('garage.form.categoryFirst')}
              options={tasks.nodes.map((n) => ({ value: n.id, label: n.name.text }))}
              disabled={!d.systemId}
            />
          </div>
          <DateField
            label={t('garage.history.date')}
            value={d.date}
            onChange={(date) => set('date', date)}
            max={today}
            error={errors.date ? t(errors.date) : undefined}
          />
          <TextField
            label={t('garage.history.mileage')}
            value={d.mileage}
            onChange={(e) => set('mileage', e.target.value)}
            inputMode="numeric"
            placeholder={v.mileage_km !== undefined ? t('garage.form.mileageHint', { km: f.number(v.mileage_km) }) : undefined}
            end={<span className="pwa-text-caption">{t('garage.km')}</span>}
            error={errors.mileage ? t(errors.mileage) : undefined}
          />
          <div className="pwa-form-grid">
            <SelectField
              label={t('garage.form.shop')}
              value={d.providerId}
              onChange={(id) => set('providerId', id)}
              placeholder={shops.length ? t('garage.form.shopNotListed') : t('garage.form.noShops')}
              options={shops}
              disabled={shops.length === 0}
            />
            {!d.providerId ? (
              <TextField
                label={t('garage.form.shopName')}
                value={d.shopName}
                onChange={(e) => set('shopName', e.target.value)}
                maxLength={120}
                hint={t('garage.form.shopNameHint')}
              />
            ) : null}
          </div>
          <div className="pwa-form-grid">
            <TextField
              label={t('garage.form.cost')}
              value={d.amount}
              onChange={(e) => set('amount', e.target.value)}
              inputMode="decimal"
              error={errors.amount ? t(errors.amount) : undefined}
            />
            <SelectField
              label={t('garage.form.currency')}
              value={d.currency || defaultCurrency}
              onChange={(c) => set('currency', c)}
              options={[
                { value: 'IRR', label: t('garage.form.currencyIrr') },
                { value: 'USD', label: t('garage.form.currencyUsd') },
              ]}
            />
          </div>
          <PartsRows parts={d.parts} onChange={(parts) => set('parts', parts)} error={errors.parts ? t(errors.parts) : undefined} />
          <TextField
            label={t('garage.form.warranty')}
            value={d.warranty}
            onChange={(e) => set('warranty', e.target.value)}
            maxLength={500}
            hint={t('garage.form.warrantyHint')}
          />
          <p className="pwa-text-caption">{t('garage.form.privateNote')}</p>
        </div>
        <aside className="pwa-form-side" aria-label={t('garage.form.attachments')}>
          <UploadZone group={group} purpose="service_evidence" label={t('garage.form.invoices')} hint={t('garage.form.invoicesHint')} />
          {uploads.some((u) => u.state.phase !== 'ready' && u.state.phase !== 'failed') ? (
            <p className="pwa-text-caption" role="status">
              {t('garage.form.uploadsContinue')}
            </p>
          ) : null}
        </aside>
      </div>
      {formError ? <Banner tone="danger" text={t(formError)} /> : null}
      <div className="pwa-sticky-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {t('common.actions.save')}
        </Button>
        <Link
          href={cancelHref}
          className={buttonClass({ variant: 'ghost' })}
          onClick={(e) => {
            if (dirty.current && !window.confirm(t('garage.form.discardConfirm'))) e.preventDefault();
            else dirty.current = false;
          }}
        >
          <span className="cp-btn-label">{t('common.actions.cancel')}</span>
        </Link>
      </div>
      <Dialog
        name="record-duplicate"
        open={!!duplicate}
        onClose={() => setDuplicate(null)}
        title={t('garage.form.duplicateTitle')}
        footer={
          <>
            <Button variant="primary" onClick={() => void save(undefined, true)}>
              {t('garage.form.saveAnyway')}
            </Button>
            {duplicate ? (
              <Link
                href={`${garagePath(locale, v.id, 'history')}?modal=record&record=${duplicate.id}`}
                className={buttonClass({ variant: 'ghost' })}
              >
                <span className="cp-btn-label">{t('garage.form.viewIt')}</span>
              </Link>
            ) : null}
          </>
        }
      >
        {duplicate ? (
          <p className="pwa-text-body">{t('garage.form.duplicateText', { date: f.calendarDate(duplicate.service_date, 'dateLong') })}</p>
        ) : null}
      </Dialog>
    </form>
  );
}

function PartsRows({ parts, onChange, error }: { parts: PartRow[]; onChange: (p: PartRow[]) => void; error?: string }) {
  const t = useT();
  const update = (i: number, patch: Partial<PartRow>) => onChange(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <fieldset className="pwa-parts">
      <legend className="cp-field-label">{t('garage.form.parts')}</legend>
      {parts.map((p, i) => (
        <div key={i} className="pwa-part-row">
          <TextField
            label={t('garage.form.partName')}
            value={p.name}
            onChange={(e) => update(i, { name: e.target.value })}
            maxLength={160}
          />
          <TextField
            label={t('garage.form.partNumber')}
            value={p.part_number}
            onChange={(e) => update(i, { part_number: e.target.value })}
            maxLength={100}
            dir="ltr"
          />
          <TextField
            label={t('garage.form.quantity')}
            value={p.quantity}
            onChange={(e) => update(i, { quantity: e.target.value })}
            inputMode="numeric"
          />
          <IconButton icon="trash" label={t('garage.form.removePart')} onClick={() => onChange(parts.filter((_, j) => j !== i))} />
        </div>
      ))}
      {error ? <p className="cp-field-hint pwa-error-text">{error}</p> : null}
      <div>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange([...parts, { name: '', part_number: '', quantity: '1' }])}>
          {t('garage.form.addPart')}
        </Button>
      </div>
    </fieldset>
  );
}

/** Category suggestions from "What was done?" (taxonomy.suggest on service systems and tasks), debounced. */
function useCategorySuggestions(api: ApiClient, text: string, enabled: boolean): TaxonomySuggestion[] {
  const [found, setFound] = useState<{ q: string; items: TaxonomySuggestion[] }>({ q: '', items: [] });
  const q = text.trim().slice(0, 100);
  const active = enabled && q.length >= 3;
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .api('taxonomy.suggest', { body: { text: q, types: ['service_task', 'service_system'] }, signal: ctrl.signal })
        .then((r) => setFound({ q, items: r.items.slice(0, 4) }))
        .catch(() => setFound({ q, items: [] }));
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [api, q, active]);
  return active && found.q === q ? found.items : [];
}

/** Attaches the record's uploads as each one is clean — keeps going after the page is left (module scope). */
function attachLater(api: ApiClient, vehicleId: string, recordId: string, group: string, onAttached: () => void, onFailed: () => void) {
  for (const u of uploadsOf(group)) {
    if (u.state.phase === 'failed') continue;
    void whenReady(u.id).then(async (asset) => {
      if (!asset) return;
      try {
        await api.api('service_records.evidence_add', {
          path: { vehicle_id: vehicleId, record_id: recordId },
          body: { evidence_type: asset.media_type === 'document' ? 'invoice' : 'photo', media_asset_id: asset.id },
        });
        onAttached();
      } catch {
        onFailed();
      }
    });
  }
  // The form's list is emptied now; the uploads keep running until whenReady settles.
  releaseGroup(group);
}
