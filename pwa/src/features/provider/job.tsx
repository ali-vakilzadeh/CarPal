'use client';
// PW-JOB-01 Update job (provider plan PW4.T2, T4; mirrors P-REQ-02 status actions; Docs/11 Ch.6-7) at
// /<locale>/provider/jobs/<id>: a booked visit as a job — the customer, the car, the booked time at the shop, the job
// status bar (business-ui) with the buttons the server allows (allowed_transitions): Car arrived, Start work, Ready for
// pickup, Close job (close-job.tsx), Awaiting parts (a sheet: note, estimated completion, cost range), No-show (asks
// first; only from the booked time on) and Cancel visit (with a reason). After closing: the job is done, the customer
// gets the review invitation (appointment.completed), and 'Add before/after photos' leads to PW7.
// 409 INVALID_TRANSITION (someone else moved the job) reloads and says what it is now; 403 says to ask the owner.
// Any member may update a job when the server allows it (ORG(P*); PW4 acceptance).
import type { Appointment, AppointmentStatus, AppointmentTransition } from '@carpal/api-contracts';
import { JobStatusBar, StatusChip, appointmentTone, type JobAction } from '@carpal/business-ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useRegion } from '@/lib/config/client';
import { createFormatter, type Formatter } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { zonedToUtc } from '@/lib/format/zoned';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useActiveBusiness } from './context';
import { JOB_STEPS, awaitingParts, jobActions, jobStep, isOpenJob, type JobActionSpec, type PartsError } from './job-model';
import { isSafetyCritical, workshopPath } from './model';
import { MAX_REASON, parseTime, proposeDays, requestSubject, shopTimeZone, vehicleLine } from './requests-model';

const POLL_MS = 30_000;

type Sheet = 'parts' | 'cancel' | 'no_show';

/** The words of a failed status change; INVALID_TRANSITION is handled by the caller (reload and say what changed). */
function failureKey(err: unknown): MessageKey {
  if (err instanceof ApiProblem && err.status === 403) return 'provider.jobs.errors.forbidden';
  if (err instanceof ApiProblem && err.status === 429) return 'provider.jobs.errors.tooMany';
  if (err instanceof ApiProblem && err.code === 'NETWORK') return 'provider.jobs.errors.offline';
  return 'provider.jobs.errors.failed';
}

export function WorkshopJob({ appointmentId }: { appointmentId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { orgId } = useActiveBusiness();
  const path = { org_id: orgId, appointment_id: appointmentId };
  const q = useApiQuery('provider.appointments_get', { path }, { refetchOnWindowFocus: true, staleTime: 10_000, refetchInterval: POLL_MS });
  const a = q.data;
  const [busy, setBusy] = useState<AppointmentStatus | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [opened, setOpened] = useState(0);
  const [error, setError] = useState<MessageKey | null>(null);
  const [changedTo, setChangedTo] = useState<string | null>(null);

  const changed = (next: Appointment) => {
    queryClient.setQueryData(apiQueryKey('provider.appointments_get', { path }), next);
    void queryClient.invalidateQueries({ queryKey: ['provider.appointments_list'] });
  };

  /** A 409 INVALID_TRANSITION: reload and say what the job is now. */
  const stale = async () => {
    setSheet(null);
    const fresh = await api.api('provider.appointments_get', { path }).catch(() => null);
    if (fresh) {
      changed(fresh);
      setChangedTo(t(`provider.status.${fresh.status}` as MessageKey));
    } else void q.refetch();
  };

  const move = async (body: AppointmentTransition) => {
    setBusy(body.to as AppointmentStatus);
    setError(null);
    setChangedTo(null);
    try {
      changed(await api.api('provider.appointments_transition', { path, body }));
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') await stale();
      else setError(failureKey(err));
    } finally {
      setBusy(null);
    }
  };

  const back = (
    <Link href={workshopPath(locale, 'today')} className="pwa-link pwa-ws-back">
      <Icon name="back" size={20} /> {t('provider.jobs.back')}
    </Link>
  );

  if (!a) {
    if (q.isPending) return <SkeletonCard lines={6} />;
    return (
      <div className="pwa-ws-page">
        {back}
        <StateView kind={stateFromProblem(q.error)} t={t} />
      </div>
    );
  }

  const shop = createFormatter(f.locale, t, shopTimeZone(a, f.timeZone));
  // The time of the last read (it advances with the 30 s poll), so No-show appears once the booked time has passed.
  const specs = jobActions(a, q.dataUpdatedAt);
  const actions: JobAction[] = specs.map((s) => ({
    key: s.to,
    label: t(`provider.jobs.actions.${s.to}` as MessageKey),
    variant: s.primary ? 'primary' : s.kind === 'cancel' || s.kind === 'confirm' ? 'ghost' : 'secondary',
    busy: busy === s.to,
    disabled: busy !== null && busy !== s.to,
    onClick: () => open(s),
  }));
  function open(s: JobActionSpec) {
    setError(null);
    if (s.kind === 'direct') return void move({ to: s.to } as AppointmentTransition);
    if (s.kind === 'close') return; // a link (closeHref), not a bar button
    setOpened((n) => n + 1);
    setSheet(s.kind === 'parts' ? 'parts' : s.kind === 'cancel' ? 'cancel' : 'no_show');
  }
  // Close job is a page of its own (many fields on a phone): the button is a link there.
  const closeHref = workshopPath(locale, `jobs/${encodeURIComponent(a.id)}/close`);
  const canClose = specs.some((s) => s.kind === 'close');
  const barActions = actions.filter((x) => x.key !== 'completed');
  const step = jobStep(a.status);

  return (
    <article className="pwa-ws-page pwa-ws-request" aria-labelledby="job-title">
      {back}
      {isSafetyCritical(a) ? <Banner tone="danger" icon="alert" title={t('provider.requests.detail.safetyTitle')} /> : null}
      <header className="pwa-stack-xs">
        <h1 id="job-title" className="pwa-ws-title">
          <bdi>{a.requester_display}</bdi>
        </h1>
        <p className="pwa-text-body m-0">
          <Icon name="car" size={20} /> <bdi>{vehicleLine(a.vehicle, f.digits)}</bdi>
        </p>
        <p className="pwa-text-body m-0" dir="auto" lang={a.content_locale}>
          <Icon name="wrench" size={20} /> {requestSubject(a)}
        </p>
        <span className="pwa-badges">
          <StatusChip label={t(`provider.status.${a.status}` as MessageKey)} tone={appointmentTone(a.status)} />
          {a.confirmed_start_at ? (
            <span className="pwa-text-caption">{t('provider.jobs.booked', { time: shop.date(a.confirmed_start_at, 'dateTime') })}</span>
          ) : null}
        </span>
      </header>

      {changedTo ? <Banner tone="warn" icon="info" text={t('provider.jobs.errors.changed', { status: changedTo })} /> : null}

      {step >= 0 ? (
        <JobStatusBar
          label={t('provider.jobs.progress')}
          steps={JOB_STEPS.map((k) => ({ key: k, label: t(`provider.jobs.steps.${k}`) }))}
          current={step}
          mark={a.status === 'awaiting_parts' ? t('provider.status.awaiting_parts') : undefined}
          actionsLabel={t('provider.jobs.update')}
          actions={barActions}
        >
          {a.status === 'awaiting_parts' ? <PartsInfo a={a} shop={shop} /> : null}
          {canClose ? (
            <Link href={closeHref} className={buttonClass({ variant: a.status === 'ready_for_pickup' ? 'primary' : 'secondary' })}>
              <Icon name="check" size={20} />
              <span className="cp-btn-label">{t('provider.jobs.actions.completed')}</span>
            </Link>
          ) : null}
        </JobStatusBar>
      ) : null}

      {error ? (
        <p className="pwa-error-text m-0" role="alert">
          {t(error)}
        </p>
      ) : null}

      {a.status === 'completed' ? <Closed a={a} shop={shop} /> : null}
      {a.status === 'no_show' ? <Banner tone="warn" icon="info" text={t('provider.jobs.noShowDone')} /> : null}
      {a.status === 'cancelled' ? (
        <Banner
          tone="warn"
          icon="info"
          text={
            a.cancelled_by === 'provider'
              ? t('provider.jobs.cancelledByShop', { reason: a.cancellation_reason ?? '' })
              : t('provider.jobs.cancelledByCustomer')
          }
        />
      ) : null}

      <p className="m-0">
        <Link href={workshopPath(locale, `requests/${encodeURIComponent(a.id)}`)} className="pwa-link">
          {t('provider.jobs.openRequest')}
        </Link>
      </p>

      {isOpenJob(a) ? (
        <JobSheet
          key={opened}
          a={a}
          orgId={orgId}
          sheet={sheet}
          onClose={() => setSheet(null)}
          onDone={(next) => {
            setSheet(null);
            setChangedTo(null);
            changed(next);
          }}
          onStale={() => void stale()}
        />
      ) : null}
    </article>
  );
}

/** Awaiting parts: the note, the estimated completion at the shop and the cost estimate the customer sees. */
function PartsInfo({ a, shop }: { a: Appointment; shop: Formatter }) {
  const t = useT();
  const f = useFormat();
  const when = a.estimated_completion_to ?? a.estimated_completion_from;
  return (
    <div className="pwa-stack-xs" data-testid="parts-info">
      {a.parts_availability_note ? (
        <p className="pwa-text-body m-0 pwa-user-text" dir="auto">
          {a.parts_availability_note}
        </p>
      ) : null}
      {when ? <p className="pwa-text-caption m-0">{t('provider.jobs.parts.eta', { time: shop.date(when, 'dateTime') })}</p> : null}
      {a.cost_estimate ? (
        <p className="pwa-text-caption m-0">
          {t('provider.jobs.parts.estimate', { amount: f.money(a.cost_estimate.amount, a.cost_estimate.currency) })}
        </p>
      ) : null}
    </div>
  );
}

/** T4: after closing — the record, the review invitation and the before/after shortcut (PW7). */
function Closed({ a, shop }: { a: Appointment; shop: Formatter }) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="pwa-stack-sm" data-testid="job-closed">
      <Banner
        tone="success"
        icon="check"
        title={
          a.completed_at
            ? t('provider.jobs.closed.title', { time: shop.date(a.completed_at, 'dateTime') })
            : t('provider.jobs.closed.titleNoTime')
        }
        text={a.service_record_id ? t('provider.jobs.closed.record') : t('provider.jobs.closed.noRecord')}
      />
      <Banner tone="info" icon="star" text={t('provider.jobs.closed.review', { name: a.requester_display })} />
      <div>
        <Link
          href={workshopPath(locale, `photos/new?appointment=${encodeURIComponent(a.id)}`)}
          className={buttonClass({ variant: 'primary' })}
          data-testid="add-photos"
        >
          <Icon name="camera" size={20} />
          <span className="cp-btn-label">{t('provider.jobs.closed.photos')}</span>
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- sheets

function JobSheet({
  a,
  orgId,
  sheet,
  onClose,
  onDone,
  onStale,
}: {
  a: Appointment;
  orgId: string;
  sheet: Sheet | null;
  onClose: () => void;
  onDone: (next: Appointment) => void;
  onStale: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const region = useRegion();
  const timeZone = shopTimeZone(a, f.timeZone);
  const shop = createFormatter(f.locale, t, timeZone);
  const [now] = useState(() => Date.now());
  const days = proposeDays(timeZone, now);
  const [day, setDay] = useState(days[0]!);
  const [time, setTime] = useState('');
  const [note, setNote] = useState(a.parts_availability_note ?? '');
  const [costFrom, setCostFrom] = useState('');
  const [costTo, setCostTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [fieldError, setFieldError] = useState<PartsError | null>(null);
  const path = { org_id: orgId, appointment_id: a.id };

  const run = async (work: () => Promise<Appointment>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await work());
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') onStale();
      else if (err instanceof ApiProblem && err.fields.some((x) => x.pointer.startsWith('/estimated_completion'))) setFieldError('past');
      else setError(failureKey(err));
    } finally {
      setBusy(false);
    }
  };

  const completionAt = () => {
    const hm = parseTime(time);
    return hm ? zonedToUtc(day, hm[0], timeZone, hm[1]) : null;
  };

  const submit = () => {
    setFieldError(null);
    if (sheet === 'no_show') return void run(() => api.api('provider.appointments_transition', { path, body: { to: 'no_show' } }));
    if (sheet === 'cancel') {
      const text = reason.trim().replace(/[\r\n]+/g, ' ');
      if (!text) return setError('provider.jobs.cancel.required');
      return void run(() =>
        api.api('provider.appointments_transition', { path, body: { to: 'cancelled', cancellation_reason: text.slice(0, MAX_REASON) } }),
      );
    }
    const r = awaitingParts({ note, completionAt: time.trim() ? completionAt() : null, costFrom, costTo }, (from, to) =>
      t('provider.jobs.parts.range', { from: f.money(from, region.currency), to: f.money(to, region.currency) }),
    );
    if ('error' in r) return setFieldError(r.error);
    return void run(async () => {
      const next = await api.api('provider.appointments_transition', { path, body: r.body });
      if (!r.estimate) return next;
      // The contract's transition has no cost: the upper end of the range is the appointment's cost estimate (W-APP-01
      // shows it). Best effort after the status changed; the range is in the note either way.
      return api
        .api('provider.appointments_update', {
          path,
          body: { cost_estimate: { amount: r.estimate, currency: region.currency } },
          ifMatch: `"v${next.version}"`,
        })
        .catch((err: unknown) => {
          console.warn('cost estimate not saved', err);
          return next;
        });
    });
  };

  const partsError =
    fieldError === 'costFrom' || fieldError === 'costTo'
      ? t('provider.jobs.parts.errors.amount')
      : fieldError === 'costOrder'
        ? t('provider.jobs.parts.errors.order')
        : undefined;

  return (
    <Dialog
      open={sheet !== null}
      onClose={onClose}
      name="job-update"
      variant="sheet"
      title={sheet ? t(`provider.jobs.sheets.${sheet}.title`) : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('provider.requests.sheets.cancel')}
          </Button>
          <Button variant={sheet === 'parts' ? 'primary' : 'secondary'} loading={busy} onClick={submit} data-testid="job-sheet-submit">
            {sheet ? t(`provider.jobs.sheets.${sheet}.submit`) : ''}
          </Button>
        </>
      }
    >
      <div className="pwa-stack">
        {sheet === 'parts' ? (
          <>
            <TextField
              multiline
              rows={3}
              label={t('provider.jobs.parts.note')}
              hint={t('provider.jobs.parts.noteHint')}
              value={note}
              maxLength={400}
              onChange={(e) => setNote(e.target.value)}
            />
            <fieldset className="pwa-ws-fieldset">
              <legend className="pwa-text-label">{t('provider.jobs.parts.when')}</legend>
              <div className="pwa-ws-days" data-testid="eta-days">
                {days.map((d) => (
                  <Chip key={d} selected={d === day} onClick={() => setDay(d)}>
                    {shop.calendarDate(d, 'dateShort')}
                  </Chip>
                ))}
              </div>
              <TextField
                type="time"
                label={t('provider.jobs.parts.time')}
                hint={t('provider.jobs.parts.timeHint')}
                value={time}
                step={900}
                onChange={(e) => setTime(e.target.value)}
                error={fieldError === 'past' ? t('provider.jobs.parts.errors.past') : undefined}
              />
            </fieldset>
            <fieldset className="pwa-ws-fieldset">
              <legend className="pwa-text-label">{t('provider.jobs.parts.cost')}</legend>
              <div className="pwa-form-grid">
                <TextField
                  label={t('provider.jobs.parts.costFrom')}
                  value={costFrom}
                  inputMode="decimal"
                  onChange={(e) => setCostFrom(e.target.value)}
                  end={<span className="pwa-text-caption">{region.currency}</span>}
                  error={fieldError === 'costFrom' || fieldError === 'costOrder' ? partsError : undefined}
                />
                <TextField
                  label={t('provider.jobs.parts.costTo')}
                  value={costTo}
                  inputMode="decimal"
                  onChange={(e) => setCostTo(e.target.value)}
                  end={<span className="pwa-text-caption">{region.currency}</span>}
                  error={fieldError === 'costTo' ? partsError : undefined}
                />
              </div>
              <p className="pwa-text-caption m-0">{t('provider.jobs.parts.costHint')}</p>
            </fieldset>
          </>
        ) : null}
        {sheet === 'cancel' ? (
          <TextField
            multiline
            rows={2}
            label={t('provider.jobs.cancel.reason')}
            hint={t('provider.jobs.cancel.hint')}
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : null}
        {sheet === 'no_show' ? <p className="pwa-text-body m-0">{t('provider.jobs.sheets.no_show.text')}</p> : null}
        {error ? (
          <p className="pwa-error-text m-0" role="alert">
            {t(error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
