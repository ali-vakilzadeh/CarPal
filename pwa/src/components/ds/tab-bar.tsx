// Port of the design system's TabBar (bundle.js; same classes and props): the orange selector bar sits on top of
// the active tab, the primary tab is the raised signal button. Items with an `href` render as links through
// `linkAs` (e.g. next/link), so the bottom navigation is real navigation — an addition for the web shell.
import type { ComponentType, ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export interface TabBarItem {
  id: string;
  label: string;
  icon: IconName;
  /** Accessible text of the dot (e.g. "2 need your action"); the dot is shown when set. */
  badge?: string;
  primary?: boolean;
  /** web addition: navigate instead of onChange */
  href?: string;
}

type LinkLike = ComponentType<{ href: string; className?: string; 'aria-current'?: 'page'; children?: ReactNode }>;

export interface TabBarProps {
  items: TabBarItem[];
  active: string;
  onChange?: (id: string) => void;
  label?: string;
  className?: string;
  linkAs?: LinkLike | 'a';
}

export function TabBar({ items, active, onChange, label = 'Main', className, linkAs = 'a' }: TabBarProps) {
  const Link = linkAs;
  return (
    <nav className={cx('cp-tabbar', className)} aria-label={label}>
      {items.map((it) => {
        const on = it.id === active;
        const body = (
          <>
            <span className="cp-tab-icon">
              <Icon name={it.icon} filled={on && !it.primary} />
              {it.badge ? <span className="cp-tab-dot" role="img" aria-label={it.badge} /> : null}
            </span>
            <span className="cp-tab-label">{it.label}</span>
          </>
        );
        const classes = cx('cp-tab', on && 'is-active', it.primary && 'is-primary');
        if (it.href)
          return (
            <Link key={it.id} href={it.href} className={classes} aria-current={on ? 'page' : undefined}>
              {body}
            </Link>
          );
        return (
          <button
            key={it.id}
            type="button"
            className={classes}
            aria-current={on ? 'page' : undefined}
            onClick={onChange ? () => onChange(it.id) : undefined}
          >
            {body}
          </button>
        );
      })}
    </nav>
  );
}
