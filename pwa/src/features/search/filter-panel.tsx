'use client';
// The filter panel (Docs/22 W-SRCH-01 "Left: filter panel", Docs/90 S-SHARED-03): instant apply (every change updates
// the URL and refines the search), option counts when the result list is complete (filters.ts, DI-42), Reset (the car
// and the category stay). The availability filter says that providers without online booking drop out (BA-16).
// Used as the always-visible column from 1200 px and inside the Filters drawer below that; on the map the same panel
// highlights instead of filtering (Docs/22 W-MAP-01 "Advanced search").
import type { ResultCard, SearchFilters } from '@carpal/api-contracts';
import type { ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { filtersFor, optionCount, resetFilters, type FilterKey } from './filters';
import { AVAILABILITY_DAYS, DELIVERY, DISTANCES_KM, PART_CONDITIONS, PRICE_TIERS, RATINGS, compactFilters, type ModeTab } from './request';

export interface FilterPanelProps {
  mode: ModeTab;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  results?: readonly ResultCard[];
  /** All results are loaded (counts can be shown). */
  complete?: boolean;
  /** "For my car" (shown when a car is chosen). */
  vehicle?: { label: string; on: boolean; onToggle: (on: boolean) => void } | null;
  idPrefix: string;
  /** Map mode: the filters highlight places instead of removing them. */
  highlight?: boolean;
}

export function FilterPanel({ mode, filters, onChange, results = [], complete = false, vehicle, idPrefix, highlight }: FilterPanelProps) {
  const t = useT();
  const f = useFormat();
  const keys = filtersFor(mode);
  const has = (k: FilterKey) => keys.includes(k);
  const set = (patch: Partial<SearchFilters>) => onChange(compactFilters({ ...filters, ...patch }));
  const count = (k: FilterKey, v: unknown = true) => {
    const n = optionCount(results, complete, k, v);
    return n === null ? null : f.number(n);
  };
  const toggleIn = <T extends string>(list: readonly T[] | undefined, v: T): T[] => {
    const cur = list ?? [];
    return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  };

  return (
    <form className="pwa-filters" aria-label={t('search.filters.title')} onSubmit={(e) => e.preventDefault()}>
      {highlight ? <p className="pwa-text-caption">{t('search.filters.highlightNote')}</p> : null}
      {vehicle ? (
        <Toggle
          id={`${idPrefix}-car`}
          checked={vehicle.on}
          onChange={vehicle.onToggle}
          label={t('search.filters.forMyCar', { vehicle: vehicle.label })}
        />
      ) : null}
      {has('open_now') ? (
        <Toggle
          id={`${idPrefix}-open`}
          checked={!!filters.open_now}
          onChange={(v) => set({ open_now: v })}
          label={t('search.filters.openNow')}
          count={count('open_now')}
        />
      ) : null}
      {has('verified_only') ? (
        <Toggle
          id={`${idPrefix}-verified`}
          checked={!!filters.verified_only}
          onChange={(v) => set({ verified_only: v })}
          label={t('search.filters.verified')}
          count={count('verified_only')}
        />
      ) : null}
      {has('min_rating') ? (
        <Group legend={t('search.filters.rating')}>
          <Radio
            name={`${idPrefix}-rating`}
            checked={!filters.min_rating}
            onChange={() => set({ min_rating: undefined })}
            label={t('search.filters.any')}
          />
          {RATINGS.map((r) => (
            <Radio
              key={r}
              name={`${idPrefix}-rating`}
              checked={filters.min_rating === r}
              onChange={() => set({ min_rating: r })}
              label={t('search.filters.ratingAtLeast', { value: f.number(Number(r), { minimumFractionDigits: 1 }) })}
              count={count('min_rating', r)}
            />
          ))}
        </Group>
      ) : null}
      {has('distance_km') ? (
        <Group legend={t('search.filters.distance')}>
          {DISTANCES_KM.map((d) => (
            <Radio
              key={d}
              name={`${idPrefix}-km`}
              checked={(filters.distance_km ?? 50) === d}
              onChange={() => set({ distance_km: d === 50 ? undefined : d })}
              label={t('search.filters.within', { km: f.number(d) })}
            />
          ))}
        </Group>
      ) : null}
      {has('available_within_days') ? (
        <Group legend={t('search.filters.availability')} hint={t('search.filters.availabilityNote')}>
          <Radio
            name={`${idPrefix}-avail`}
            checked={filters.available_within_days === undefined}
            onChange={() => set({ available_within_days: undefined })}
            label={t('search.filters.any')}
          />
          {AVAILABILITY_DAYS.map((d) => (
            <Radio
              key={d}
              name={`${idPrefix}-avail`}
              checked={filters.available_within_days === d}
              onChange={() => set({ available_within_days: d })}
              label={t(d === 0 ? 'search.filters.today' : 'search.filters.thisWeek')}
              count={count('available_within_days', d)}
            />
          ))}
        </Group>
      ) : null}
      {has('price_tiers') ? (
        <Group legend={t('search.filters.price')}>
          {PRICE_TIERS.map((p) => (
            <Check
              key={p}
              id={`${idPrefix}-price-${p}`}
              checked={!!filters.price_tiers?.includes(p)}
              onChange={() => set({ price_tiers: toggleIn(filters.price_tiers, p) })}
              label={t(`profiles.priceTier.${p}` as MessageKey)}
              count={count('price_tiers', p)}
            />
          ))}
        </Group>
      ) : null}
      {has('service_modes') ? (
        <Toggle
          id={`${idPrefix}-mobile`}
          checked={!!filters.service_modes?.includes('mobile')}
          onChange={(v) => set({ service_modes: v ? ['mobile'] : undefined })}
          label={t('search.filters.comesToMe')}
        />
      ) : null}
      {has('warranty_offered') ? (
        <Toggle
          id={`${idPrefix}-warranty`}
          checked={!!filters.warranty_offered}
          onChange={(v) => set({ warranty_offered: v })}
          label={t('search.filters.warranty')}
        />
      ) : null}
      {has('ev_capable') ? (
        <Toggle
          id={`${idPrefix}-ev`}
          checked={!!filters.ev_capable}
          onChange={(v) => set({ ev_capable: v })}
          label={t('search.filters.ev')}
        />
      ) : null}
      {has('fleet_friendly') ? (
        <Toggle
          id={`${idPrefix}-fleet`}
          checked={!!filters.fleet_friendly}
          onChange={(v) => set({ fleet_friendly: v })}
          label={t('search.filters.fleet')}
        />
      ) : null}
      {has('stock_available') ? (
        <Toggle
          id={`${idPrefix}-stock`}
          checked={!!filters.stock_available}
          onChange={(v) => set({ stock_available: v })}
          label={t('search.filters.inStock')}
          count={count('stock_available')}
        />
      ) : null}
      {has('part_conditions') ? (
        <Group legend={t('search.filters.condition')}>
          {PART_CONDITIONS.map((c) => (
            <Check
              key={c}
              id={`${idPrefix}-cond-${c}`}
              checked={!!filters.part_conditions?.includes(c)}
              onChange={() => set({ part_conditions: toggleIn(filters.part_conditions, c) })}
              label={t(`profiles.parts.condition.${c}`)}
              count={count('part_conditions', c)}
            />
          ))}
        </Group>
      ) : null}
      {has('delivery_options') ? (
        <Group legend={t('search.filters.delivery')}>
          {DELIVERY.map((d) => (
            <Check
              key={d}
              id={`${idPrefix}-delivery-${d}`}
              checked={!!filters.delivery_options?.includes(d)}
              onChange={() => set({ delivery_options: toggleIn(filters.delivery_options, d) })}
              label={t(`search.filters.deliveryOption.${d}`)}
            />
          ))}
        </Group>
      ) : null}
      <Button size="sm" onClick={() => onChange(resetFilters(filters))}>
        {t('search.filters.reset')}
      </Button>
    </form>
  );
}

function Count({ value }: { value: string | null | undefined }) {
  return value ? <span className="pwa-filter-count">({value})</span> : null;
}

function Toggle({
  id,
  checked,
  onChange,
  label,
  count,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  count?: string | null;
}) {
  return (
    <label className="pwa-filter-row" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      <Count value={count} />
    </label>
  );
}

const Check = Toggle;

function Radio({
  name,
  checked,
  onChange,
  label,
  count,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  count?: string | null;
}) {
  return (
    <label className="pwa-filter-row">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{label}</span>
      <Count value={count} />
    </label>
  );
}

function Group({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="pwa-filter-group">
      <legend className="pwa-text-label">{legend}</legend>
      {children}
      {hint ? <p className="pwa-text-caption m-0">{hint}</p> : null}
    </fieldset>
  );
}
