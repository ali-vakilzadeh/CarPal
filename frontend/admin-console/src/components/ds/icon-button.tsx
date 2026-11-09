// Icon-only button on the design system's .cp-iconbtn class (used by PostCard and TopBar in bundle.js), as a
// component: mobile/preview/js/kit.js IconBtn (proposed DS addition). Always has an accessible label; an optional
// count badge (max "99+") or dot sits at the inline-end top corner.
import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: IconName;
  /** Accessible name in the UI language (required: the button has no visible text). */
  label: string;
  filled?: boolean;
  /** Toggle buttons: aria-pressed. */
  pressed?: boolean;
  /** Already formatted count (e.g. "۴", "99+"); shown as a badge. */
  count?: string;
  dot?: boolean;
  size?: number;
  iconClassName?: string;
}

export function IconButton({ icon, label, filled, pressed, count, dot, size, iconClassName, className, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={cx('cp-iconbtn', (count || dot) && 'pwa-has-badge', className)}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
    >
      <Icon name={icon} filled={filled} size={size} className={iconClassName} />
      {count ? (
        <span className="pwa-count" aria-hidden="true">
          {count}
        </span>
      ) : null}
      {dot && !count ? <span className="pwa-dot pwa-dot-abs" aria-hidden="true" /> : null}
    </button>
  );
}
