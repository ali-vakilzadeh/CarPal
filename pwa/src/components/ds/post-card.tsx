// Port of the design system's PostCard (bundle.js; same classes and props). The bundle's buttons have no handlers;
// the optional on* callbacks are the hooks the community screens (P8) need, everything else is unchanged.
import { Avatar } from './avatar';
import { Badge, type BadgeTone } from './badge';
import { Button } from './button';
import { cx } from './cx';
import { fmt } from './fmt';
import { Icon, type IconName } from './icon';
import { Tagged, type TaggedProps } from './tagged';

type Role = 'owner' | 'mechanic' | 'seller';

const ROLE: Record<Role, [string, BadgeTone, IconName]> = {
  owner: ['Car owner', 'neutral', 'car'],
  mechanic: ['Mechanic', 'accent', 'wrench'],
  seller: ['Parts seller', 'accent', 'store'],
};

export interface PostCardProps {
  author: string;
  handle: string;
  time: string;
  text: string;
  avatar?: string;
  /** Who is speaking: shows a role badge beside the name. */
  role?: Role;
  /** signal ring on the avatar */
  verified?: boolean;
  /** Mechanics, shops or parts mentioned in the post. */
  tagged?: TaggedProps[];
  likes?: number;
  comments?: number;
  liked?: boolean;
  /** Primary call to action, e.g. "Book service". */
  cta?: string;
  highlight?: boolean;
  /** 'fa' renders counts in Persian digits. */
  locale?: 'en' | 'fa';
  lang?: string;
  labels?: { share?: string; more?: string; roles?: Partial<Record<Role, string>> };
  className?: string;
  onLike?: () => void;
  onComment?: () => void;
  onShare?: () => void;
  onMore?: () => void;
  onCta?: () => void;
}

export function PostCard(p: PostCardProps) {
  const locale = p.locale ?? 'en';
  const labels = p.labels ?? {};
  const role = p.role ? ROLE[p.role] : null;
  const roleText = p.role && role ? (labels.roles?.[p.role] ?? role[0]) : null;
  return (
    <article className={cx('cp-post', p.highlight && 'is-highlight', p.className)} lang={p.lang}>
      <header className="cp-post-head">
        <Avatar name={p.author} src={p.avatar} ring={p.verified} />
        <div className="cp-post-who">
          <span className="cp-post-name">
            <bdi className="cp-post-author">{p.author}</bdi>
            {role ? (
              <Badge tone={role[1]} icon={role[2]}>
                {roleText}
              </Badge>
            ) : null}
          </span>
          <span className="cp-post-meta">
            <bdi dir="ltr">{p.handle}</bdi> · <time>{p.time}</time>
          </span>
        </div>
        <button type="button" className="cp-iconbtn" aria-label={labels.more ?? 'More'} onClick={p.onMore}>
          <Icon name="more" />
        </button>
      </header>
      <p className="cp-post-text" dir="auto">
        {p.text}
      </p>
      {(p.tagged ?? []).map((x, i) => (
        <Tagged key={i} locale={locale} {...x} />
      ))}
      <footer className="cp-post-actions">
        <button type="button" className={cx('cp-action', p.liked && 'is-on')} aria-pressed={!!p.liked} onClick={p.onLike}>
          <Icon name="heart" filled={p.liked} />
          <span>{fmt(p.likes ?? 0, locale)}</span>
        </button>
        <button type="button" className="cp-action" onClick={p.onComment}>
          <Icon name="comment" />
          <span>{fmt(p.comments ?? 0, locale)}</span>
        </button>
        <button type="button" className="cp-action" onClick={p.onShare}>
          <Icon name="share" />
          <span>{labels.share ?? 'Share'}</span>
        </button>
        {p.cta ? (
          <Button variant="primary" size="sm" className="cp-post-cta" onClick={p.onCta}>
            {p.cta}
          </Button>
        ) : null}
      </footer>
    </article>
  );
}
