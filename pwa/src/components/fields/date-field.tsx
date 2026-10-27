'use client';
// Date field in the UI's calendar (Docs/21 C-GARAGE-05 "Date picker (Jalali for FA)", GD-10): day, month and year
// selects — Jalali months and years in FA, Gregorian in EN — that read and write an ISO calendar date
// (YYYY-MM-DD, what the API takes). The browser's <input type="date"> is Gregorian only, so it is not used.
// `min` / `max` bound the choices (e.g. a service date cannot be in the future); a partly chosen date reports ''.
// Each select is named by the legend and its part ("Owned since Year"), so several date fields can share a form.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import {
  gregorianMonthLength,
  gregorianToJalali,
  jalaliMonthLength,
  jalaliToGregorian,
  parseIsoDate,
  toIsoDate,
  type CalendarDate,
} from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';

export interface DateFieldProps {
  label: ReactNode;
  /** ISO calendar date or ''. */
  value: string;
  onChange: (iso: string) => void;
  /** ISO bounds (inclusive). */
  min?: string;
  max?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  /** Shown as the empty choice of each select; the field may be left empty. */
  optional?: boolean;
}

type Parts = { year: number | null; month: number | null; day: number | null };

function toParts(iso: string, jalali: boolean): Parts {
  const g = parseIsoDate(iso);
  if (!g) return { year: null, month: null, day: null };
  return jalali ? gregorianToJalali(g.year, g.month, g.day) : g;
}

function toGregorian(p: CalendarDate, jalali: boolean): CalendarDate {
  return jalali ? jalaliToGregorian(p.year, p.month, p.day) : p;
}

export function DateField({ label, value, onChange, min, max, hint, error, className, optional }: DateFieldProps) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const jalali = locale === 'fa';
  const id = useId();
  const [parts, setParts] = useState<Parts>(() => toParts(value, jalali));

  // Follow outside changes (a reset, a loaded record) without losing a half-chosen date.
  useEffect(() => {
    const next = toParts(value, jalali);
    setParts((cur) => (value === '' && (cur.year === null || cur.month === null || cur.day === null) ? cur : next));
  }, [value, jalali]);

  const bounds = useMemo(() => {
    const lo = toParts(min ?? '', jalali);
    const hi = toParts(max ?? '', jalali);
    const thisYear = toParts(toIsoDate({ year: new Date().getFullYear(), month: 6, day: 15 }), jalali).year!;
    return { minYear: lo.year ?? thisYear - 80, maxYear: hi.year ?? thisYear + 10 };
  }, [min, max, jalali]);

  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(jalali ? 'fa-IR-u-ca-persian' : 'en', { month: 'long', timeZone: 'UTC' });
    const year = jalali ? 1404 : 2025;
    return Array.from({ length: 12 }, (_, i) => {
      const g = toGregorian({ year, month: i + 1, day: 15 }, jalali);
      return fmt.format(Date.UTC(g.year, g.month - 1, g.day, 12));
    });
  }, [jalali]);

  const daysInMonth =
    parts.year !== null && parts.month !== null
      ? jalali
        ? jalaliMonthLength(parts.year, parts.month)
        : gregorianMonthLength(parts.year, parts.month)
      : 31;

  const update = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    if (next.year !== null && next.month !== null && next.day !== null) {
      const len = jalali ? jalaliMonthLength(next.year, next.month) : gregorianMonthLength(next.year, next.month);
      if (next.day > len) next.day = len;
    }
    setParts(next);
    if (next.year === null || next.month === null || next.day === null) return onChange('');
    let iso = toIsoDate(toGregorian(next as CalendarDate, jalali));
    if (max && iso > max) iso = max;
    if (min && iso < min) iso = min;
    onChange(iso);
  };

  const years: number[] = [];
  for (let y = bounds.maxYear; y >= bounds.minYear; y--) years.push(y);
  const described = error || hint ? `${id}-d` : undefined;
  const select = (
    name: 'day' | 'month' | 'year',
    current: number | null,
    options: { value: number; label: string }[],
    onPick: (n: number | null) => void,
  ) => (
    <div className="cp-field-box pwa-select-box">
      <span id={`${id}-${name}`} hidden>
        {t(`common.date.${name}`)}
      </span>
      <select
        className="cp-field-input pwa-select"
        aria-labelledby={`${id}-legend ${id}-${name}`}
        value={current === null ? '' : String(current)}
        onChange={(e) => onPick(e.target.value === '' ? null : Number(e.target.value))}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
      >
        <option value="">{optional ? '—' : t(`common.date.${name}`)}</option>
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="down" size={20} />
    </div>
  );

  return (
    <fieldset className={cx('cp-field pwa-date-field', !!error && 'is-error', className)}>
      <legend id={`${id}-legend`} className="cp-field-label">
        {label}
      </legend>
      <div className="pwa-date-parts">
        {select(
          'day',
          parts.day,
          Array.from({ length: daysInMonth }, (_, i) => ({ value: i + 1, label: f.digits(i + 1) })),
          (day) => update({ day }),
        )}
        {select(
          'month',
          parts.month,
          monthNames.map((label, i) => ({ value: i + 1, label })),
          (month) => update({ month }),
        )}
        {select(
          'year',
          parts.year,
          years.map((y) => ({ value: y, label: f.digits(y) })),
          (year) => update({ year }),
        )}
      </div>
      {described ? (
        <p id={described} className="cp-field-hint">
          {error ? <Icon name="alert" size={16} /> : null}
          {error || hint}
        </p>
      ) : null}
    </fieldset>
  );
}
