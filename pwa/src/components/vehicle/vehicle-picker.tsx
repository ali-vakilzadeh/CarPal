'use client';
// Vehicle picker brand → model → series (P3.T7), reused by the landing page, Help Me and the garage. Native <select>
// elements in the design system's field box: keyboard, screen reader and RTL behaviour come from the platform, and
// long lists stay usable on phones. Lists come from the taxonomy cache (by version); choosing a brand clears the
// model and series, choosing a model clears the series. Series is optional ("Not sure / any series").
import type { TaxonomyNode } from '@carpal/api-contracts';
import { useId } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { useTaxonomyNodes } from '@/lib/config/taxonomy';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

export interface VehiclePick {
  brandId: string | null;
  modelId: string | null;
  seriesId: string | null;
}

export const EMPTY_PICK: VehiclePick = { brandId: null, modelId: null, seriesId: null };

interface SelectProps {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  nodes: TaxonomyNode[] | undefined;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  /** First option: a prompt (required level) or a real "any" choice (optional level). */
  emptyLabel: string;
  disabledHint?: string;
  onRetry?: () => void;
}

function TaxonomySelect({ label, value, onChange, nodes, loading, failed, disabled, emptyLabel, disabledHint, onRetry }: SelectProps) {
  const t = useT();
  const id = useId();
  const none = !loading && !failed && !disabled && nodes?.length === 0;
  const hint = failed ? t('vehicle.picker.error') : disabled ? disabledHint : none ? t('vehicle.picker.noOptions') : undefined;
  return (
    <div className={cx('cp-field', failed && 'is-error')}>
      <label className="cp-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cp-field-box pwa-select-box">
        <select
          id={id}
          className="cp-field-input pwa-select"
          value={value ?? ''}
          disabled={disabled || loading || failed || none}
          aria-busy={loading || undefined}
          aria-invalid={failed || undefined}
          aria-describedby={hint ? `${id}-d` : undefined}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{loading ? t('common.loading') : emptyLabel}</option>
          {(nodes ?? []).map((n) => (
            <option key={n.id} value={n.id} lang={n.name.locale} dir="auto">
              {n.name.text}
            </option>
          ))}
        </select>
        <Icon name="down" size={20} />
      </div>
      {hint ? (
        <p id={`${id}-d`} className="cp-field-hint">
          {failed ? <Icon name="alert" size={16} /> : null}
          {hint}
          {failed && onRetry ? (
            <button type="button" className="pwa-link" onClick={onRetry}>
              {t('common.actions.retry')}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export interface VehiclePickerProps {
  value: VehiclePick;
  onChange: (value: VehiclePick) => void;
  /** Hide the series level (e.g. a quick filter). */
  withSeries?: boolean;
  legend?: MessageKey;
  className?: string;
}

export function VehiclePicker({ value, onChange, withSeries = true, legend = 'vehicle.picker.label', className }: VehiclePickerProps) {
  const t = useT();
  const brands = useTaxonomyNodes('vehicle_brand');
  const models = useTaxonomyNodes('vehicle_model', value.brandId, !!value.brandId);
  const series = useTaxonomyNodes('vehicle_series', value.modelId, withSeries && !!value.modelId);

  return (
    <fieldset className={cx('pwa-vehicle-picker', className)}>
      <legend className="cp-field-label">{t(legend)}</legend>
      <TaxonomySelect
        label={t('vehicle.picker.brand')}
        value={value.brandId}
        onChange={(brandId) => onChange({ brandId, modelId: null, seriesId: null })}
        nodes={brands.data}
        loading={brands.isPending}
        failed={brands.isError}
        disabled={false}
        emptyLabel={t('vehicle.picker.chooseBrand')}
        onRetry={() => void brands.refetch()}
      />
      <TaxonomySelect
        label={t('vehicle.picker.model')}
        value={value.modelId}
        onChange={(modelId) => onChange({ ...value, modelId, seriesId: null })}
        nodes={models.data}
        loading={!!value.brandId && models.isPending}
        failed={models.isError}
        disabled={!value.brandId}
        emptyLabel={t('vehicle.picker.chooseModel')}
        disabledHint={t('vehicle.picker.brandFirst')}
        onRetry={() => void models.refetch()}
      />
      {withSeries ? (
        <TaxonomySelect
          label={t('vehicle.picker.series')}
          value={value.seriesId}
          onChange={(seriesId) => onChange({ ...value, seriesId })}
          nodes={series.data}
          loading={!!value.modelId && series.isPending}
          failed={series.isError}
          disabled={!value.modelId}
          emptyLabel={t('vehicle.picker.anySeries')}
          disabledHint={t('vehicle.picker.modelFirst')}
          onRetry={() => void series.refetch()}
        />
      ) : null}
    </fieldset>
  );
}
