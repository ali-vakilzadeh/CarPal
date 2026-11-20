'use client';
// The period of a metrics view (AC13, dataviz "date range first"): presets (today, last 7/30/90 days) and a custom
// range of calendar days, kept in the URL (?range=7 or ?from=…&to=…) so a view can be linked. Days are the viewer's
// (the region's time zone), not UTC.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ds/button';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { checkRange, isRangePreset, presetRange, RANGE_PRESETS, type DayRange, type RangePreset } from './analytics-logic';

export type PeriodChoice = { kind: 'preset'; preset: RangePreset } | { kind: 'custom'; from: string; to: string };

export interface Period {
  choice: PeriodChoice;
  range: DayRange;
}

/** The period in the URL (a valid custom range wins over a preset), else the default preset. */
export function useUrlPeriod(defaultPreset: RangePreset, presets: readonly RangePreset[] = RANGE_PRESETS) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const f = useFormat();
  // The day is fixed when the view opens (a page left open over midnight keeps its period until it is changed).
  const [now] = useState(() => Date.now());
  const from = params.get('from');
  const to = params.get('to');
  const preset = params.get('range');
  const period: Period = useMemo(() => {
    if (from && to && checkRange(from, to) === null) return { choice: { kind: 'custom', from, to }, range: { from, to } };
    const p = isRangePreset(preset) && presets.includes(preset) ? preset : defaultPreset;
    return { choice: { kind: 'preset', preset: p }, range: presetRange(p, now, f.timeZone) };
  }, [from, to, preset, presets, defaultPreset, now, f.timeZone]);

  const setChoice = useCallback(
    (c: PeriodChoice) => {
      const p = new URLSearchParams(params);
      p.delete('from');
      p.delete('to');
      p.delete('range');
      if (c.kind === 'custom') {
        p.set('from', c.from);
        p.set('to', c.to);
      } else if (c.preset !== defaultPreset) p.set('range', c.preset);
      const q = p.toString();
      router.replace(`${pathname}${q ? `?${q}` : ''}`, { scroll: false });
    },
    [params, router, pathname, defaultPreset],
  );
  return { ...period, setChoice };
}

export function PeriodControl({
  value,
  onChange,
  presets = RANGE_PRESETS,
  custom = true,
}: {
  value: PeriodChoice;
  onChange: (c: PeriodChoice) => void;
  presets?: readonly RangePreset[];
  custom?: boolean;
}) {
  const t = useT();
  const uid = useId();
  const [draft, setDraft] = useState({ from: value.kind === 'custom' ? value.from : '', to: value.kind === 'custom' ? value.to : '' });
  const [open, setOpen] = useState(value.kind === 'custom');
  const [tried, setTried] = useState(false);
  const problem = checkRange(draft.from, draft.to);
  const selected = value.kind === 'custom' || open ? 'custom' : value.preset;
  return (
    <div className="adm-period" data-testid="period">
      <div className="adm-filter">
        <label htmlFor={`${uid}-period`}>{t('admin.analytics.period.label')}</label>
        <select
          id={`${uid}-period`}
          className="adm-select"
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') setOpen(true);
            else if (isRangePreset(v)) {
              setOpen(false);
              onChange({ kind: 'preset', preset: v });
            }
          }}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`admin.analytics.period.${p === 'today' ? 'today' : `last${p}`}` as MessageKey)}
            </option>
          ))}
          {custom ? <option value="custom">{t('admin.analytics.period.custom')}</option> : null}
        </select>
      </div>
      {custom && open ? (
        <form
          className="adm-period-custom"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (problem === null) onChange({ kind: 'custom', from: draft.from, to: draft.to });
          }}
        >
          <div className="adm-filter">
            <label htmlFor={`${uid}-from`}>{t('admin.analytics.period.from')}</label>
            <input
              id={`${uid}-from`}
              type="date"
              className="adm-input"
              dir="ltr"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </div>
          <div className="adm-filter">
            <label htmlFor={`${uid}-to`}>{t('admin.analytics.period.to')}</label>
            <input
              id={`${uid}-to`}
              type="date"
              className="adm-input"
              dir="ltr"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </div>
          <Button size="sm" type="submit">
            {t('admin.analytics.period.apply')}
          </Button>
          {tried && problem ? (
            <p className="adm-error" role="alert">
              {t(`admin.analytics.period.problem.${problem}` as MessageKey)}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

/** "12 Aban – 18 Aban 1405" (or one day) for headings. */
export function useRangeText(range: DayRange): string {
  const f = useFormat();
  const t = useT();
  return range.from === range.to
    ? f.calendarDate(range.from)
    : t('admin.analytics.period.between', { from: f.calendarDate(range.from), to: f.calendarDate(range.to) });
}
