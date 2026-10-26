'use client';
// Reviews (Docs/22 W-PUB-02/03, C-PROV-01 tab 4, C-VEND-01 reviews): two columns on wide screens — the rating summary
// (overall, distribution, sub-ratings, the two confirmation paths explained) and the filtered list. Every review shows
// its confirmation label (Verified visit, or Verified purchase for sellers / Approved by the business and CarPal),
// "Disputed by the business", the context line, tags, the business reply and Helpful (sign-in required, reactions.put).
// No unverified section exists. The first page is server-rendered (initial); filters and paging go through the BFF.
// Author names are text, not links (no member page, DI-03). Writing a review is P11.
import type { PublicOrgProfile, PublicReview } from '@carpal/api-contracts';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ds/avatar';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { Meter } from '@/components/ds/meter';
import { MediaImage } from '@/components/media/media-image';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { useApiClient, useApiInfiniteQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { ReviewLabel } from './trust';
import { distributionShares, reviewTotal } from './view-model';

type Summary = PublicOrgProfile['rating_summary'];

export function RatingSummaryView({ summary, vendor }: { summary: Summary; vendor?: boolean }) {
  const t = useT();
  const f = useFormat();
  const total = reviewTotal(summary);
  const one = (v: string | number) => f.number(Number(v), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div className="pwa-stack">
      {summary.overall && total ? (
        <div className="pwa-rating-big">
          <span className="pwa-rating-number" aria-hidden="true">
            {one(summary.overall)}
          </span>
          <span className="pwa-stack-xs">
            <span className="sr-only">{t('profiles.rating.stars', { value: one(summary.overall) })}</span>
            <span className="pwa-text-caption" aria-hidden="true">
              {t('profiles.reviews.outOf')}
            </span>
            <span className="pwa-text-caption">{t('profiles.rating.count', { count: total })}</span>
          </span>
        </div>
      ) : null}
      {total ? (
        <ul className="pwa-plain-list pwa-bars" aria-label={t('profiles.reviews.distributionLabel')}>
          {distributionShares(summary).map((d) => (
            <li key={d.stars} className="pwa-bar-row">
              <span className="pwa-text-caption">{t('profiles.reviews.stars', { count: d.stars })}</span>
              <Meter value={d.share} label={t('profiles.reviews.stars', { count: d.stars })} valueText={`${f.number(d.share)}%`} />
              <span className="pwa-text-caption">{f.number(d.count)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.sub_ratings.length ? (
        <dl className="pwa-dl" aria-label={t('profiles.reviews.subRatings')}>
          {summary.sub_ratings.map((s) => (
            <div key={s.dimension} className="contents">
              <dt className="pwa-text-caption">{t(`profiles.reviews.sub.${s.dimension}`)}</dt>
              <dd className="pwa-text-body">
                <Icon name="star" size={16} className="cp-star" /> {one(s.average)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="pwa-explain">
        <p className="pwa-text-label m-0">{t('profiles.reviews.explainTitle')}</p>
        <p className="pwa-text-caption">{vendor ? t('profiles.reviews.explainPurchase') : t('profiles.reviews.explainVisit')}</p>
        <p className="pwa-text-caption">{t('profiles.reviews.explainApproved')}</p>
      </div>
    </div>
  );
}

function HelpfulButton({ review }: { review: PublicReview }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const gate = useGatedAction();
  const [count, setCount] = useState(review.helpful_count);
  const [done, setDone] = useState(false);
  const mark = async () => {
    try {
      const r = await api.api('reactions.put', { body: { target: { type: 'review', id: review.id }, reaction_type: 'helpful' } });
      setCount(r.count);
      setDone(true);
    } catch {
      toast(t('profiles.toast.failed'));
    }
  };
  useIntentHandler('review.helpful', async (intent) => {
    if (intent.target !== review.id) return;
    await mark();
  });
  return (
    <Button
      size="sm"
      icon="thumb"
      aria-pressed={done}
      disabled={done}
      onClick={() => gate({ type: 'review.helpful', target: review.id, title: t('profiles.intent.helpful'), run: mark })}
    >
      {count ? t('profiles.reviews.helpfulCount', { count }) : t('profiles.reviews.helpful')}
    </Button>
  );
}

export function ReviewCard({ review: r, orgName, vendor }: { review: PublicReview; orgName: string; vendor?: boolean }) {
  const t = useT();
  const f = useFormat();
  const context = [
    r.vehicle ? [r.vehicle.brand.text, r.vehicle.model.text, r.vehicle.series?.text].filter(Boolean).join(' ') : null,
    r.service_system?.text,
    r.service_task?.text,
  ].filter(Boolean);
  return (
    <article className="pwa-review" aria-labelledby={`review-${r.id}`}>
      <div className="pwa-review-head">
        <Avatar name={r.author.display_name} src={r.author.avatar_url ?? undefined} size={40} />
        <div className="pwa-stack-xs">
          <span id={`review-${r.id}`} className="pwa-text-label">
            <bdi>{r.author.display_name}</bdi>
          </span>
          <span className="pwa-text-caption">{f.date(r.published_at, 'date')}</span>
        </div>
      </div>
      <div className="pwa-badges">
        <ReviewLabel id={`label-${r.id}`} label={r.label} vendor={vendor} t={t} />
        {r.disputed_by_business ? <Badge icon="alert">{t('profiles.reviews.disputed')}</Badge> : null}
        {context.length ? <span className="pwa-text-caption">{context.join(' · ')}</span> : null}
      </div>
      <p className="pwa-rating" aria-label={t('profiles.rating.stars', { value: f.number(r.overall_rating) })}>
        {Array.from({ length: 5 }, (_, i) => (
          <Icon key={i} name="star" size={16} filled={i < r.overall_rating} className={i < r.overall_rating ? 'cp-star' : 'pwa-star-off'} />
        ))}
      </p>
      {r.title ? (
        <p className="pwa-text-label m-0" dir="auto" lang={r.content_locale}>
          {r.title}
        </p>
      ) : null}
      <p className="pwa-text-body pwa-ugc" dir="auto" lang={r.content_locale}>
        {r.body}
      </p>
      {r.tags.length ? (
        <div className="pwa-badges" aria-label={t('profiles.reviews.tags')}>
          {r.tags.map((tag) => (
            <Badge key={tag.node_id}>{tag.label.text}</Badge>
          ))}
        </div>
      ) : null}
      {r.media.length ? (
        <div className="pwa-thumbs">
          {r.media.map((m) => (
            <MediaImage
              key={m.attachment_id}
              url={m.url}
              thumbnailUrl={m.thumbnail_url}
              variant="thumb"
              alt=""
              aspect="square"
              placeholder={t('profiles.portfolio.photoPending')}
            />
          ))}
        </div>
      ) : null}
      {r.response ? (
        <div className="pwa-reply">
          <p className="pwa-text-caption">{t('profiles.reviews.reply', { name: orgName })}</p>
          <p className="pwa-text-body pwa-ugc" dir="auto" lang={r.response.content_locale}>
            {r.response.response_text}
          </p>
        </div>
      ) : null}
      <div>
        <HelpfulButton review={r} />
      </div>
    </article>
  );
}

type Filters = { verified: boolean; sort: 'recent' | 'helpful'; rating: number | null };
const DEFAULT: Filters = { verified: false, sort: 'recent', rating: null };

export function ReviewList({
  orgId,
  orgName,
  initial,
  vendor,
}: {
  orgId: string;
  orgName: string;
  initial: { items: PublicReview[]; next_cursor: string | null };
  vendor?: boolean;
}) {
  const t = useT();
  const [filters, setFilters] = useState<Filters>(DEFAULT);
  const [more, setMore] = useState(false);
  const live = more || filters.verified || filters.sort !== 'recent' || filters.rating !== null;
  const q = useApiInfiniteQuery(
    'public.org_reviews',
    {
      path: { org_id: orgId },
      query: {
        limit: 10,
        sort: filters.sort,
        ...(filters.verified ? { path: 'visit_based' as const } : {}),
        ...(filters.rating ? { rating: filters.rating } : {}),
      },
    },
    { enabled: live },
  );
  const items = live ? (q.data?.pages.flatMap((p) => p.items) ?? []) : initial.items;
  const hasMore = live ? q.hasNextPage : !!initial.next_cursor;
  const pages = q.data?.pages.length ?? 0;
  const unfiltered = !filters.verified && filters.sort === 'recent' && filters.rating === null;
  // "Show more" on the server-rendered page: the live list starts with the same first page, so go on to the second.
  useEffect(() => {
    if (more && unfiltered && pages === 1 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [more, unfiltered, pages, q]);

  if (!live && initial.items.length === 0)
    return (
      <StateView kind="empty" t={t} title={t('profiles.reviews.empty')} text={t('profiles.reviews.emptyText')} compact headingLevel={3} />
    );

  return (
    <div className="pwa-stack">
      <div className="pwa-chips" role="group" aria-label={t('profiles.reviews.filters')}>
        <Chip selected={filters.verified} icon="check" onClick={() => setFilters((x) => ({ ...x, verified: !x.verified }))}>
          {vendor ? t('profiles.reviews.verifiedPurchaseOnly') : t('profiles.reviews.verifiedOnly')}
        </Chip>
        <Chip selected={filters.sort === 'recent'} onClick={() => setFilters((x) => ({ ...x, sort: 'recent' }))}>
          {t('profiles.reviews.recent')}
        </Chip>
        <Chip selected={filters.sort === 'helpful'} onClick={() => setFilters((x) => ({ ...x, sort: 'helpful' }))}>
          {t('profiles.reviews.mostHelpful')}
        </Chip>
        <Chip
          selected={filters.rating !== null && filters.rating <= 2}
          onClick={() => setFilters((x) => ({ ...x, rating: x.rating === 1 ? null : 1 }))}
        >
          {t('profiles.reviews.critical')}
        </Chip>
        {[5, 4, 3].map((n) => (
          <Chip
            key={n}
            selected={filters.rating === n}
            icon="star"
            onClick={() => setFilters((x) => ({ ...x, rating: x.rating === n ? null : n }))}
          >
            {t('profiles.reviews.stars', { count: n })}
          </Chip>
        ))}
      </div>
      {live && q.isPending ? (
        <SkeletonCard lines={3} />
      ) : live && q.error ? (
        <StateView
          kind={stateFromProblem(q.error)}
          t={t}
          compact
          action={<Button onClick={() => void q.refetch()}>{t('common.actions.retry')}</Button>}
        />
      ) : items.length === 0 ? (
        <p className="pwa-text-body">{t('profiles.reviews.noMatch')}</p>
      ) : (
        <div className="pwa-stack">
          {items.map((r) => (
            <ReviewCard key={r.id} review={r} orgName={orgName} vendor={vendor} />
          ))}
        </div>
      )}
      {hasMore ? (
        <div>
          <Button loading={q.isFetchingNextPage} onClick={() => (live ? void q.fetchNextPage() : setMore(true))}>
            {t('profiles.reviews.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
