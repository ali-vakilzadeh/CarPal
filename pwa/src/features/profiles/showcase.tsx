// Showcase body (Docs/22 W-PUB-05, mirrors C-PROV-02 and C-COMM-02): post type label, context chips (vehicle, repair
// area), the before/after slider (or the gallery), title, text, dates, tags and the linked provider card with Follow.
// Shared by the showcase page (server) and the portfolio modal on profiles (client), so it takes t and the formatter
// as props and holds no hooks. Comments and reactions come with P8; customer consent has no public field (P5 report).
import type { PublicPortfolioItem } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { MediaImage } from '@/components/media/media-image';
import type { Formatter } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { BeforeAfter } from './before-after';
import { FollowButton } from './org-actions';
import { OrgCard } from './org-card';
import { beforeAfter } from './view-model';

export function ShowcaseBody({
  item,
  locale,
  t,
  f,
  headingLevel = 1,
  priority,
}: {
  item: PublicPortfolioItem;
  locale: Locale;
  t: Translate;
  f: Formatter;
  headingLevel?: 1 | 2;
  priority?: boolean;
}) {
  const { before, after, rest } = beforeAfter(item.media);
  const vehicle = [item.vehicle.brand?.text, item.vehicle.model?.text, item.vehicle.series?.text].filter(Boolean).join(' ');
  const H = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <article className="pwa-showcase" lang={item.content_locale}>
      <div className="pwa-badges">
        <Badge tone="accent" icon="image">
          {t('profiles.showcase.label')}
        </Badge>
        {vehicle ? (
          <Badge icon="car">
            <bdi>{vehicle}</bdi>
          </Badge>
        ) : null}
        <Badge icon="wrench">{item.service_system.text}</Badge>
        {item.service_task ? <Badge>{item.service_task.text}</Badge> : null}
      </div>
      {before || after ? (
        <BeforeAfter before={before} after={after} priority={priority} />
      ) : (
        <MediaImage url={null} alt="" placeholder={t('profiles.showcase.photoPending')} priority={priority} />
      )}
      <H className={headingLevel === 1 ? 'pwa-text-title m-0' : 'pwa-text-h2 m-0'} dir="auto">
        {item.title}
      </H>
      <p className="pwa-text-caption">
        {t('profiles.showcase.published', { date: f.date(item.published_at, 'date') })}
        {item.job_date ? ` · ${t('profiles.showcase.jobDate')}: ${f.calendarDate(item.job_date)}` : ''}
      </p>
      {item.description ? (
        <p className="pwa-text-body pwa-ugc" dir="auto">
          {item.description}
        </p>
      ) : null}
      {item.caption && item.caption !== item.description ? (
        <p className="pwa-text-body pwa-ugc" dir="auto">
          {item.caption}
        </p>
      ) : null}
      {item.tags.length ? (
        <div className="pwa-badges">
          {item.tags.map((tag) => (
            <Badge key={tag.node_id}>{tag.label.text}</Badge>
          ))}
        </div>
      ) : null}
      {rest.length ? (
        <div className="pwa-gallery-grid" aria-label={t('profiles.showcase.gallery')}>
          {rest.map((m) => (
            <MediaImage
              key={m.attachment_id}
              url={m.url}
              thumbnailUrl={m.thumbnail_url}
              variant="thumb"
              alt={m.caption ?? ''}
              aspect="square"
              placeholder={t('profiles.showcase.photoPending')}
            />
          ))}
        </div>
      ) : null}
      <div className="pwa-showcase-author" lang={locale}>
        <OrgCard org={item.organization} locale={locale} t={t} f={f} headingLevel={headingLevel === 1 ? 2 : 3} />
        <FollowButton orgId={item.organization.id} name={item.organization.name} size="sm" />
      </div>
    </article>
  );
}
