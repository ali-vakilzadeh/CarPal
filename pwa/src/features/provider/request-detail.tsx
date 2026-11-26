'use client';
// PW-REQ-02 Request detail (provider plan PW3.T3-T5; mirrors P-REQ-02; Docs/11 Ch.5): the red safety banner first,
// the customer's display name, the vehicle and mileage, the pre-visit report (AI summary labelled as AI, or "Triage:
// not provided"; history only with the customer's service_history_sharing consent, else "Not shared by customer"),
// the photos and video, the preferred times at the shop, the AI duration suggestion (on request, a labelled draft;
// the screen works with the AI off), the customer-visible messages, and the answers Accept · Propose time · More
// (Decline, Ask for information) from allowed_transitions (answer-sheets.tsx).
// Opening a new request moves it to provider_reviewing once (StrictMode-safe); a refused move only reloads. Every
// change puts the server's appointment into the cache and refreshes the lists Today and Requests share.
// Not in the contract, so not shown: 'first visit' and the brand coverage mismatch (PW3 deviations).
import type { AiInsight, Appointment, AppointmentNote, Job, MediaAttachmentView, PreVisitReport as Report } from '@carpal/api-contracts';
import { PreVisitReport, StatusChip, appointmentTone, urgencyTone, type PreVisitData } from '@carpal/business-ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { MediaImage } from '@/components/media/media-image';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import type { ApiClient } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { createFormatter, type Formatter } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { AnswerSheet, type SheetMode } from './answer-sheets';
import { useActiveBusiness } from './context';
import { isSafetyCritical, workshopPath } from './model';
import {
  answersOf,
  durationText,
  isDeclined,
  preferredWindows,
  shouldStartReview,
  shopTimeZone,
  slotSuggestion,
  vehicleLine,
} from './requests-model';

const POLL_MS = 30_000;
const JOB_TIMEOUT_MS = 60_000;

export function WorkshopRequestDetail({ appointmentId }: { appointmentId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { orgId } = useActiveBusiness();
  const path = { org_id: orgId, appointment_id: appointmentId };
  const q = useApiQuery('provider.appointments_get', { path }, { refetchOnWindowFocus: true, staleTime: 10_000, refetchInterval: POLL_MS });
  const a = q.data;
  // 404 = no report yet (or none for this request): the detail still shows the request's own text.
  const report = useApiQuery('pre_visit.provider_get', { path }, { enabled: !!a, retry: false, staleTime: 60_000 });
  const notes = useApiQuery('provider.notes_list', { path, query: { limit: 50 } }, { enabled: !!a, refetchInterval: POLL_MS });
  const [mode, setMode] = useState<SheetMode | null>(null);
  // A fresh sheet per opening; switching Accept → Propose inside it keeps the chosen day and time.
  const [opened, setOpened] = useState(0);
  const [more, setMore] = useState(false);
  const [changedTo, setChangedTo] = useState<string | null>(null);
  const [aiDuration, setAiDuration] = useState<number | null>(null);

  const changed = (next: Appointment) => {
    queryClient.setQueryData(apiQueryKey('provider.appointments_get', { path }), next);
    void queryClient.invalidateQueries({ queryKey: ['provider.appointments_list'] });
  };

  // Opening a new request starts the review (requested → provider_reviewing), once per request.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!a || !shouldStartReview(a) || started.current === a.id) return;
    started.current = a.id;
    api
      .api('provider.appointments_transition', { path: { org_id: orgId, appointment_id: a.id }, body: { to: 'provider_reviewing' } })
      .then(changed)
      .catch(() => void q.refetch());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request id
  }, [a?.id, a?.status]);

  const back = (
    <Link href={workshopPath(locale, 'requests')} className="pwa-link pwa-ws-back">
      <Icon name="back" size={20} /> {t('provider.requests.back')}
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
  const r = report.data ?? null;
  const answers = answersOf(a);
  const safety = isSafetyCritical(a);
  const visible = (notes.data?.items ?? []).filter((n) => n.note_type === 'customer_visible');

  return (
    <article className="pwa-ws-page pwa-ws-request" aria-labelledby="req-title">
      {back}
      {safety ? (
        <Banner
          tone="danger"
          icon="alert"
          title={t('provider.requests.detail.safetyTitle')}
          text={t('provider.requests.detail.safetyText')}
        />
      ) : null}
      <header className="pwa-stack-xs">
        <h1 id="req-title" className="pwa-ws-title">
          <bdi>{a.requester_display}</bdi>
        </h1>
        <p className="pwa-text-body m-0">
          <Icon name="car" size={20} /> <bdi>{vehicleLine(a.vehicle, f.digits)}</bdi>
          {r?.mileage_km != null ? ` · ${t('provider.requests.detail.km', { value: f.number(r.mileage_km) })}` : null}
        </p>
        <span className="pwa-badges">
          <StatusChip label={t(`provider.status.${a.status}` as MessageKey)} tone={appointmentTone(a.status)} />
          <StatusChip label={t(`provider.requests.urgency.${a.urgency_level}`)} tone={urgencyTone(a.urgency_level)} />
          <span className="pwa-text-caption">{t('provider.requests.detail.received', { time: f.relative(a.created_at) })}</span>
        </span>
      </header>

      {changedTo ? <Banner tone="warn" icon="info" text={t('provider.requests.errors.changed', { status: changedTo })} /> : null}

      <Answers
        a={a}
        shop={shop}
        onOpen={(m) => {
          setMore(false);
          setOpened((n) => n + 1);
          setMode(m);
        }}
        more={more}
        setMore={setMore}
      />

      <section className="pwa-stack-sm" aria-labelledby="req-report">
        <h2 id="req-report" className="pwa-ws-section-title">
          {t('provider.requests.detail.report')}
        </h2>
        {report.isPending ? (
          <SkeletonCard lines={3} />
        ) : (
          <div className="pwa-card">
            <PreVisitReport words={reportWords(t)} data={reportData(a, r, f)} media={r?.media.length ? <Media items={r.media} /> : null} />
          </div>
        )}
      </section>

      {answers.accept || answers.propose ? (
        <section className="pwa-stack-sm" aria-labelledby="req-times">
          <h2 id="req-times" className="pwa-ws-section-title">
            {t('provider.requests.detail.preferred')}
          </h2>
          <PreferredTimes a={a} shop={shop} />
          <AiSuggestion orgId={orgId} appointmentId={a.id} onUse={setAiDuration} used={aiDuration} />
        </section>
      ) : null}

      {a.status === 'alternative_proposed' && a.proposed_start_at ? (
        <Banner
          tone="info"
          icon="clock"
          text={t('provider.requests.detail.proposedWait', { time: shop.date(a.proposed_start_at, 'dateTime') })}
        />
      ) : null}
      {a.status === 'confirmed' && a.confirmed_start_at ? (
        <Banner
          tone="success"
          icon="check"
          text={t('provider.requests.detail.booked', { time: shop.date(a.confirmed_start_at, 'dateTime') })}
        />
      ) : null}
      {isDeclined(a) ? (
        <p className="pwa-text-body m-0">{t('provider.requests.detail.declined')}</p>
      ) : a.status === 'cancelled' && a.cancellation_reason ? (
        <p className="pwa-text-body pwa-user-text m-0" dir="auto">
          {t('provider.requests.detail.reason', { reason: a.cancellation_reason })}
        </p>
      ) : null}

      <Messages notes={visible} failed={notes.isError} />

      <AnswerSheet
        key={opened}
        a={a}
        orgId={orgId}
        mode={mode}
        aiDuration={aiDuration}
        onMode={setMode}
        onClose={() => setMode(null)}
        onDone={(next) => {
          setChangedTo(null);
          if (next) changed(next);
          // Ask, Propose with a note and Decline all leave a customer-visible message.
          void notes.refetch();
          setMode(null);
        }}
        onStale={(next) => {
          setMode(null);
          if (next) {
            changed(next);
            setChangedTo(t(`provider.status.${next.status}` as MessageKey));
          } else void q.refetch();
        }}
      />
    </article>
  );
}

/** The answer bar: Accept and Propose time first, Decline and Ask for information under More. */
function Answers({
  a,
  shop,
  onOpen,
  more,
  setMore,
}: {
  a: Appointment;
  shop: Formatter;
  onOpen: (m: SheetMode) => void;
  more: boolean;
  setMore: (v: boolean) => void;
}) {
  const t = useT();
  const can = answersOf(a);
  if (!can.accept && !can.propose && !can.decline && !can.ask) return null;
  const extra = [can.decline ? ('decline' as const) : null, can.ask ? ('ask' as const) : null].filter((x): x is 'decline' | 'ask' => !!x);
  return (
    <section className="pwa-ws-answers" aria-label={t('provider.requests.detail.answer')}>
      <div className="pwa-inline-buttons">
        {can.accept ? (
          <Button variant="primary" icon="check" onClick={() => onOpen('accept')}>
            {t('provider.requests.actions.accept')}
          </Button>
        ) : null}
        {can.propose ? (
          <Button icon="clock" onClick={() => onOpen('propose')}>
            {t('provider.requests.actions.propose')}
          </Button>
        ) : null}
        {extra.length ? (
          <Button variant="ghost" icon="more" aria-expanded={more} onClick={() => setMore(!more)}>
            {t('provider.requests.actions.more')}
          </Button>
        ) : null}
      </div>
      {more ? (
        <div className="pwa-inline-buttons" data-testid="more-answers">
          {extra.map((m) => (
            <Button key={m} size="sm" variant={m === 'decline' ? 'ghost' : 'secondary'} onClick={() => onOpen(m)}>
              {t(`provider.requests.actions.${m}`)}
            </Button>
          ))}
        </div>
      ) : null}
      {a.status === 'requested' || a.status === 'provider_reviewing' ? (
        <p className="pwa-text-caption m-0">{t('provider.requests.detail.waitingSince', { time: shop.relative(a.created_at) })}</p>
      ) : null}
    </section>
  );
}

function PreferredTimes({ a, shop }: { a: Appointment; shop: Formatter }) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const windows = preferredWindows(a, now);
  if (!windows.length) return <p className="pwa-text-caption m-0">{t('provider.requests.detail.noPreferred')}</p>;
  return (
    <ol className="pwa-plain-list pwa-stack-xs" data-testid="preferred-times">
      {windows.map((w) => (
        <li key={w.id} className="pwa-text-body">
          <Icon name="calendar" size={16} /> {shop.date(w.start_at, 'weekdayDate')} · {shop.date(w.start_at, 'time')}–
          {shop.date(w.end_at, 'time')}
        </li>
      ))}
    </ol>
  );
}

function Media({ items }: { items: readonly MediaAttachmentView[] }) {
  const t = useT();
  return (
    <ul className="pwa-plain-list pwa-ws-media">
      {[...items]
        .sort((x, y) => x.display_order - y.display_order)
        .map((m) => (
          <li key={m.attachment_id}>
            {m.media_type === 'video' && m.url ? (
              <video
                className="pwa-ws-video"
                src={m.url}
                controls
                preload="metadata"
                aria-label={m.caption ?? t('provider.requests.detail.video')}
              />
            ) : m.media_type === 'document' ? (
              m.url ? (
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="pwa-link">
                  <Icon name="doc" size={16} /> {m.caption ?? t('provider.requests.detail.document')}
                </a>
              ) : null
            ) : (
              <MediaImage
                url={m.url}
                thumbnailUrl={m.thumbnail_url}
                alt={m.caption ?? t('provider.requests.detail.photo')}
                placeholder={t('provider.requests.detail.photoPending')}
                width={m.width}
                height={m.height}
                aspect="photo"
              />
            )}
          </li>
        ))}
    </ul>
  );
}

function Messages({ notes, failed }: { notes: readonly AppointmentNote[]; failed: boolean }) {
  const t = useT();
  const f = useFormat();
  const sorted = [...notes].sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  return (
    <section className="pwa-stack-sm" aria-labelledby="req-messages">
      <h2 id="req-messages" className="pwa-ws-section-title">
        {t('provider.requests.detail.messages')}
      </h2>
      {failed ? <p className="pwa-text-caption m-0">{t('provider.requests.detail.messagesError')}</p> : null}
      {sorted.length ? (
        <ol className="pwa-inquiry-thread" data-testid="request-messages">
          {sorted.map((n) => (
            <li key={n.id} className={n.author_side === 'provider' ? 'pwa-inquiry-msg is-mine' : 'pwa-inquiry-msg'}>
              <span className="pwa-text-caption">
                <bdi>{n.author_display}</bdi> · <time dateTime={n.created_at}>{f.relative(n.created_at)}</time>
              </span>
              <p className="pwa-text-body m-0 pwa-user-text" dir="auto" lang={n.content_locale}>
                {n.body}
              </p>
            </li>
          ))}
        </ol>
      ) : failed ? null : (
        <p className="pwa-text-caption m-0">{t('provider.requests.detail.noMessages')}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- AI suggestion (T5)

type AiState = { s: 'idle' } | { s: 'running' } | { s: 'done'; insight: AiInsight } | { s: 'off' } | { s: 'failed' };

async function runSuggestion(api: ApiClient, orgId: string, appointmentId: string): Promise<AiInsight | null> {
  let job: Job = await api.api('ai.appointment_suggestions', { path: { org_id: orgId, appointment_id: appointmentId } });
  const started = Date.now();
  while ((job.status === 'queued' || job.status === 'running') && Date.now() - started < JOB_TIMEOUT_MS) {
    const res = await api.call('jobs.get', { path: { job_id: job.id } });
    job = res.data;
    if (job.status === 'queued' || job.status === 'running') await new Promise((r) => setTimeout(r, res.pollAfterMs ?? 1_000));
  }
  if (job.status !== 'succeeded' || job.result?.type !== 'ai_insight') return null;
  return api.api('ai.insight_get', { path: { insight_id: job.result.id } });
}

/** An AI problem that means "no AI for this business now": off, not in the plan, flag off, rate limit. */
const aiOff = (err: unknown) =>
  err instanceof ApiProblem &&
  (err.code === 'AI_UNAVAILABLE' || err.code === 'FEATURE_DISABLED' || err.status === 403 || err.status === 429 || err.status === 503);

function AiSuggestion({
  orgId,
  appointmentId,
  onUse,
  used,
}: {
  orgId: string;
  appointmentId: string;
  onUse: (minutes: number) => void;
  used: number | null;
}) {
  const t = useT();
  const api = useApiClient();
  const [state, setState] = useState<AiState>({ s: 'idle' });
  const run = async () => {
    setState({ s: 'running' });
    try {
      const insight = await runSuggestion(api, orgId, appointmentId);
      setState(insight ? { s: 'done', insight } : { s: 'failed' });
    } catch (err) {
      setState(aiOff(err) ? { s: 'off' } : { s: 'failed' });
    }
  };
  const p = state.s === 'done' ? slotSuggestion(state.insight) : null;
  return (
    <div className="pwa-ai-card pwa-stack-xs" data-ai-state={state.s} data-testid="ai-suggestion">
      <span className="pwa-badges">
        <StatusChip label={t('provider.requests.ai.label')} tone="accent" />
      </span>
      {state.s === 'idle' || state.s === 'running' ? (
        <>
          <p className="pwa-text-caption m-0">{t('provider.requests.ai.intro')}</p>
          <div>
            <Button size="sm" icon="spark" loading={state.s === 'running'} onClick={() => void run()}>
              {t('provider.requests.ai.run')}
            </Button>
          </div>
        </>
      ) : state.s === 'off' ? (
        <p className="pwa-text-caption m-0">{t('provider.requests.ai.off')}</p>
      ) : state.s === 'failed' ? (
        <>
          <p className="pwa-text-caption m-0">{t('provider.requests.ai.failed')}</p>
          <div>
            <Button size="sm" onClick={() => void run()}>
              {t('common.actions.retry')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {state.insight.summary ? (
            <p className="pwa-text-body m-0" dir="auto">
              {state.insight.summary}
            </p>
          ) : null}
          {p ? (
            <>
              <p className="pwa-text-label m-0">
                {t('provider.requests.ai.duration', { time: durationText(t, p.suggested_duration_minutes) })}
                {p.longer_than_requested ? ` · ${t('provider.requests.ai.longer')}` : ''}
              </p>
              {p.conflict_count > 0 ? (
                <p className="pwa-text-caption m-0">{t('provider.requests.ai.conflicts', { count: p.conflict_count })}</p>
              ) : null}
              {p.customer_need ? (
                <p className="pwa-text-caption m-0" dir="auto">
                  {p.customer_need}
                </p>
              ) : null}
              <div>
                <Button
                  size="sm"
                  icon={used === p.suggested_duration_minutes ? 'check' : undefined}
                  onClick={() => onUse(p.suggested_duration_minutes)}
                >
                  {t('provider.requests.ai.use')}
                </Button>
              </div>
            </>
          ) : null}
          <p className="pwa-text-caption m-0">{t('provider.requests.ai.note')}</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pre-visit report data

function reportWords(t: Translate) {
  return {
    issue: t('provider.requests.report.issue'),
    symptoms: t('provider.requests.report.symptoms'),
    aiLabel: t('provider.requests.report.aiLabel'),
    aiNote: t('provider.requests.report.aiNote'),
    triageNone: t('provider.requests.report.triageNone'),
    triageNoneText: t('provider.requests.report.triageNoneText'),
    likely: t('provider.requests.report.likely'),
    expectations: t('provider.requests.report.expectations'),
    history: t('provider.requests.report.history'),
    historyNotShared: t('provider.requests.report.historyNotShared'),
    warnings: t('provider.requests.report.warnings'),
    focus: t('provider.requests.report.focus'),
    media: t('provider.requests.report.media'),
  };
}

/** The report's data, or the request's own text when there is no report (404): history then reads "Not shared". */
export function reportData(a: Appointment, r: Report | null, f: Pick<Formatter, 'calendarDate'>): PreVisitData {
  if (!r)
    return {
      issue: a.description,
      symptoms: a.symptom ? [a.symptom.text] : [],
      triage: a.triage_status === 'provided',
      aiSummary: null,
      likely: [],
      expectations: a.customer_expectations,
      history: null,
      previous: [],
      warnings: [],
      focus: [],
      lang: a.content_locale,
    };
  return {
    issue: r.issue_summary || a.description,
    symptoms: r.reported_symptoms.map((s) => s.label.text),
    triage: r.triage_status === 'provided',
    aiSummary: r.ai_summary,
    likely: r.likely_services.map((s) => s.label.text),
    expectations: r.customer_expectations,
    history: r.relevant_history_summary,
    previous: (r.previous_related_repairs ?? []).map(
      (x) => `${f.calendarDate(x.service_date)} · ${x.service_system.text}${x.description ? ` — ${x.description}` : ''}`,
    ),
    warnings: r.known_warnings,
    focus: r.suggested_focus_areas,
    lang: a.content_locale,
  };
}
