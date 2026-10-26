// Header band of the provider and vendor profiles (Docs/22 W-PUB-02/03, mirrors C-PROV-01 / C-VEND-01 headers): cover,
// logo, name, type, Verified Business (or "Verification pending"), badges with popovers, rating and count, area,
// response time, price tier or delivery options, and Follow / Save / Share. Server-rendered; the actions are a client
// island. The cover is the page's LCP image (priority).
import type { PublicOrgProfile } from '@carpal/api-contracts';
import { Avatar } from '@/components/ds/avatar';
import { Icon } from '@/components/ds/icon';
import { MediaImage } from '@/components/media/media-image';
import type { Formatter } from '@/lib/format';
import { Bidi } from '@/lib/format/bidi';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { OrgActions } from './org-actions';
import { OrgBadges, RatingLine } from './trust';
import { primaryLocation } from './view-model';

/** "Garage", "Parts retailer", or the organization type when no profile type is published. */
export function orgTypeLabel(p: PublicOrgProfile, t: Translate, as: 'provider' | 'vendor'): string {
  if (as === 'provider' && p.provider) return t(`profiles.providerType.${p.provider.provider_type}` as MessageKey);
  if (as === 'vendor' && p.vendor) return t(`profiles.vendorType.${p.vendor.vendor_type}` as MessageKey);
  return t(`profiles.orgType.${p.organization_type}` as MessageKey);
}

/** "Usually replies within 40 min" (measured) or the published target. */
export function responseLine(p: PublicOrgProfile, t: Translate): string | null {
  const m = p.measured_response_time_minutes;
  if (m !== null)
    return m < 120
      ? t('profiles.response.measuredMinutes', { count: m })
      : t('profiles.response.measuredHours', { count: Math.round(m / 60) });
  const target = p.provider?.response_time_target;
  return target ? t(`profiles.response.${target}`) : null;
}

export function OrgHeader({
  profile: p,
  as,
  path,
  t,
  f,
}: {
  profile: PublicOrgProfile;
  as: 'provider' | 'vendor';
  path: string;
  t: Translate;
  f: Formatter;
}) {
  const loc = primaryLocation(p);
  const response = responseLine(p, t);
  const count = p.rating_summary.count_visit_verified + p.rating_summary.count_approved_without_visit;
  const facts: string[] = [];
  if (loc) facts.push(loc.address.city);
  if (as === 'provider' && p.price_tier && p.price_tier !== 'unspecified') facts.push(t(`profiles.priceTier.${p.price_tier}`));
  if (as === 'vendor') for (const d of p.vendor?.delivery_options ?? []) facts.push(t(`profiles.vendor.delivery.${d}`));
  return (
    <header className="pwa-org-header">
      <MediaImage
        url={p.portfolio_thumbnail_url}
        alt=""
        aspect="wide"
        priority
        placeholder={p.name}
        placeholderIcon={as === 'provider' ? 'wrench' : 'store'}
        className="pwa-org-cover"
      />
      <div className="pwa-org-head">
        <Avatar name={p.name} src={p.logo_url ?? undefined} size={64} ring={p.verified} className="pwa-org-logo" />
        <div className="pwa-org-title">
          <h1 className="pwa-text-title m-0">
            <Bidi>{p.name}</Bidi>
          </h1>
          <p className="pwa-text-caption">{orgTypeLabel(p, t, as)}</p>
        </div>
      </div>
      <OrgBadges idPrefix={`badge-${p.id}`} verified={p.verified} badges={p.provider?.badges} topBadges={p.top_badges} t={t} />
      <div className="pwa-org-facts">
        <RatingLine value={p.rating_summary.overall ?? p.overall_rating} count={count} t={t} f={f} />
        {facts.map((x) => (
          <span key={x} className="pwa-text-caption">
            · {x}
          </span>
        ))}
      </div>
      {response ? (
        <p className="pwa-org-response">
          <Icon name="clock" size={20} />
          {response}
        </p>
      ) : null}
      <OrgActions orgId={p.id} name={p.name} path={path} />
    </header>
  );
}
