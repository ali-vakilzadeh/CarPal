// Port of the design system's Chip (bundle.js; same classes and props) with the kit.js extensions (proposed DS
// addition, DI-21): a trailing icon (`iconEnd`, e.g. a remove ✕ or a ▾), `toggle={false}` for chips that act
// rather than toggle (no aria-pressed), an accessible `label` and `disabled`.
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

export interface ChipProps {
  selected?: boolean;
  icon?: IconName;
  /** proposed DS addition */
  iconEnd?: IconName;
  /** proposed DS addition: false = an action chip, not a toggle. */
  toggle?: boolean;
  /** proposed DS addition: accessible name when the visible text is not enough. */
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
}

export function Chip({ selected, icon, iconEnd, toggle = true, label, disabled, onClick, children, className }: ChipProps) {
  return (
    <button
      type="button"
      className={cx('cp-chip', selected && 'is-selected', className)}
      aria-pressed={toggle ? !!selected : undefined}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {selected ? <Icon name="check" size={18} /> : icon ? <Icon name={icon} size={18} /> : null}
      <span>{children}</span>
      {iconEnd ? <Icon name={iconEnd} size={18} /> : null}
    </button>
  );
}
