'use client';
// Star ratings as native radio groups (W-REV-01 "keyboard: arrow keys change stars"): the browser gives the group one
// tab stop and arrow-key selection in reading direction (mirrored under RTL), screen readers announce "3 of 5
// stars", and the stars are only the visible face of the radios. Optional ratings have "Clear".
import { useId } from 'react';
import { Icon } from '@/components/ds/icon';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

export interface StarInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  required?: boolean;
  size?: 'lg' | 'sm';
  error?: string | null;
  /** Shows "Clear" for an optional rating that has a value. */
  clearable?: boolean;
  /** The group's accessible description (e.g. the hint under the overall rating). */
  hint?: string;
}

export function StarInput({ label, value, onChange, required, size = 'sm', error, clearable, hint }: StarInputProps) {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const described = [error ? `${id}-e` : null, hint ? `${id}-h` : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className={`pwa-stars is-${size}${error ? ' is-error' : ''}`} aria-describedby={described}>
      <legend className={size === 'lg' ? 'pwa-text-label' : 'pwa-stars-legend'}>{label}</legend>
      <div className="pwa-stars-row">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={`pwa-star${n <= value ? ' is-on' : ''}`}>
            <input
              type="radio"
              className="sr-only"
              name={id}
              value={n}
              checked={value === n}
              required={required && n === 1}
              onChange={() => onChange(n)}
            />
            <Icon name="star" size={size === 'lg' ? 32 : 24} filled={n <= value} />
            <span className="sr-only">{t('reviews.form.starsOf', { value: f.number(n) })}</span>
          </label>
        ))}
        {clearable && value ? (
          <button type="button" className="pwa-link pwa-stars-clear" onClick={() => onChange(0)}>
            {t('reviews.form.clear')}
            <span className="sr-only"> {label}</span>
          </button>
        ) : null}
      </div>
      {hint ? (
        <p id={`${id}-h`} className="pwa-text-caption m-0">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-e`} className="pwa-error-text m-0" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
