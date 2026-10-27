// A labelled native <select> in the design system's field box (same markup as TextField and the vehicle picker):
// native selects are keyboard- and screen-reader-friendly on every platform and need no listbox code.
import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'onChange' | 'value'> {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** First, empty option (e.g. "Choose a category"). */
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  className,
  id: givenId,
  ...rest
}: SelectFieldProps) {
  const auto = useId();
  const id = givenId ?? `cp-s${auto}`;
  const described = error || hint ? `${id}-d` : undefined;
  return (
    <div className={cx('cp-field', !!error && 'is-error', className)}>
      <label className="cp-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cp-field-box pwa-select-box">
        <select
          {...rest}
          id={id}
          className="cp-field-input pwa-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="down" size={20} />
      </div>
      {described ? (
        <p id={described} className="cp-field-hint">
          {error ? <Icon name="alert" size={16} /> : null}
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}
