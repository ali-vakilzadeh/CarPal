'use client';
// W-APP-01 appointment detail (Docs/22 W-APP-01, Docs/21 C-APP-02..04; P10.T4): the status and what happens next, the
// action card (accept the shop's proposed time, suggest another, decline; send or discard a draft; I've arrived and
// Running late; the completed visit's service record), the status timeline, when and where with the map preview,
// Directions and Add to calendar, the vehicle and issue with the pre-visit report drawer, and the notes thread.
// Live status: the appointment, its history and notes are read again every 30 s while it is open and the tab is
// visible (TanStack pauses in background tabs; the client paces by CarPal-Poll-After-Ms). 404 = not found (SEC-AZ-2).
import type { Appointment, AppointmentNote } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Urgency } from '@/components/ds/urgency';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { saveHelpDraft } from '@/features/onboarding';
import { CallButton, DirectionsMenu, StaticMapPreview, addressLine } from '@/features/profiles';
import { reviewHref } from '@/features/reviews';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { goTo } from '@/lib/browser-nav';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { orgPath } from '@/lib/seo/urls';
import { CalendarMenu } from './calendar-menu';
import { ChangeDialog, type ChangeMode } from './change-dialog';
import { actionsOf, calendarEvent, checkInLater, checkInOpensAt, pollInterval, reference, timeline, visitTime } from './model';
import { PreVisitDrawer } from './pre-visit';
import { AppointmentStatusBadge, statusLabel, uiLevelOf } from './status';

const MAX_NOTE = 3000;

/** "Silver · BMW 320i 2012" */
export function vehicleText(v: Appointment['vehicle'], f: { digits: (x: string | number) => string }): string {
  const name = [v.brand.text, v.model.text, v.series?.text, f.digits(v.year)].filter(Boolean).join(' ');
  return v.nickname ? `${v.nickname} · ${name}` : name;
}

/** What the request is about in a few words: the service, else the symptom, else the start of the description. */
export function subjectOf(a: Pick<Appointment, 'service_system' | 'symptom' | 'description'>): string {
  if (a.service_system) return a.service_system.text;
  if (a.symptom) return a.symptom.text;
  const words = [...a.description.trim()];
  return words.length > 60 ? `${words.slice(0, 59).join('')}…` : words.join('');
}

export function AppointmentDetail({ appointmentId, backHref }: { appointmentId: string; backHref?: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const path = { appointment_id: appointmentId };
  const q = useApiQuery(
    'appointments.get',
    { path },
    { refetchInterval: (query) => pollInterval(query.state.data?.status), refetchOnWindowFocus: true, staleTime: 10_000 },
  );
  const a = q.data;
  const history = useApiQuery('appointments.history', { path, query: { limit: 50 } }, { enabled: !!a });
  const notes = useApiQuery(
    'appointments.notes_list',
    { path, query: { limit: 100 } },
    {
      enabled: !!a,
      refetchInterval: pollInterval(a?.status),
    },
  );
  const [mode, setMode] = useState<ChangeMode | null>(null);
  const [report, setReport] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new status or version (polling, a transition): the timeline follows.
  const version = a ? `${a.status}:${a.version}` : null;
  useEffect(() => {
    if (version) void queryClient.invalidateQueries({ queryKey: apiQueryKey('appointments.history', { path, query: { limit: 50 } }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the version only
  }, [version]);

  if (!a) {
    if (q.status === 'pending') return <SkeletonCard lines={6} />;
    return (
      <StateView
        kind={stateFromProblem(q.error)}
        t={t}
        action={
          <Link href={`/${locale}/appointments`} className="pwa-link">
            {t('appointments.detail.all')}
          </Link>
        }
      />
    );
  }

  const changed = (next: Appointment, text: string) => {
    queryClient.setQueryData(apiQueryKey('appointments.get', { path }), next);
    void queryClient.invalidateQueries({ queryKey: ['appointments.list'] });
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('appointments.history', { path, query: { limit: 50 } }) });
    setMode(null);
    setError(null);
    toast(text);
  };
  const act = async (key: string, work: () => Promise<Appointment>, text: string) => {
    setBusy(key);
    setError(null);
    try {
      changed(await work(), text);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'CAPACITY_UNAVAILABLE') setError(t('appointments.errors.capacity'));
      else if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION')
        setError(JSON.stringify(err.body).includes('outside_window') ? t('appointments.errors.window') : t('appointments.errors.changed'));
      else setError(t('appointments.errors.failed'));
      void q.refetch();
    } finally {
      setBusy(null);
    }
  };

  const can = actionsOf(a);
  const when = visitTime(a);
  const steps = timeline(a, history.data?.items ?? []);
  const exact = a.provider_location_exact;
  const loc = a.provider_location;
  const point = exact?.point ?? loc?.point ?? null;
  const address = exact
    ? addressLine([exact.address_line_1, exact.address_line_2, loc?.address.city], locale)
    : loc
      ? addressLine([loc.address.address_line_1, loc.address.city], locale)
      : null;
  const profile = orgPath(locale, a.provider);
  const event = calendarEvent(a, {
    title: t('appointments.calendar.title', { name: a.provider.name }),
    location: address ?? a.provider.name,
    description: `${subjectOf(a)} · ${vehicleText(a.vehicle, f)}`,
    url: `${typeof window === 'undefined' ? '' : window.location.origin}/${locale}/appointments/${a.id}`,
  });
  const opensAt = checkInOpensAt(a);

  return (
    <article className="pwa-appt" aria-labelledby="appt-title">
      {backHref ? (
        <Link href={backHref} className="pwa-link pwa-appt-back">
          <Icon name="back" size={20} /> {t('appointments.detail.all')}
        </Link>
      ) : null}
      <header className="pwa-stack-xs">
        <span className="pwa-text-caption">{t('appointments.detail.reference', { ref: reference(a.id) })}</span>
        <h1 id="appt-title" className="pwa-text-title m-0">
          {statusLabel(a, t)}
        </h1>
        <p className="pwa-text-body m-0">
          <bdi>{a.provider.name}</bdi> · {subjectOf(a)}
        </p>
        <span className="pwa-badges">
          <AppointmentStatusBadge a={a} t={t} />
          <Urgency level={uiLevelOf(a.urgency_level)} label={t(`appointments.urgency.${a.urgency_level}`)} />
          {a.safety_flag ? (
            <Badge tone="danger" icon="alert">
              {t('appointments.detail.safety')}
            </Badge>
          ) : null}
        </span>
      </header>

      {error ? (
        <p className="pwa-error-text m-0" role="alert">
          {error}
        </p>
      ) : null}

      {/* ---------- action card ---------- */}
      {a.status === 'alternative_proposed' && a.proposed_start_at ? (
        <section className="pwa-appt-action is-signal" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {t('appointments.action.proposedTitle')}
          </h2>
          <p className="pwa-text-body m-0">
            {t('appointments.action.proposed', { name: a.provider.name, time: f.date(a.proposed_start_at, 'dateTime') })}
          </p>
          <div className="pwa-inline-buttons">
            <Button
              variant="primary"
              icon="check"
              loading={busy === 'accept'}
              disabled={!can.accept}
              onClick={() =>
                void act(
                  'accept',
                  () => api.api('appointments.transition', { path, body: { to: 'confirmed' } }),
                  t('appointments.toast.accepted'),
                )
              }
            >
              {t('appointments.action.accept')}
            </Button>
            {can.counter ? <Button onClick={() => setMode('times')}>{t('appointments.action.counter')}</Button> : null}
            {can.cancel ? (
              <Button variant="ghost" onClick={() => setMode('cancel')}>
                {t('appointments.action.decline')}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {a.status === 'draft' ? (
        <section className="pwa-appt-action" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {t('appointments.action.draftTitle')}
          </h2>
          <p className="pwa-text-body m-0">{t('appointments.action.draft', { name: a.provider.name })}</p>
          <div className="pwa-inline-buttons">
            <Button
              variant="primary"
              icon="send"
              loading={busy === 'send'}
              disabled={!can.send}
              onClick={() =>
                a.time_windows.length
                  ? void act(
                      'send',
                      () => api.api('appointments.transition', { path, body: { to: 'requested' } }),
                      t('appointments.toast.sent'),
                    )
                  : setMode('times')
              }
            >
              {t('appointments.action.send')}
            </Button>
            <Button variant="ghost" onClick={() => setMode('cancel')}>
              {t('appointments.action.discard')}
            </Button>
          </div>
        </section>
      ) : null}
      {a.status === 'requested' || a.status === 'provider_reviewing' ? (
        <section className="pwa-appt-action" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {t('appointments.action.waitingTitle', { name: a.provider.name })}
          </h2>
          <p className="pwa-text-body m-0">
            {a.provider.measured_response_time_minutes
              ? t('appointments.action.respondsIn', {
                  time: f.number(Math.max(1, Math.round(a.provider.measured_response_time_minutes / 60))),
                })
              : t('appointments.action.waiting')}
          </p>
          {a.time_windows.length ? (
            <ul className="pwa-plain-list pwa-stack-xs" aria-label={t('appointments.detail.preferred')}>
              {[...a.time_windows]
                .sort((x, y) => x.priority - y.priority)
                .map((w) => (
                  <li key={w.id} className="pwa-text-caption">
                    <Icon name="calendar" size={16} /> {f.date(w.start_at, 'dateTime')} – {f.date(w.end_at, 'time')}
                  </li>
                ))}
            </ul>
          ) : null}
          {can.editTimes && a.status === 'requested' ? (
            <div>
              <Button size="sm" onClick={() => setMode('times')}>
                {t('appointments.action.changeTimes')}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {a.status === 'confirmed' ? (
        <section className="pwa-appt-action is-success" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {t('appointments.action.confirmedTitle')}
          </h2>
          {a.confirmed_start_at ? <p className="pwa-text-h2 m-0">{f.date(a.confirmed_start_at, 'dateTime')}</p> : null}
          {a.customer_delay_minutes ? (
            <p className="pwa-text-caption m-0">{t('appointments.action.delayed', { minutes: f.number(a.customer_delay_minutes) })}</p>
          ) : null}
          <div className="pwa-inline-buttons">
            <Button
              variant="primary"
              icon="pin"
              loading={busy === 'checkin'}
              disabled={!can.checkIn}
              onClick={() => void act('checkin', () => api.api('appointments.check_in', { path }), t('appointments.toast.checkedIn'))}
            >
              {t('appointments.action.arrived')}
            </Button>
            {can.delay ? (
              <Button icon="clock" onClick={() => setMode('delay')}>
                {t('appointments.action.late')}
              </Button>
            ) : null}
          </div>
          {!can.checkIn && opensAt && checkInLater(a) ? (
            <p className="pwa-text-caption m-0">{t('appointments.action.arrivedOpens', { time: f.date(opensAt, 'dateTime') })}</p>
          ) : null}
        </section>
      ) : null}
      {['checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'].includes(a.status) ? (
        <section className="pwa-appt-action" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {t(`appointments.action.now.${a.status}` as 'appointments.action.now.in_progress')}
          </h2>
          {a.estimated_completion_from || a.estimated_completion_to ? (
            <p className="pwa-text-body m-0">
              {t('appointments.action.estimated', {
                time: f.date((a.estimated_completion_to ?? a.estimated_completion_from)!, 'dateTime'),
              })}
            </p>
          ) : null}
          {a.parts_availability_note ? (
            <p className="pwa-text-body pwa-user-text m-0" dir="auto">
              {a.parts_availability_note}
            </p>
          ) : null}
          {a.cost_estimate ? (
            <p className="pwa-text-caption m-0">
              {t('appointments.action.estimate', { amount: f.money(a.cost_estimate.amount, a.cost_estimate.currency) })}
            </p>
          ) : null}
        </section>
      ) : null}
      {a.status === 'completed' ? (
        <Banner tone="success" title={t('appointments.action.completedTitle', { vehicle: vehicleText(a.vehicle, f) })}>
          <div className="pwa-inline-buttons">
            {a.service_record_id ? (
              <Link
                href={`/${locale}/garage/${encodeURIComponent(a.vehicle.id)}/records/${encodeURIComponent(a.service_record_id)}`}
                className={buttonClass({ size: 'sm' })}
              >
                <span className="cp-btn-label">{t('appointments.action.record')}</span>
              </Link>
            ) : null}
            {a.can_review && a.provider.slug ? (
              <Link
                href={reviewHref(locale, a.provider.slug, { appointment: a.id })}
                className={buttonClass({ size: 'sm', variant: 'primary' })}
                data-testid="leave-review"
              >
                <span className="cp-btn-label">{t('reviews.form.leave')}</span>
              </Link>
            ) : null}
          </div>
        </Banner>
      ) : null}
      {a.status === 'cancelled' || a.status === 'no_show' ? (
        <section className="pwa-appt-action" aria-labelledby="appt-action">
          <h2 id="appt-action" className="pwa-text-label m-0">
            {a.status === 'no_show' ? t('appointments.action.noShowTitle') : statusLabel(a, t)}
          </h2>
          {a.cancellation_reason ? (
            <p className="pwa-text-body pwa-user-text m-0" dir="auto">
              {t('appointments.action.reason', { reason: a.cancellation_reason })}
            </p>
          ) : null}
          {a.status === 'no_show' ? <p className="pwa-text-caption m-0">{t('appointments.action.noShow')}</p> : null}
          <div>
            <Button
              icon="send"
              onClick={() => {
                saveHelpDraft({ vehicleId: a.vehicle.id, text: a.description, symptoms: [] });
                goTo(`/${locale}/help`);
              }}
            >
              {t('appointments.action.again')}
            </Button>
          </div>
        </section>
      ) : null}

      {/* ---------- timeline ---------- */}
      {steps.length ? (
        <section className="pwa-stack-sm" aria-labelledby="appt-timeline">
          <h2 id="appt-timeline" className="pwa-section-title">
            {t('appointments.detail.timeline')}
          </h2>
          <ol className="pwa-appt-steps">
            {steps.map((s) => (
              <li key={s.status} className={`is-${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
                <span className="pwa-appt-step-dot" aria-hidden="true">
                  {s.state === 'done' ? <Icon name="check" size={16} /> : null}
                </span>
                <span className="pwa-stack-xs">
                  <span className="pwa-text-label">{t(`appointments.status.${s.status}`)}</span>
                  {s.at ? (
                    <time className="pwa-text-caption" dateTime={s.at}>
                      {f.date(s.at, 'dateTime')}
                    </time>
                  ) : null}
                  {s.note ? (
                    <span className="pwa-text-caption pwa-user-text" dir="auto">
                      {s.note}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ---------- when and where ---------- */}
      <section className="pwa-stack-sm" aria-labelledby="appt-where" id="where">
        <h2 id="appt-where" className="pwa-section-title">
          {t('appointments.detail.where')}
        </h2>
        <div className="pwa-card pwa-stack-sm">
          <p className="pwa-text-label m-0">
            {profile ? (
              <Link href={profile} className="pwa-link">
                <bdi>{a.provider.name}</bdi>
              </Link>
            ) : (
              <bdi>{a.provider.name}</bdi>
            )}
          </p>
          {address ? (
            <p className="pwa-text-body m-0" dir="auto">
              {address}
            </p>
          ) : null}
          {!exact ? <p className="pwa-text-caption m-0">{t('appointments.detail.exactLater')}</p> : null}
          {when ? (
            <p className="pwa-text-body m-0">
              <Icon name="calendar" size={20} /> {t(`appointments.detail.when.${when.kind}`, { time: f.date(when.start, 'dateTime') })}
            </p>
          ) : null}
          {loc ? <StaticMapPreview loc={loc} locale={locale} t={t} slug={a.provider.slug} /> : null}
          <div className="pwa-inline-buttons">
            {point ? (
              <DirectionsMenu
                point={point}
                address={address}
                approximate={!exact && loc?.visibility !== 'exact'}
                name={a.provider.name}
                size="sm"
              />
            ) : null}
            {event ? <CalendarMenu event={event} fileName={`carpal-${reference(a.id).slice(1).toLowerCase()}.ics`} /> : null}
          </div>
          {a.provider.slug ? <CallButton slug={a.provider.slug} orgId={a.provider.id} /> : null}
        </div>
      </section>

      {/* ---------- vehicle and issue ---------- */}
      <section className="pwa-stack-sm" aria-labelledby="appt-issue">
        <h2 id="appt-issue" className="pwa-section-title">
          {t('appointments.detail.issue')}
        </h2>
        <div className="pwa-card pwa-stack-sm">
          <p className="pwa-text-label m-0">
            <Icon name="car" size={20} /> <bdi>{vehicleText(a.vehicle, f)}</bdi>
          </p>
          <dl className="pwa-dl">
            <dt>{t('appointments.detail.type')}</dt>
            <dd>
              {t(`appointments.type.${a.appointment_type}`)} · {t(`appointments.mode.${a.service_mode}`)}
            </dd>
            {a.service_system || a.service_task ? (
              <>
                <dt>{t('appointments.detail.service')}</dt>
                <dd>{[a.service_system?.text, a.service_task?.text].filter(Boolean).join(' · ')}</dd>
              </>
            ) : null}
            {a.symptom ? (
              <>
                <dt>{t('appointments.detail.symptom')}</dt>
                <dd>{a.symptom.text}</dd>
              </>
            ) : null}
            <dt>{t('appointments.detail.history')}</dt>
            <dd>{a.consent_to_share_history ? t('appointments.detail.historyShared') : t('appointments.detail.historyNotShared')}</dd>
          </dl>
          <p className="pwa-text-body pwa-user-text m-0" dir="auto" lang={a.content_locale}>
            {a.description}
          </p>
          {a.customer_expectations ? (
            <p className="pwa-text-caption pwa-user-text m-0" dir="auto">
              {t('appointments.detail.note', { note: a.customer_expectations })}
            </p>
          ) : null}
          <p className="pwa-text-caption m-0">
            {a.triage_status === 'provided' ? t('appointments.detail.triage') : t('appointments.detail.noTriage')}
          </p>
          <div className="pwa-inline-buttons">
            <Button size="sm" icon="eye" onClick={() => setReport(true)}>
              {t('appointments.detail.report')}
            </Button>
            {a.related_issue_id ? (
              <Link
                href={`/${locale}/garage/${encodeURIComponent(a.vehicle.id)}/issues`}
                className={buttonClass({ size: 'sm', variant: 'ghost' })}
              >
                <span className="cp-btn-label">{t('appointments.detail.openIssue')}</span>
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      {/* ---------- notes ---------- */}
      <Notes
        appointmentId={a.id}
        notes={notes.data?.items ?? []}
        canWrite={can.note}
        providerName={a.provider.name}
        onSent={() => void notes.refetch()}
      />

      {can.cancel && a.status !== 'draft' && a.status !== 'alternative_proposed' ? (
        <div>
          <Button variant="ghost" icon="close" onClick={() => setMode('cancel')}>
            {t(a.status === 'confirmed' ? 'appointments.action.cancelVisit' : 'appointments.action.cancelRequest')}
          </Button>
        </div>
      ) : null}

      <ChangeDialog key={mode ?? 'closed'} a={a} mode={mode} onClose={() => setMode(null)} onDone={changed} />
      <PreVisitDrawer open={report} onClose={() => setReport(false)} appointmentId={a.id} providerName={a.provider.name} />
    </article>
  );
}

function Notes({
  appointmentId,
  notes,
  canWrite,
  providerName,
  onSent,
}: {
  appointmentId: string;
  notes: readonly AppointmentNote[];
  canWrite: boolean;
  providerName: string;
  onSent: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sorted = [...notes].sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.api('appointments.note_create', { path: { appointment_id: appointmentId }, body: { body: text, content_locale: locale } });
      setBody('');
      toast(t('appointments.notes.sent'));
      onSent();
    } catch (err) {
      setError(err instanceof ApiProblem && err.status === 429 ? t('appointments.errors.tooMany') : t('appointments.errors.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pwa-stack-sm" aria-labelledby="appt-notes">
      <h2 id="appt-notes" className="pwa-section-title">
        {t('appointments.notes.title')}
      </h2>
      {sorted.length ? (
        <ol className="pwa-inquiry-thread" aria-label={t('appointments.notes.title')}>
          {sorted.map((n) => (
            <li key={n.id} className={n.author_side === 'requester' ? 'pwa-inquiry-msg is-mine' : 'pwa-inquiry-msg'}>
              <span className="pwa-text-caption">
                <bdi>{n.author_side === 'requester' ? t('appointments.notes.you') : n.author_display || providerName}</bdi> ·{' '}
                <time dateTime={n.created_at}>{f.relative(n.created_at)}</time>
              </span>
              <p className="pwa-text-body m-0 pwa-user-text" dir="auto" lang={n.content_locale}>
                {n.body}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pwa-text-caption m-0">{t('appointments.notes.empty')}</p>
      )}
      {canWrite ? (
        <form className="pwa-stack-sm" onSubmit={send} noValidate>
          <TextField
            multiline
            rows={2}
            label={t('appointments.notes.write')}
            hint={t('appointments.notes.hint')}
            value={body}
            maxLength={MAX_NOTE}
            onChange={(e) => setBody(e.target.value)}
          />
          {error ? (
            <p className="pwa-error-text m-0" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" variant="primary" icon="send" loading={busy} disabled={!body.trim()}>
              {t('appointments.notes.send')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
