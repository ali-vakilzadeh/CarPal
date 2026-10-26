// A compact organization card (PublicOrgCard): logo, name, type, Verified Business, rating and count, linking to the
// profile. Used for "Popular specialists near you" on the landing page, the showcase author and the seller of a part.
// Server-renderable.
import type { PublicOrgCard } from '@carpal/api-contracts';
import { Avatar } from '@/components/ds/avatar';
import { Badge } from '@/components/ds/badge';
import { cx } from '@/components/ds/cx';
import type { Formatter } from '@/lib/format';
import { Bidi } from '@/lib/format/bidi';
import type { Locale } from '@/lib/i18n/locales';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { orgPath } from '@/lib/seo/urls';
import { RatingLine } from './trust';

export function OrgCard({
  org,
  locale,
  t,
  f,
  detail,
  headingLevel = 3,
  className,
}: {
  org: PublicOrgCard;
  locale: Locale;
  t: Translate;
  f: Formatter;
  /** An extra line, e.g. the area or a distance. */
  detail?: string | null;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const href = orgPath(locale, org);
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const name = (
    <Bidi>
      <span className="pwa-org-card-name">{org.name}</span>
    </Bidi>
  );
  return (
    <article className={cx('pwa-org-card', className)}>
      <Avatar name={org.name} src={org.logo_url ?? undefined} size={48} ring={org.verified} />
      <div className="pwa-org-card-body">
        <H className="pwa-text-label m-0">
          {href ? (
            <a href={href} className="pwa-card-link">
              {name}
            </a>
          ) : (
            name
          )}
        </H>
        <span className="pwa-text-caption">{t(`profiles.orgType.${org.organization_type}` as MessageKey)}</span>
        <RatingLine value={org.overall_rating} count={org.review_count} t={t} f={f} />
        {detail ? <span className="pwa-text-caption">{detail}</span> : null}
        {org.verified ? (
          <span>
            <Badge tone="accent" icon="shield">
              {t('profiles.badge.verified_business.label')}
            </Badge>
          </span>
        ) : null}
      </div>
    </article>
  );
}
