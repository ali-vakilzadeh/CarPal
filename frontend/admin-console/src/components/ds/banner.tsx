// Banner and SafetyBanner of mobile/preview/js/kit.js (proposed DS addition, DI-21). The safety banner is outlined
// (surface + danger edge, icon, plain instruction, one action) because the tokens have no on-danger colour; it is
// never hidden behind a tap and never relies on colour alone (Docs/21 §1 principle 5).
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export type BannerTone = 'info' | 'warn' | 'plain' | 'danger' | 'success';

const TONE_ICON: Record<BannerTone, IconName> = { danger: 'alert', warn: 'alert', success: 'check', info: 'info', plain: 'info' };

export interface BannerProps {
  tone?: BannerTone;
  icon?: IconName;
  title?: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Banner({ tone = 'info', icon, title, text, children, className }: BannerProps) {
  return (
    <div className={cx('pwa-banner', `is-${tone}`, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon ?? TONE_ICON[tone]} />
      <div className="pwa-banner-body">
        {title ? <p className={cx('pwa-banner-title', tone === 'danger' && 'pwa-safety-title')}>{title}</p> : null}
        {text ? <p className="pwa-banner-text">{text}</p> : null}
        {children}
      </div>
    </div>
  );
}

export interface SafetyBannerProps {
  title: ReactNode;
  text: ReactNode;
  /** The one action, e.g. a "Find urgent help" button or link. */
  action?: ReactNode;
  className?: string;
}

export function SafetyBanner({ title, text, action, className }: SafetyBannerProps) {
  return (
    <Banner tone="danger" title={title} text={text} className={className}>
      {action ? <div className="pwa-banner-actions">{action}</div> : null}
    </Banner>
  );
}
