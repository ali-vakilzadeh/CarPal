'use client';
// PW-REQ-03 Answer sheets (provider plan PW3.T4): one bottom sheet with four tasks —
//   accept   a day and time at the shop (prefilled with the customer's first preferred window) and a duration →
//            transition confirmed. 409 CAPACITY_UNAVAILABLE shows the day's load and offers Propose time with the same
//            day and time;
//   propose  chips for 14 days, a time, a duration and an optional note → transition alternative_proposed (the note
//            also as a customer-visible message, which W-APP-01 shows);
//   decline  reason chips and an optional note → transition cancelled with cancellation_reason 'declined' (Docs/40; W-APP-01
//            then says "Declined by the shop"), then the reason in words and the note as a customer-visible message
//            (PRV-BR-05 fallback);
//   ask      a message to the customer → provider.note_create (customer_visible); the status stays.
// 409 INVALID_TRANSITION (someone else answered, the customer cancelled) closes the sheet, reloads the request and
// says what it is now. Times are wall-clock times at the shop (its location's time zone).
import type { Appointment } from '@carpal/api-contracts';
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { createFormatter, type Formatter } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { zonedToUtc } from '@/lib/format/zoned';
import { useLocale, useT } from '@/lib/i18n/client';
import {
  DECLINED,
  DECLINE_REASONS,
  DURATIONS,
  MAX_NOTE,
  MAX_REASON,
  dayLoad,
  declineText,
  defaultDuration,
  durationText,
  parseTime,
  preferredWindows,
  proposeDays,
  shopTimeZone,
  wallDate,
  wallTime,
  type DeclineReason,
} from './requests-model';

export type SheetMode = 'accept' | 'propose' | 'decline' | 'ask';

interface WhenChoice {
  date: string;
  time: string;
}

function firstPick(a: Appointment, timeZone: string, days: readonly string[], now: number): WhenChoice {
  const w = preferredWindows(a, now).find((x) => Date.parse(x.start_at) > now);
  if (w) return { date: wallDate(w.start_at, timeZone), time: wallTime(w.start_at, timeZone) };
  return { date: days[1] ?? days[0]!, time: '09:00' };
}

export function AnswerSheet({
  a,
  orgId,
  mode,
  aiDuration,
  onMode,
  onClose,
  onDone,
  onStale,
}: {
  a: Appointment;
  orgId: string;
  mode: SheetMode | null;
  aiDuration: number | null;
  onMode: (m: SheetMode) => void;
  onClose: () => void;
  /** The appointment the server answered (null after a message: the status did not change). */
  onDone: (next: Appointment | null) => void;
  /** The request changed meanwhile (409 INVALID_TRANSITION): the fresh appointment if it could be read. */
  onStale: (next: Appointment | null) => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const timeZone = shopTimeZone(a, f.timeZone);
  const shop = createFormatter(f.locale, t, timeZone);
  const [now] = useState(() => Date.now());
  const days = proposeDays(timeZone, now);
  const [pick, setPick] = useState<WhenChoice>(() => firstPick(a, timeZone, days, now));
  const [duration, setDuration] = useState(() => defaultDuration(a.estimated_duration_minutes, aiDuration));
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<DeclineReason>('fully_booked');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const path = { org_id: orgId, appointment_id: a.id };

  const start = () => {
    const hm = parseTime(pick.time);
    if (!hm) return null;
    const iso = zonedToUtc(pick.date, hm[0], timeZone, hm[1]);
    return Date.parse(iso) > Date.now() ? iso : null;
  };
  const endOf = (iso: string) => new Date(Date.parse(iso) + duration * 60_000).toISOString();

  const fail = async (err: unknown) => {
    if (err instanceof ApiProblem && err.code === 'CAPACITY_UNAVAILABLE') {
      setFull(true);
      setError(t('provider.requests.errors.capacity'));
    } else if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') {
      const fresh = await api.api('provider.appointments_get', { path }).catch(() => null);
      onStale(fresh);
    } else if (err instanceof ApiProblem && err.fields.some((x) => x.code === 'in_past')) setError(t('provider.requests.errors.past'));
    else if (err instanceof ApiProblem && err.status === 429) setError(t('provider.requests.errors.tooMany'));
    else if (err instanceof ApiProblem && err.status === 403) setError(t('provider.requests.errors.forbidden'));
    else setError(t('provider.requests.errors.failed'));
  };

  const run = async (work: () => Promise<Appointment | null>) => {
    setBusy(true);
    setError(null);
    setFull(false);
    try {
      onDone(await work());
    } catch (err) {
      await fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (mode === 'accept' || mode === 'propose') {
      const s = start();
      if (!s) return setError(t('provider.requests.errors.past'));
      if (mode === 'accept')
        return void run(() =>
          api.api('provider.appointments_transition', {
            path,
            body: { to: 'confirmed', confirmed_start_at: s, confirmed_end_at: endOf(s), estimated_duration_minutes: duration },
          }),
        );
      const text = note.trim();
      return void run(async () => {
        const next = await api.api('provider.appointments_transition', {
          path,
          body: { to: 'alternative_proposed', proposed_start_at: s, proposed_end_at: endOf(s), ...(text ? { note: text } : {}) },
        });
        // The transition's note is kept only in the status history, which W-APP-01 does not show for a proposal: send it
        // as a customer-visible message too, after the proposal succeeded (best effort; recommendation R-13).
        if (text)
          await api
            .api('provider.note_create', { path, body: { note_type: 'customer_visible', body: text, content_locale: locale } })
            .catch((err: unknown) => console.warn('proposal note not sent as a message', err));
        return next;
      });
    }
    if (mode === 'decline')
      return void run(async () => {
        const next = await api.api('provider.appointments_transition', { path, body: { to: 'cancelled', cancellation_reason: DECLINED } });
        // PRV-BR-05 fallback: the reason in words and the shop's note as a customer-visible message, after the decline
        // succeeded (a note sent first would stay behind if the transition failed); best effort.
        await api
          .api('provider.note_create', {
            path,
            body: {
              note_type: 'customer_visible',
              body: declineText(t(`provider.requests.decline.reasons.${reason}`), note),
              content_locale: locale,
            },
          })
          .catch((err: unknown) => console.warn('decline reason not sent as a message', err));
        return next;
      });
    const body = note.trim();
    if (!body) return setError(t('provider.requests.errors.emptyMessage'));
    return void run(async () => {
      await api.api('provider.note_create', { path, body: { note_type: 'customer_visible', body, content_locale: locale } });
      return null;
    });
  };

  const title = mode ? t(`provider.requests.sheets.${mode}.title`) : '';
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      name="request-answer"
      variant="sheet"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('provider.requests.sheets.cancel')}
          </Button>
          {full && mode === 'accept' ? (
            <Button
              onClick={() => {
                setError(null);
                setFull(false);
                onMode('propose');
              }}
            >
              {t('provider.requests.actions.propose')}
            </Button>
          ) : null}
          <Button variant={mode === 'decline' ? 'secondary' : 'primary'} loading={busy} onClick={submit} data-testid="sheet-submit">
            {mode ? t(`provider.requests.sheets.${mode}.submit`) : ''}
          </Button>
        </>
      }
    >
      <div className="pwa-stack">
        {mode === 'accept' || mode === 'propose' ? (
          <>
            <WhenPicker a={a} mode={mode} days={days} pick={pick} onPick={setPick} shop={shop} timeZone={timeZone} now={now} />
            <fieldset className="pwa-ws-fieldset">
              <legend className="pwa-text-label">{t('provider.requests.sheets.duration')}</legend>
              <div className="pwa-ws-chips">
                {DURATIONS.map((d) => (
                  <Chip key={d} selected={d === duration} onClick={() => setDuration(d)}>
                    {durationText(t, d)}
                  </Chip>
                ))}
              </div>
              {aiDuration ? (
                <p className="pwa-text-caption m-0">{t('provider.requests.sheets.aiDuration', { time: durationText(t, aiDuration) })}</p>
              ) : null}
            </fieldset>
            <DayLoadLine orgId={orgId} date={pick.date} appointment={a} />
            {mode === 'propose' ? (
              <TextField
                multiline
                rows={2}
                label={t('provider.requests.sheets.propose.note')}
                hint={t('provider.requests.sheets.propose.noteHint')}
                value={note}
                maxLength={MAX_REASON}
                onChange={(e) => setNote(e.target.value)}
              />
            ) : null}
          </>
        ) : null}
        {mode === 'decline' ? (
          <>
            <fieldset className="pwa-ws-fieldset">
              <legend className="pwa-text-label">{t('provider.requests.decline.reason')}</legend>
              <div className="pwa-ws-chips">
                {DECLINE_REASONS.map((r) => (
                  <Chip key={r} selected={r === reason} onClick={() => setReason(r)}>
                    {t(`provider.requests.decline.reasons.${r}`)}
                  </Chip>
                ))}
              </div>
            </fieldset>
            <TextField
              multiline
              rows={2}
              label={t('provider.requests.decline.note')}
              hint={t('provider.requests.decline.noteHint')}
              value={note}
              maxLength={MAX_REASON - 40}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        ) : null}
        {mode === 'ask' ? (
          <TextField
            multiline
            rows={3}
            label={t('provider.requests.sheets.ask.label')}
            hint={t('provider.requests.sheets.ask.hint')}
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
          />
        ) : null}
        {error ? (
          <p className="pwa-error-text m-0" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Day chips (14 days at the shop), the customer's windows as quick picks (Accept), and a time field. */
function WhenPicker({
  a,
  mode,
  days,
  pick,
  onPick,
  shop,
  timeZone,
  now,
}: {
  a: Appointment;
  mode: 'accept' | 'propose';
  days: readonly string[];
  pick: WhenChoice;
  onPick: (p: WhenChoice) => void;
  shop: Formatter;
  timeZone: string;
  now: number;
}) {
  const t = useT();
  const windows = preferredWindows(a, now).filter((w) => Date.parse(w.start_at) > now);
  // Keep the chosen day in sight in the scrolling row (a preferred window may be a week ahead).
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pick.date]);
  return (
    <>
      {mode === 'accept' && windows.length ? (
        <fieldset className="pwa-ws-fieldset">
          <legend className="pwa-text-label">{t('provider.requests.sheets.theirTimes')}</legend>
          <div className="pwa-ws-chips">
            {windows.map((w) => {
              const p = { date: wallDate(w.start_at, timeZone), time: wallTime(w.start_at, timeZone) };
              return (
                <Chip key={w.id} selected={p.date === pick.date && p.time === pick.time} onClick={() => onPick(p)}>
                  {shop.date(w.start_at, 'weekdayDate')} {shop.date(w.start_at, 'time')}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <fieldset className="pwa-ws-fieldset">
        <legend className="pwa-text-label">{t('provider.requests.sheets.day')}</legend>
        <div className="pwa-ws-days" data-testid="day-chips" ref={row}>
          {days.map((d) => (
            <Chip key={d} selected={d === pick.date} onClick={() => onPick({ ...pick, date: d })}>
              {shop.calendarDate(d, 'dateShort')}
            </Chip>
          ))}
        </div>
      </fieldset>
      <TextField
        type="time"
        label={t('provider.requests.sheets.time')}
        value={pick.time}
        step={900}
        onChange={(e) => onPick({ ...pick, time: e.target.value })}
      />
    </>
  );
}

/** The chosen day's load at the shop (provider.calendar, one day): visits booked, slots taken, time off. */
function DayLoadLine({ orgId, date, appointment }: { orgId: string; date: string; appointment: Appointment }) {
  const t = useT();
  const f = useFormat();
  const loc = appointment.provider_location?.id;
  const q = useApiQuery(
    'provider.calendar',
    { path: { org_id: orgId }, query: { from: date, to: date, ...(loc ? { location_id: loc } : {}) } },
    { staleTime: 30_000 },
  );
  if (q.isPending) return <p className="pwa-text-caption m-0">{t('provider.requests.load.loading')}</p>;
  if (!q.data) return <p className="pwa-text-caption m-0">{t('provider.requests.load.failed')}</p>;
  const l = dayLoad(q.data, appointment.id);
  const parts = [
    t('provider.requests.load.visits', { count: l.visits }),
    l.max !== null ? t('provider.requests.load.slots', { used: l.used ?? 0, max: l.max }) : null,
  ].filter(Boolean);
  return (
    <Banner
      tone={l.timeOff || (l.max !== null && (l.used ?? 0) >= l.max) ? 'warn' : 'plain'}
      icon="calendar"
      title={t('provider.requests.load.title', { day: f.calendarDate(date, 'dateShort') })}
      text={[l.timeOff ? t('provider.requests.load.timeOff') : null, ...parts].filter(Boolean).join(' · ')}
    />
  );
}
