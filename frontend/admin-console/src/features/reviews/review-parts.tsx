'use client';
// Parts of the review screens (AC7.T2, Docs/23 A-REV-02 centre panel): the review as written, the Path 2 facts (the
// business's answer and deadline, how the business step was settled, the first decider), the author's history without
// contact data, and the evidence files. A file opens through admin.media_download_url (PURP, audited): the console
// shows a short-lived link, never the file inline (the CSP allows images from this origin only).
import { useState } from 'react';
import type { MediaAttachmentView, Review, StaffReviewApprovalView } from '@carpal/api-contracts';
import { EntityChip } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import type { AccessPurpose } from '@/lib/api/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { problemText } from '@/components/admin';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { BUSINESS_SOURCES, BUSINESS_STATUSES, CONFIRMATION_PATHS, enumLabel, REVIEW_STATUSES, VERIFIED_STATUSES } from './review-logic';

/** "★ 2 / 5" in words for screen readers and in digits of the UI language. */
export function Rating({ value }: { value: number | null | undefined }) {
  const t = useT();
  const f = useFormat();
  if (value == null) return <>—</>;
  return (
    <span className="adm-rating">
      <span className="sr-only">{t('admin.reviews.ratingOf', { n: f.number(value) })}</span>
      <span aria-hidden="true">★ {f.number(value)}/5</span>
    </span>
  );
}

/** The review's statuses as badges (status, confirmation path, verified status). */
export function ReviewStatusLine({ status, path, verified }: { status: string; path: string | null; verified: string | null }) {
  const t = useT();
  return (
    <p className="adm-badges">
      <Badge tone={status === 'published' ? 'success' : status === 'removed' || status === 'rejected' ? 'danger' : 'signal'}>
        {enumLabel(REVIEW_STATUSES, 'admin.trust.reviewStatus', status, t)}
      </Badge>
      {path ? <Badge>{enumLabel(CONFIRMATION_PATHS, 'admin.trust.path', path, t)}</Badge> : null}
      {verified ? <Badge tone="accent">{enumLabel(VERIFIED_STATUSES, 'admin.trust.verified', verified, t)}</Badge> : null}
    </p>
  );
}

/** The review text as the author wrote it (its own language and direction). */
export function ReviewText({ title, body, locale }: { title?: string | null; body: string; locale?: string }) {
  return (
    <blockquote className="adm-quote" lang={locale}>
      {title ? (
        <p className="adm-quote-title">
          <Bidi>{title}</Bidi>
        </p>
      ) : null}
      <p>
        <Bidi>{body}</Bidi>
      </p>
    </blockquote>
  );
}

/** The whole review of a Path 2 approval view. */
export function ReviewBlock({ review }: { review: Review }) {
  const t = useT();
  const f = useFormat();
  return (
    <section className="adm-panel" aria-label={t('admin.reviews.reviewLabel')} data-testid="review-block">
      <ReviewStatusLine status={review.status} path={review.confirmation_path} verified={review.verified_status} />
      <p className="adm-review-head">
        <Rating value={review.overall_rating} />
        {review.disputed_by_business ? <Badge tone="danger">{t('admin.reviews.disputedByBusiness')}</Badge> : null}
      </p>
      <ReviewText title={review.title ?? null} body={review.body} locale={review.content_locale} />
      <dl className="adm-facts">
        {review.sub_ratings?.length ? (
          <div>
            <dt>{t('admin.reviews.subRatings')}</dt>
            <dd>
              <ul className="adm-inline-list">
                {review.sub_ratings.map((s) => (
                  <li key={s.dimension}>
                    <Bidi ltr>{s.dimension}</Bidi> {f.number(s.rating)}/5
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {review.service_date ? (
          <div>
            <dt>{t('admin.reviews.serviceDate')}</dt>
            <dd>{f.date(review.service_date, 'date')}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('admin.reviews.written')}</dt>
          <dd>
            <time dateTime={review.created_at}>{f.date(review.created_at, 'dateTime')}</time>
          </dd>
        </div>
        {review.context_appointment_id ? (
          <div>
            <dt>{t('admin.reviews.appointment')}</dt>
            <dd>
              <EntityChip type="appointment" id={review.context_appointment_id} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('admin.reviews.reports')}</dt>
          <dd>{enumLabel(['none', 'reported', 'under_review', 'resolved'], 'admin.reviews.reportStatus', review.report_status, t)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** The business step of Path 2: its answer, how it was settled, the note it wrote to CarPal, and the deadline. */
export function BusinessStep({ view }: { view: StaffReviewApprovalView }) {
  const t = useT();
  const f = useFormat();
  const status = view.review.business_confirmation_status;
  return (
    <section className="adm-panel" aria-label={t('admin.reviews.businessLabel')} data-testid="business-step">
      <h3 className="adm-subtitle">{t('admin.reviews.businessLabel')}</h3>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.reviews.col.subject')}</dt>
          <dd>
            <EntityChip type="organization" id={view.subject.id} label={view.subject.name} />
          </dd>
        </div>
        <div>
          <dt>{t('admin.reviews.col.business')}</dt>
          <dd data-testid="business-answer">{enumLabel(BUSINESS_STATUSES, 'admin.trust.business', status, t)}</dd>
        </div>
        {view.business_confirmation_source ? (
          <div>
            <dt>{t('admin.reviews.businessSource')}</dt>
            <dd>{enumLabel(BUSINESS_SOURCES, 'admin.trust.businessSource', view.business_confirmation_source, t)}</dd>
          </div>
        ) : null}
        {view.business_confirmation_due_at ? (
          <div>
            <dt>{t('admin.reviews.businessDue')}</dt>
            <dd>
              <time dateTime={view.business_confirmation_due_at}>{f.date(view.business_confirmation_due_at, 'dateTime')}</time>
            </dd>
          </div>
        ) : null}
        {view.business_note ? (
          <div>
            <dt>{t('admin.reviews.businessNote')}</dt>
            <dd>
              <Bidi>{view.business_note}</Bidi>
            </dd>
          </div>
        ) : null}
        {view.first_decider_display ? (
          <div>
            <dt>{t('admin.reviews.firstDecider')}</dt>
            <dd data-testid="first-decider">
              <Bidi>{view.first_decider_display}</Bidi>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

/** The author's history (no contact data, MVP Module F) and the fraud signals, if any. */
export function AuthorContext({ view }: { view: StaffReviewApprovalView }) {
  const t = useT();
  const f = useFormat();
  const h = view.author_history;
  return (
    <section className="adm-panel" aria-label={t('admin.reviews.authorLabel')} data-testid="author-context">
      <h3 className="adm-subtitle">{t('admin.reviews.authorLabel')}</h3>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.reviews.col.author')}</dt>
          <dd>
            <Bidi>{view.author_display_name}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.reviews.accountAge')}</dt>
          <dd>{t('admin.reviews.days', { n: f.number(h.account_age_days) })}</dd>
        </div>
        <div>
          <dt>{t('admin.reviews.published')}</dt>
          <dd>{f.number(h.published_reviews)}</dd>
        </div>
        <div>
          <dt>{t('admin.reviews.rejectedBefore')}</dt>
          <dd>{f.number(h.rejected_reviews)}</dd>
        </div>
        <div>
          <dt>{t('admin.reviews.verifiedContact')}</dt>
          <dd>{h.verified_contact ? t('admin.reviews.yes') : t('admin.reviews.no')}</dd>
        </div>
      </dl>
      {view.fraud_signals.length ? (
        <ul className="adm-inline-list" aria-label={t('admin.reviews.fraudSignals')}>
          {view.fraud_signals.map((s) => (
            <li key={s.signal}>
              <Badge tone="danger" icon="alert">
                <Bidi ltr>{s.signal}</Bidi> {f.number(s.score)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-muted">{t('admin.reviews.noFraudSignals')}</p>
      )}
    </section>
  );
}

/** Evidence files the author attached; each opens through a short-lived, audited link. */
export function EvidenceList({ items, purpose }: { items: readonly MediaAttachmentView[]; purpose: AccessPurpose }) {
  const t = useT();
  return (
    <section className="adm-panel" aria-label={t('admin.reviews.evidenceLabel')} data-testid="evidence">
      <h3 className="adm-subtitle">{t('admin.reviews.evidenceLabel')}</h3>
      {items.length ? (
        <ul className="adm-files">
          {items.map((m) => (
            <EvidenceItem key={m.attachment_id} media={m} purpose={purpose} />
          ))}
        </ul>
      ) : (
        <p className="adm-muted">{t('admin.reviews.noEvidence')}</p>
      )}
    </section>
  );
}

function EvidenceItem({ media, purpose }: { media: MediaAttachmentView; purpose: AccessPurpose }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const [state, setState] = useState<
    { s: 'idle' } | { s: 'busy' } | { s: 'ready'; url: string; expires: string } | { s: 'failed'; p: ApiProblem }
  >({ s: 'idle' });
  const open = async () => {
    setState({ s: 'busy' });
    try {
      const r = await api.api('admin.media_download_url', {
        path: { media_id: media.media_asset_id },
        body: { variant: 'display' },
        purpose,
      });
      setState({ s: 'ready', url: r.url, expires: r.expires_at });
    } catch (err) {
      setState({ s: 'failed', p: err as ApiProblem });
    }
  };
  const kind = enumLabel(['image', 'video', 'document'], 'admin.reviews.mediaType', media.media_type, t);
  return (
    <li data-media={media.media_asset_id}>
      <span>
        {kind}
        {media.caption ? (
          <>
            {' — '}
            <Bidi>{media.caption}</Bidi>
          </>
        ) : null}
      </span>
      {state.s === 'ready' ? (
        <span>
          <a href={state.url} target="_blank" rel="noopener noreferrer">
            {t('admin.reviews.openFile')}
          </a>{' '}
          <span className="adm-muted">{t('admin.reviews.linkExpires', { when: f.date(state.expires, 'time') })}</span>
        </span>
      ) : (
        <Button size="sm" variant="ghost" icon="image" loading={state.s === 'busy'} onClick={() => void open()}>
          {t('admin.reviews.getLink')}
        </Button>
      )}
      {state.s === 'failed' ? (
        <p className="adm-error" role="alert">
          {problemText(state.p, t)}
        </p>
      ) : null}
    </li>
  );
}
