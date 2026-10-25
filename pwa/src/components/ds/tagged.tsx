// Port of the design system's Tagged (bundle.js; same classes and props): a business or product tagged in a post —
// a mechanic's shop (with rating) or a part (with price and stock).
import { Badge, type BadgeTone } from './badge';
import { fmt } from './fmt';
import { Icon, type IconName } from './icon';

export interface TaggedProps {
  /** wrench = a mechanic's shop, part = a spare part, store = a parts shop */
  icon?: IconName;
  title: string;
  /** place, or which cars the part fits */
  detail?: string;
  /** 0–5, shown with a filled star */
  rating?: number;
  ratingLabel?: string;
  /** already formatted, e.g. "1,850,000 T" */
  price?: string;
  badge?: { text: string; tone?: BadgeTone; icon?: IconName };
  locale?: 'en' | 'fa';
}

export function Tagged({ icon = 'wrench', title, detail, rating, ratingLabel = 'Rating', price, badge, locale = 'en' }: TaggedProps) {
  return (
    <div className="cp-tagged">
      <span className="cp-tagged-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="cp-tagged-body">
        <bdi className="cp-tagged-title">{title}</bdi>
        {detail ? (
          <span className="cp-tagged-detail" dir="auto">
            {detail}
          </span>
        ) : null}
        {price || badge ? (
          <span className="cp-tagged-buy">
            {price ? <span className="cp-price">{price}</span> : null}
            {badge ? (
              <Badge tone={badge.tone ?? 'success'} icon={badge.icon}>
                {badge.text}
              </Badge>
            ) : null}
          </span>
        ) : null}
      </span>
      {rating != null ? (
        <span className="cp-rating" aria-label={`${ratingLabel} ${fmt(rating, locale)}`}>
          <Icon name="star" size={18} filled className="cp-star" />
          {fmt(rating, locale)}
        </span>
      ) : null}
    </div>
  );
}
