'use client';
// The preferred-times picker (P10.T3, Docs/22 W-HELP-01 request step; C-HELP-07 "Available slots from provider";
// C-APP-04 "Suggest another time"): the shop's next 14 days as a grid of days (each with its number of openings),
// the openings of the chosen day as toggles, and the chosen windows in priority order (up to 3). A shop without
// published openings (no availability rules, BA-19) gets "Request anyway": a day and a part of the day, read as
// local time at the shop. Slots come from public.availability (computed per request; never cached long).
import type { AppointmentType, Slot } from '@carpal/api-contracts';
import { useEffect, useId, useMemo, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { IconButton } from '@/components/ds/icon-button';
import { SkeletonCard } from '@/components/shell/skeleton';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { todayIso } from '@/lib/format/jalali';
import { useT } from '@/lib/i18n/client';
import { choiceKey, DAY_PARTS, GRID_DAYS, MAX_WINDOWS, slotGrid, toggleChoice, zonedToUtc, type DayPart, type WindowChoice } from './times';

export interface TimesPickerProps {
  orgId: string;
  locationId: string | null;
  /** The shop's time zone (PublicLocation.timezone). */
  timeZone: string;
  value: readonly WindowChoice[];
  onChange: (next: WindowChoice[]) => void;
  appointmentType?: AppointmentType;
  /** Shown under the heading when the form could not be sent without a time. */
  error?: string | null;
  /** Called once with the loaded slots (e.g. to turn a slot picked on the profile into a choice). */
  onSlots?: (slots: readonly Slot[]) => void;
}

export function useAvailability(orgId: string, locationId: string | null, timeZone: string, appointmentType?: AppointmentType) {
  return useApiQuery(
    'public.availability',
    locationId
      ? {
          path: { org_id: orgId },
          query: {
            location_id: locationId,
            from: todayIso(timeZone),
            days: GRID_DAYS,
            ...(appointmentType ? { appointment_type: appointmentType } : {}),
          },
        }
      : undefined,
    { enabled: !!locationId, staleTime: 60_000 },
  );
}

export function TimesPicker({ orgId, locationId, timeZone, value, onChange, appointmentType, error, onSlots }: TimesPickerProps) {
  const t = useT();
  const f = useFormat();
  const headingId = useId();
  const q = useAvailability(orgId, locationId, timeZone, appointmentType);
  const slots = useMemo(() => q.data?.slots ?? [], [q.data]);
  const grid = useMemo(() => slotGrid(slots, timeZone), [slots, timeZone]);
  const firstOpen = grid.find((d) => d.slots.length)?.date ?? grid[0]?.date ?? '';
  const [day, setDay] = useState<string | null>(null);
  const shownDay = day ?? firstOpen;
  const noSlots = !locationId || q.isError || (q.isSuccess && slots.length === 0);
  const full = value.length >= MAX_WINDOWS;

  useEffect(() => {
    if (q.isSuccess) onSlots?.(q.data.slots);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new answer arrives
  }, [q.data]);

  const dayLabel = (date: string, style: 'weekdayDate' | 'dateShort' = 'weekdayDate') => f.date(zonedToUtc(date, 12, timeZone), style);
  const choiceLabel = (c: WindowChoice) =>
    c.kind === 'slot'
      ? t('appointments.times.slotChoice', { day: f.date(c.start, 'weekdayDate'), time: f.date(c.start, 'time') })
      : t('appointments.times.partChoice', { day: dayLabel(c.date), part: t(`appointments.times.part.${c.part}`) });

  return (
    <section className="pwa-stack-sm" aria-labelledby={headingId}>
      <div className="pwa-stack-xs">
        <h3 id={headingId} className="pwa-text-label m-0">
          {t('appointments.times.title')}
        </h3>
        <p className="pwa-text-caption m-0">
          {noSlots ? t('appointments.times.anywayHint', { count: MAX_WINDOWS }) : t('appointments.times.hint', { count: MAX_WINDOWS })}
        </p>
        {error ? (
          <p className="pwa-error-text m-0" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {locationId && q.isPending ? <SkeletonCard lines={3} /> : null}
      {!noSlots && q.isSuccess ? (
        <>
          <div className="pwa-days" role="group" aria-label={t('appointments.times.days')}>
            {grid.map((d) => (
              <button
                key={d.date}
                type="button"
                className={cx('pwa-day', d.date === shownDay && 'is-selected', d.slots.length === 0 && 'is-empty')}
                aria-pressed={d.date === shownDay}
                onClick={() => setDay(d.date)}
              >
                <span className="pwa-day-name">{dayLabel(d.date)}</span>
                <span className="pwa-text-caption">
                  {d.slots.length ? t('appointments.times.openings', { count: d.slots.length }) : t('appointments.times.none')}
                </span>
              </button>
            ))}
          </div>
          <div className="pwa-stack-xs">
            <span className="pwa-text-caption">{t('appointments.times.slotsOf', { day: dayLabel(shownDay) })}</span>
            {grid.find((d) => d.date === shownDay)?.slots.length ? (
              <ul className="pwa-plain-list pwa-slots" aria-label={t('appointments.times.slotsOf', { day: dayLabel(shownDay) })}>
                {grid
                  .find((d) => d.date === shownDay)!
                  .slots.map((s) => {
                    const c: WindowChoice = { kind: 'slot', start: s.start_at, end: s.end_at };
                    const on = value.some((x) => choiceKey(x) === choiceKey(c));
                    return (
                      <li key={`${s.location_id}-${s.start_at}`}>
                        <button
                          type="button"
                          className={cx('cp-chip pwa-slot', on && 'is-selected')}
                          aria-pressed={on}
                          disabled={!on && full}
                          aria-label={`${dayLabel(shownDay)} ${f.date(s.start_at, 'time')}`}
                          onClick={() => onChange(toggleChoice(value, c))}
                        >
                          {f.date(s.start_at, 'time')}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            ) : (
              <p className="pwa-text-caption m-0">{t('appointments.times.dayEmpty')}</p>
            )}
          </div>
        </>
      ) : null}
      {noSlots && !(locationId && q.isPending) ? (
        <RequestAnyway
          grid={grid.map((d) => d.date)}
          dayLabel={dayLabel}
          value={value}
          onChange={onChange}
          full={full}
          failed={q.isError}
        />
      ) : null}
      {value.length ? (
        <ol className="pwa-plain-list pwa-choices" aria-label={t('appointments.times.chosen')}>
          {value.map((c, i) => (
            <li key={choiceKey(c)} className="pwa-choice">
              <span className="pwa-choice-rank">{t('appointments.times.priority', { n: f.number(i + 1) })}</span>
              <span className="pwa-text-body">{choiceLabel(c)}</span>
              <IconButton
                icon="close"
                label={t('appointments.times.remove', { time: choiceLabel(c) })}
                onClick={() => onChange(value.filter((x) => choiceKey(x) !== choiceKey(c)))}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

const PARTS = Object.keys(DAY_PARTS) as DayPart[];

function RequestAnyway({
  grid,
  dayLabel,
  value,
  onChange,
  full,
  failed,
}: {
  grid: readonly string[];
  dayLabel: (date: string) => string;
  value: readonly WindowChoice[];
  onChange: (next: WindowChoice[]) => void;
  full: boolean;
  failed: boolean;
}) {
  const t = useT();
  const f = useFormat();
  const days = grid.length ? grid : [];
  const [date, setDate] = useState(days[1] ?? days[0] ?? '');
  const [part, setPart] = useState<DayPart>('morning');
  const dateId = useId();
  const partId = useId();
  const chosen = value.some((c) => c.kind === 'part' && c.date === date && c.part === part);
  return (
    <div className="pwa-stack-sm">
      <Banner tone="info" icon="calendar" text={failed ? t('appointments.times.loadFailed') : t('appointments.times.noSlots')} />
      <div className="pwa-anyway">
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={dateId}>
            {t('appointments.times.day')}
          </label>
          <div className="cp-field-box">
            <select id={dateId} className="cp-field-input" value={date} onChange={(e) => setDate(e.target.value)}>
              {days.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={partId}>
            {t('appointments.times.partOfDay')}
          </label>
          <div className="cp-field-box">
            <select id={partId} className="cp-field-input" value={part} onChange={(e) => setPart(e.target.value as DayPart)}>
              {PARTS.map((p) => (
                <option key={p} value={p}>
                  {t('appointments.times.partRange', {
                    part: t(`appointments.times.part.${p}`),
                    from: f.digits(String(DAY_PARTS[p][0]).padStart(2, '0') + ':00'),
                    to: f.digits(String(DAY_PARTS[p][1]).padStart(2, '0') + ':00'),
                  })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button icon="plus" disabled={!date || full || chosen} onClick={() => onChange(toggleChoice(value, { kind: 'part', date, part }))}>
          {t('appointments.times.add')}
        </Button>
      </div>
    </div>
  );
}
