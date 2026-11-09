// Port of the design system's Badge (bundle.js; same classes and props).
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export type BadgeTone = 'neutral' | 'signal' | 'accent' | 'success' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', icon, children, className }: BadgeProps) {
  return (
    <span className={cx('cp-badge', `cp-badge-${tone}`, className)}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}
