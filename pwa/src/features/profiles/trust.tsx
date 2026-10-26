// Trust vocabulary of the public pages (Docs/21 §2.3, Docs/22 W-PUB-02 "clicks a badge → popover: what it means, how it
// is earned"): badges and review labels are buttons that open a native popover with the rule-based explanation, so
// they work in server-rendered HTML without JavaScript and close with Esc or a click outside. The rating line pairs
// the star with the number and the review count in words. Server-renderable: every text arrives through `t`.
import type { BadgeType, PublicBadge } from '@carpal/api-contracts';
import { Badge, type BadgeTone } from '@/components/ds/badge';
import { Icon, type IconName } from '@/components/ds/icon';
import type { Formatter } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

const BADGE_ICON: Record<BadgeType, IconName> = {
  verified_business: 'shield',
  make_specialist: 'car',
  system_expert: 'wrench',
  highly_rated: 'star',
  fast_responder: 'clock',
  high_response_rate: 'chat',
  repeat_customer_favorite: 'heart',
  fast_appointment_turnaround: 'calendar',
  excellent_communication: 'chat',
  fleet_friendly: 'truck',
  ev_ready: 'spark',
};

export interface TrustBadgeProps {
  /** Unique within the page (the popover's id). */
  id: string;
  label: string;
  text: string;
  tone?: BadgeTone;
  icon?: IconName;
  closeLabel: string;
}

export function TrustBadge({ id, label, text, tone = 'accent', icon, closeLabel }: TrustBadgeProps) {
  return (
    <>
      <button type="button" className="pwa-badge-btn" popoverTarget={id} aria-haspopup="dialog">
        <Badge tone={tone} icon={icon}>
          {label}
        </Badge>
      </button>
      <div id={id} popover="auto" className="pwa-popover" role="dialog" aria-label={label}>
        <p className="pwa-text-label m-0">{label}</p>
        <p className="pwa-text-body">{text}</p>
        <button type="button" className="pwa-link" popoverTarget={id} popoverTargetAction="hide">
          {closeLabel}
        </button>
      </div>
    </>
  );
}

/** A badge of the public profile ("Make specialist · BMW"), or the verification state when `verified` is false. */
export function OrgBadges({
  idPrefix,
  verified,
  badges,
  topBadges,
  t,
}: {
  idPrefix: string;
  verified: boolean;
  /** Full badges with scope (providers); vendors and cards only have top_badges. */
  badges?: readonly PublicBadge[];
  topBadges?: readonly BadgeType[];
  t: Translate;
}) {
  const list: { type: BadgeType; scope: string | null }[] = badges?.length
    ? badges.map((b) => ({ type: b.badge_type, scope: b.scope.map((s) => s.text).join(', ') || null }))
    : (topBadges ?? []).map((type) => ({ type, scope: null }));
  const others = list.filter((b) => b.type !== 'verified_business');
  const close = t('common.actions.close');
  return (
    <div className="pwa-badges">
      {verified ? (
        <TrustBadge
          id={`${idPrefix}-verified`}
          label={t('profiles.badge.verified_business.label')}
          text={t('profiles.badge.verified_business.text')}
          icon="shield"
          closeLabel={close}
        />
      ) : (
        <TrustBadge
          id={`${idPrefix}-pending`}
          label={t('profiles.badge.pending.label')}
          text={t('profiles.badge.pending.text')}
          tone="neutral"
          icon="clock"
          closeLabel={close}
        />
      )}
      {others.map((b, i) => {
        const base = t(`profiles.badge.${b.type}.label` as MessageKey);
        return (
          <TrustBadge
            key={`${b.type}-${i}`}
            id={`${idPrefix}-${b.type}-${i}`}
            label={b.scope ? t('profiles.badge.scoped', { label: base, scope: b.scope }) : base}
            text={t(`profiles.badge.${b.type}.text` as MessageKey)}
            tone="neutral"
            icon={BADGE_ICON[b.type]}
            closeLabel={close}
          />
        );
      })}
    </div>
  );
}

/** "★ 4.8 · 126 reviews", or "No reviews yet". */
export function RatingLine({ value, count, t, f }: { value: string | null; count: number; t: Translate; f: Formatter }) {
  if (!value || count === 0) return <span className="pwa-text-caption">{t('profiles.rating.none')}</span>;
  const shown = f.number(Number(value), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <span className="pwa-rating">
      <Icon name="star" size={20} className="cp-star" />
      <span className="pwa-rating-value" aria-hidden="true">
        {shown}
      </span>
      <span className="sr-only">{t('profiles.rating.stars', { value: shown })}</span>
      <span className="pwa-text-caption">· {t('profiles.rating.count', { count })}</span>
    </span>
  );
}

/** Review confirmation label (Verified visit / Verified purchase / Approved by the business and CarPal) with its rule. */
export function ReviewLabel({
  id,
  label,
  vendor,
  t,
}: {
  id: string;
  label: 'verified_visit' | 'approved_by_business_and_carpal';
  vendor?: boolean;
  t: Translate;
}) {
  const kind = label === 'verified_visit' && vendor ? 'verified_purchase' : label;
  return (
    <TrustBadge
      id={id}
      label={t(`profiles.reviews.label.${kind}`)}
      text={t(`profiles.reviews.labelText.${kind}`)}
      tone={kind === 'approved_by_business_and_carpal' ? 'accent' : 'success'}
      icon={kind === 'approved_by_business_and_carpal' ? 'shield' : 'check'}
      closeLabel={t('common.actions.close')}
    />
  );
}
