'use client';
// The pre-visit report as the shop receives it (Docs/21 C-APP-03 "What the shop sees"; Docs/40 pre_visit.requester_get,
// SEC-AI-3): vehicle, reported symptoms, the user's own description, the Help Me summary (or "Triage: not provided"),
// likely services, urgency, expectations, the service history only when shared, warnings, focus areas and photos.
// For a draft it is the preview of the request step ("Preview what the shop receives"); sending the request is the
// user's approval of what it showed. Opens in a side drawer and prints on its own (Docs/22 W-APP-01 "printable").
import type { PreVisitReport } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Urgency } from '@/components/ds/urgency';
import { MediaImage } from '@/components/media/media-image';
import { Dialog } from '@/components/shell/dialog';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { uiLevelOf } from './status';

export function PreVisitView({ report: r, providerName }: { report: PreVisitReport; providerName: string | null }) {
  const t = useT();
  const f = useFormat();
  const preview = r.status === 'draft';
  return (
    <div className="pwa-previsit pwa-stack">
      {preview ? (
        <Banner
          tone="info"
          icon="eye"
          text={providerName ? t('appointments.preVisit.previewOf', { name: providerName }) : t('appointments.preVisit.preview')}
        />
      ) : null}
      <dl className="pwa-dl">
        <dt>{t('appointments.preVisit.vehicle')}</dt>
        <dd dir="auto">{r.vehicle_summary}</dd>
        {r.mileage_km !== null ? (
          <>
            <dt>{t('appointments.preVisit.mileage')}</dt>
            <dd>{t('appointments.preVisit.km', { value: f.number(r.mileage_km) })}</dd>
          </>
        ) : null}
        <dt>{t('appointments.preVisit.urgency')}</dt>
        <dd>
          <Urgency level={uiLevelOf(r.urgency_level)} label={t(`appointments.urgency.${r.urgency_level}`)} />
        </dd>
        {r.preferred_contact_channel ? (
          <>
            <dt>{t('appointments.preVisit.contact')}</dt>
            <dd>{t(`appointments.channel.${r.preferred_contact_channel}`)}</dd>
          </>
        ) : null}
      </dl>
      <section className="pwa-stack-xs">
        <h3 className="pwa-text-label m-0">{t('appointments.preVisit.issue')}</h3>
        <p className="pwa-text-body pwa-user-text m-0" dir="auto">
          {r.issue_summary}
        </p>
        {r.reported_symptoms.length ? (
          <span className="pwa-badges">
            {r.reported_symptoms.map((s) => (
              <Badge key={s.node_id}>{s.label.text}</Badge>
            ))}
          </span>
        ) : null}
      </section>
      {r.triage_status === 'provided' && r.ai_summary ? (
        <section className="pwa-ai-card pwa-stack-xs">
          <span className="pwa-badges">
            <Badge icon="spark">{t('appointments.preVisit.aiSummary')}</Badge>
            {r.ai_summary_status === 'approved' ? <Badge tone="success">{t('appointments.preVisit.aiApproved')}</Badge> : null}
          </span>
          <p className="pwa-text-body m-0" dir="auto">
            {r.ai_summary}
          </p>
          <p className="pwa-text-caption m-0">{t('appointments.preVisit.notDiagnosis')}</p>
        </section>
      ) : r.triage_status === 'not_provided' ? (
        <Banner tone="plain" icon="info" title={t('appointments.preVisit.noTriage')} text={t('appointments.preVisit.noTriageText')} />
      ) : null}
      {r.likely_services.length ? (
        <section className="pwa-stack-xs">
          <h3 className="pwa-text-label m-0">{t('appointments.preVisit.likely')}</h3>
          <span className="pwa-badges">
            {r.likely_services.map((s) => (
              <Badge key={s.node_id} tone="accent">
                {s.label.text}
              </Badge>
            ))}
          </span>
        </section>
      ) : null}
      {r.customer_expectations ? (
        <section className="pwa-stack-xs">
          <h3 className="pwa-text-label m-0">{t('appointments.preVisit.note')}</h3>
          <p className="pwa-text-body pwa-user-text m-0" dir="auto">
            {r.customer_expectations}
          </p>
        </section>
      ) : null}
      <section className="pwa-stack-xs">
        <h3 className="pwa-text-label m-0">{t('appointments.preVisit.history')}</h3>
        {r.relevant_history_summary === null ? (
          <p className="pwa-text-caption m-0">{t('appointments.preVisit.historyNotShared')}</p>
        ) : (
          <>
            <p className="pwa-text-body m-0" dir="auto">
              {r.relevant_history_summary}
            </p>
            {r.previous_related_repairs?.length ? (
              <ul className="pwa-plain-list pwa-stack-xs">
                {r.previous_related_repairs.map((x, i) => (
                  <li key={`${x.service_date}-${i}`} className="pwa-text-caption" dir="auto">
                    {f.calendarDate(x.service_date)} · {x.service_system.text}
                    {x.description ? ` — ${x.description}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="pwa-text-caption m-0">{t('appointments.preVisit.noCosts')}</p>
          </>
        )}
      </section>
      {r.known_warnings.length ? (
        <Banner tone="danger" title={t('appointments.preVisit.warnings')}>
          <ul className="pwa-plain-list">
            {r.known_warnings.map((w) => (
              <li key={w} className="pwa-banner-text" dir="auto">
                {w}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {r.suggested_focus_areas.length ? (
        <section className="pwa-stack-xs">
          <h3 className="pwa-text-label m-0">{t('appointments.preVisit.focus')}</h3>
          <p className="pwa-text-body m-0" dir="auto">
            {r.suggested_focus_areas.join(' · ')}
          </p>
        </section>
      ) : null}
      {r.media.length ? (
        <section className="pwa-stack-xs">
          <h3 className="pwa-text-label m-0">{t('appointments.preVisit.media')}</h3>
          <ul className="pwa-plain-list pwa-previsit-media">
            {r.media.map((m) => (
              <li key={m.attachment_id}>
                <MediaImage
                  url={m.url}
                  thumbnailUrl={m.thumbnail_url}
                  variant="thumb"
                  aspect="square"
                  alt={m.caption ?? t('appointments.preVisit.photo')}
                  placeholder={t('appointments.preVisit.photo')}
                  placeholderIcon={m.media_type === 'video' ? 'video' : 'image'}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.generated_at ? (
        <p className="pwa-text-caption m-0">{t('appointments.preVisit.generated', { date: f.date(r.generated_at, 'dateTime') })}</p>
      ) : null}
    </div>
  );
}

/** The report of an appointment (or a draft) in a side drawer, with Print. */
export function PreVisitDrawer({
  open,
  onClose,
  appointmentId,
  providerName,
}: {
  open: boolean;
  onClose: () => void;
  appointmentId: string | null;
  providerName: string | null;
}) {
  const t = useT();
  const q = useApiQuery('pre_visit.requester_get', appointmentId ? { path: { appointment_id: appointmentId } } : undefined, {
    enabled: open && !!appointmentId,
    staleTime: 0,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="panel"
      name="pre-visit"
      scrollableBody
      className="pwa-print-area"
      title={t('appointments.preVisit.title')}
      footer={
        q.data ? (
          <Button icon="download" onClick={() => window.print()}>
            {t('appointments.preVisit.print')}
          </Button>
        ) : null
      }
    >
      {q.data ? (
        <PreVisitView report={q.data} providerName={providerName} />
      ) : q.isError ? (
        <StateView kind={stateFromProblem(q.error)} t={t} compact />
      ) : (
        <SkeletonCard lines={6} />
      )}
    </Dialog>
  );
}
