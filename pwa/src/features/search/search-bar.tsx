'use client';
// W-SRCH-01 top bar parts (Docs/22 "Top bar"): the query field, mode tabs (All · Providers · Parts · Vendors · Q&A;
// Showcases hidden, DI-19), the sort (Best match, Distance, Rating — "Soonest available" has no contract sort, DI-42)
// and the guest's car chip (a car chosen here is sent as brand/model/series filters, never as vehicle_id, BA-16).
import type { SearchFilters } from '@carpal/api-contracts';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { Dialog } from '@/components/shell/dialog';
import { VehiclePicker, type VehiclePick } from '@/components/vehicle/vehicle-picker';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useT } from '@/lib/i18n/client';
import { MODE_TABS, SORTS, type ModeTab, type Sort } from './request';

export function QueryField({ initial, onSubmit, busy }: { initial: string; onSubmit: (text: string) => void; busy?: boolean }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(text.trim().slice(0, 500));
  };
  return (
    <form role="search" className="pwa-query" onSubmit={submit} aria-label={t('search.query.label')}>
      <div className="cp-field-box">
        <Icon name="search" size={20} />
        <label htmlFor="search-query" className="sr-only">
          {t('search.query.label')}
        </label>
        <input
          id="search-query"
          className="cp-field-input"
          type="search"
          dir="auto"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={500}
          placeholder={t('search.query.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" loading={busy}>
        {t('shell.header.searchSubmit')}
      </Button>
    </form>
  );
}

export function ModeTabs({
  value,
  qna,
  onChange,
  disabled,
}: {
  value: ModeTab;
  qna: boolean;
  onChange: (m: ModeTab) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const tabs = MODE_TABS.filter((m) => m !== 'qna' || qna);
  return (
    <div className="pwa-mode-tabs" role="group" aria-label={t('search.mode.label')}>
      {tabs.map((m) => (
        <button
          key={m}
          type="button"
          className={cx('cp-chip', m === value && 'is-selected')}
          aria-pressed={m === value}
          disabled={disabled}
          onClick={() => m !== value && onChange(m)}
        >
          <span>{t(`search.mode.${m}`)}</span>
        </button>
      ))}
    </div>
  );
}

export function SortSelect({ value, onChange, disabled }: { value: Sort; onChange: (s: Sort) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <label className="pwa-sort">
      <span className="pwa-text-caption">{t('search.sort.label')}</span>
      <select className="cp-field-input pwa-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Sort)}>
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {t(`search.sort.${s}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "BMW 3 Series" from the guest's car filters (taxonomy names), or null. */
export function useGuestCarLabel(f: SearchFilters): string | null {
  const brands = useTaxonomyNodes('vehicle_brand', null, !!f.brand_node_id);
  const models = useTaxonomyNodes('vehicle_model', f.brand_node_id ?? null, !!f.model_node_id);
  const series = useTaxonomyNodes('vehicle_series', f.model_node_id ?? null, !!f.series_node_id);
  if (!f.brand_node_id) return null;
  const names = [
    brands.data?.find((n) => n.id === f.brand_node_id)?.name.text,
    models.data?.find((n) => n.id === f.model_node_id)?.name.text,
    series.data?.find((n) => n.id === f.series_node_id)?.name.text,
  ].filter(Boolean);
  return names.join(' ') || null;
}

/** The car filters of a pick (brand → model → series). */
export function carFilters(pick: VehiclePick): Pick<SearchFilters, 'brand_node_id' | 'model_node_id' | 'series_node_id'> {
  return {
    brand_node_id: pick.brandId ?? undefined,
    model_node_id: pick.brandId ? (pick.modelId ?? undefined) : undefined,
    series_node_id: pick.brandId && pick.modelId ? (pick.seriesId ?? undefined) : undefined,
  };
}

export function GuestCarChip({
  filters,
  onChange,
  disabled,
  open,
  onOpenChange,
}: {
  filters: SearchFilters;
  onChange: (car: Pick<SearchFilters, 'brand_node_id' | 'model_node_id' | 'series_node_id'>) => void;
  disabled?: boolean;
  /** Controlled by the page, so "Add your car for better matches" can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const label = useGuestCarLabel(filters);
  const current: VehiclePick = {
    brandId: filters.brand_node_id ?? null,
    modelId: filters.model_node_id ?? null,
    seriesId: filters.series_node_id ?? null,
  };
  const [edited, setPick] = useState<VehiclePick | null>(null);
  const pick = edited ?? current;
  const setOpen = (v: boolean) => {
    setPick(null);
    onOpenChange(v);
  };
  const start = () => setOpen(true);
  return (
    <>
      <button type="button" className="cp-chip pwa-vehicle-chip" aria-haspopup="dialog" disabled={disabled} onClick={start}>
        <Icon name="car" size={18} />
        <span>{label ? t('shell.header.forVehicle', { vehicle: label }) : t('search.vehicle.choose')}</span>
        <Icon name="down" size={18} />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('search.vehicle.title')}
        variant="sheet"
        name="search-car"
        footer={
          <>
            <Button
              variant="primary"
              disabled={!pick.brandId}
              onClick={() => {
                onChange(carFilters(pick));
                setOpen(false);
              }}
            >
              {t('search.vehicle.apply')}
            </Button>
            {filters.brand_node_id ? (
              <Button
                onClick={() => {
                  onChange({ brand_node_id: undefined, model_node_id: undefined, series_node_id: undefined });
                  setOpen(false);
                }}
              >
                {t('shell.vehicle.any')}
              </Button>
            ) : null}
          </>
        }
      >
        <p className="pwa-text-caption">{t('search.vehicle.guestText')}</p>
        <VehiclePicker value={pick} onChange={setPick} />
      </Dialog>
    </>
  );
}
