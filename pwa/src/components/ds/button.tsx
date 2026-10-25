// Port of the design system's Button (bundle.js; same classes and props). `buttonClass` gives links that look like
// buttons (navigation stays an <a>) the same classes.
import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = signal fill, once per screen. Default secondary. */
  variant?: ButtonVariant;
  /** md = 48px (default), sm = 40px. */
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  block?: boolean;
  loading?: boolean;
}

export function buttonClass(
  o: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; loading?: boolean; className?: string } = {},
) {
  return cx(
    'cp-btn',
    `cp-btn-${o.variant ?? 'secondary'}`,
    `cp-btn-${o.size ?? 'md'}`,
    o.block && 'cp-btn-block',
    o.loading && 'is-loading',
    o.className,
  );
}

export function Button({ variant, size, icon, iconEnd, block, loading, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={buttonClass({ variant, size, block, loading, className })}
      aria-busy={loading ? true : undefined}
      disabled={disabled || loading}
    >
      {icon ? <Icon name={icon} size={20} /> : null}
      <span className="cp-btn-label">{children}</span>
      {iconEnd ? <Icon name={iconEnd} size={20} /> : null}
    </button>
  );
}
