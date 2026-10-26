// A search result card (Docs/21 C-SEARCH-01 zone 4, Docs/22 W-SRCH-01 / W-PUB-04; 54 §5 match reasons). Provider:
// name, about how far, rating and count, badges, the first match reason (all reasons and the explanation one tap
// away), next available slot, price indicator, open now, portfolio thumbnail. Parts seller: the same header plus the
// matching parts for the car ("3 parts fit your car"). Part (inventory_item): the part card elements and its seller.
// Never sponsored (is_sponsored is always false); public data only. Server-renderable: the search page adds its
// client actions through `actions` and listens for opens on the card link (data-result-*), so a plain click, a
// Ctrl/Cmd-click or a middle click all work as links do.
import type { ResultCard } from '@carpal/api-contracts';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { MediaImage } from '@/components/media/media-image';
import { PriceText, RatingLine, fitmentTone, stockTone } from '@/features/profiles';
import type { Formatter } from '@/lib/format';
import { Bidi } from '@/lib/format/bidi';
import type { Locale } from '@/lib/i18n/locales';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { orgPath, partPath } from '@/lib/seo/urls';

/** The page a card opens: the part page for parts, else the organization's profile. */
export function resultHref(r: ResultCard, locale: Locale): string | null {
  if (r.target.type === 'inventory_item' && r.item && r.organization.slug)
    return partPath(locale, r.organization.slug, r.item.id, r.item.name.text);
  return orgPath(locale, r.organization);
}

/** "about 2.4 km" from the card's distance (km, one decimal, straight line). */
export function distanceText(r: ResultCard, f: Formatter): string | null {
  const km = r.distance_km === null ? NaN : Number(r.distance_km);
  return Number.isFinite(km) ? f.distance(km * 1000) : null;
}

export function ResultCardView({
  r,
  locale,
  t,
  f,
  actions,
  headingLevel = 3,
  highlighted,
  bestMatch,
}: {
  r: ResultCard;
  locale: Locale;
  t: Translate;
  f: Formatter;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  /** The map's hovered or selected place. */
  highlighted?: boolean;
  /** Shows the rank number (best-match order). */
  bestMatch?: boolean;
}) {
  const o = r.organization;
  const href = resultHref(r, locale);
  const H = `h${headingLevel}` as 'h2' | 'h3';
  const isPart = r.target.type === 'inventory_item' && r.item;
  const title = isPart ? r.item!.name.text : o.name;
  const distance = distanceText(r, f);
  const reason = r.reasons[0];
  const typeLabel = t(`profiles.orgType.${o.organization_type}` as MessageKey);
  const thumb = isPart ? r.item!.image_url : o.portfolio_thumbnail_url;
  const reasonsId = `reasons-${r.result_id}`;
  const facts = [isPart ? o.name : typeLabel, distance, r.location?.city].filter(Boolean);
  return (
    <article
      className={cx('pwa-result', highlighted && 'is-highlighted')}
      data-result-id={r.result_id}
      data-location-id={r.location?.location_id ?? undefined}
    >
      <div className="pwa-result-media">
        <MediaImage
          url={thumb}
          variant="thumb"
          alt=""
          aspect="square"
          placeholder={isPart ? t('profiles.parts.photoPending') : typeLabel}
          placeholderIcon={isPart ? 'part' : o.roles.includes('provider') ? 'wrench' : 'store'}
        />
        {bestMatch && r.rank <= 3 ? (
          <span className="pwa-result-rank" aria-label={t('search.map.rank', { rank: f.number(r.rank) })}>
            {f.number(r.rank)}
          </span>
        ) : null}
      </div>
      <div className="pwa-result-body">
        <H className="pwa-text-label m-0">
          {href ? (
            <a
              href={href}
              className="pwa-card-link"
              data-result-link={r.result_id}
              data-rank={r.rank}
              data-org-id={o.id}
              data-target-type={r.target.type}
              dir="auto"
            >
              <Bidi>{title}</Bidi>
            </a>
          ) : (
            <Bidi>{title}</Bidi>
          )}
        </H>
        <span className="pwa-text-caption">{facts.join(' · ')}</span>
        <RatingLine value={o.overall_rating} count={o.review_count} t={t} f={f} />
        <span className="pwa-badges">
          {o.verified ? (
            <Badge tone="accent" icon="shield">
              {t('profiles.badge.verified_business.label')}
            </Badge>
          ) : null}
          {o.top_badges
            .filter((b) => b !== 'verified_business')
            .slice(0, 2)
            .map((b) => (
              <Badge key={b}>{t(`profiles.badge.${b}.label` as MessageKey)}</Badge>
            ))}
          {r.open_now === true ? (
            <Badge tone="success" icon="clock">
              {t('profiles.location.openNow')}
            </Badge>
          ) : r.open_now === false ? (
            <Badge icon="clock">{t('profiles.location.closedNow')}</Badge>
          ) : null}
          {o.price_tier && o.price_tier !== 'unspecified' ? <Badge>{t(`profiles.priceTier.${o.price_tier}` as MessageKey)}</Badge> : null}
        </span>
        {isPart ? <PartFacts r={r} t={t} f={f} /> : null}
        {!isPart && r.matching_item_count ? (
          <span className="pwa-text-body">
            <Icon name="part" size={16} /> {t('search.result.partsFit', { count: r.matching_item_count })}
          </span>
        ) : null}
        {reason ? (
          <p className="pwa-result-reason m-0" dir="auto">
            <Icon name="check" size={16} /> {reason.summary.text}
          </p>
        ) : null}
        {r.relevant_to_vehicle === false ? <span className="pwa-text-caption">{t('search.result.noVehicleEvidence')}</span> : null}
        {r.next_available_slot ? (
          <span className="pwa-text-caption">
            <Icon name="calendar" size={16} /> {t('search.result.nextSlot', { when: f.date(r.next_available_slot, 'dateTime') })}
          </span>
        ) : null}
        <details className="pwa-disclosure pwa-result-why">
          <summary>{t('search.result.why')}</summary>
          <ul id={reasonsId} className="pwa-plain-list pwa-stack-xs">
            {r.reasons.map((x, i) => (
              <li key={`${x.reason_type}-${i}`} className="pwa-text-caption" dir="auto">
                {x.summary.text}
              </li>
            ))}
          </ul>
          <p className="pwa-text-caption m-0" dir="auto">
            {r.explanation.source === 'ai' ? <Badge icon="spark">{t('search.result.aiSuggestion')}</Badge> : null} {r.explanation.text}
          </p>
          <a className="pwa-link pwa-text-caption" href={`/${locale}/how-ranking-works`}>
            {t('search.result.howRanking')}
          </a>
        </details>
        {actions ? <div className="pwa-result-actions">{actions}</div> : null}
      </div>
    </article>
  );
}

function PartFacts({ r, t, f }: { r: ResultCard; t: Translate; f: Formatter }) {
  const it = r.item!;
  return (
    <>
      <span className="pwa-text-caption">
        {t(`profiles.parts.condition.${it.condition}`)} · {t(`profiles.parts.origin.${it.part_origin}`)} · {it.part_category.text}
      </span>
      <PriceText item={it} t={t} f={f} />
      <span className="pwa-badges">
        <Badge tone={stockTone(it.stock_status)} icon={it.stock_status === 'out_of_stock' ? 'close' : 'check'}>
          {t(`profiles.parts.stock.${it.stock_status}`)}
        </Badge>
        {it.fitment_confidence_for_vehicle ? (
          <Badge
            tone={fitmentTone(it.fitment_confidence_for_vehicle)}
            icon={it.fitment_confidence_for_vehicle === 'confirmed' ? 'check' : 'help'}
          >
            {t(`profiles.parts.fitsYourCar.${it.fitment_confidence_for_vehicle}`)}
          </Badge>
        ) : null}
      </span>
    </>
  );
}
