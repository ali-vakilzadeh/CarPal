// Port of the design system's TopBar (bundle.js; same classes and props): a back button is drawn when `onBack` is
// given (null = drawn without a handler, as in the bundle), then the title and the actions.
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './icon';

export interface TopBarProps {
  title: ReactNode;
  onBack?: (() => void) | null;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}

export function TopBar({ title, onBack, backLabel = 'Back', actions, className }: TopBarProps) {
  return (
    <header className={cx('cp-topbar', className)}>
      {onBack !== undefined ? (
        <button type="button" className="cp-iconbtn" aria-label={backLabel} onClick={onBack ?? undefined}>
          <Icon name="back" />
        </button>
      ) : null}
      <h1 className="cp-topbar-title">{title}</h1>
      <div className="cp-topbar-actions">{actions}</div>
    </header>
  );
}
