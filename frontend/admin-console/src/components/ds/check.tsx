// Check of mobile/preview/js/kit.js (proposed DS addition, DI-21) as a native checkbox: the label is the click target,
// an optional hint is read with it, and keyboard, screen-reader and RTL behaviour come from the platform.
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

export interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  children: ReactNode;
  hint?: ReactNode;
  /** Text after the label inside the row, e.g. a "Read" button. */
  end?: ReactNode;
}

export function Check({ children, hint, end, className, id: givenId, ...rest }: CheckProps) {
  const auto = useId();
  const id = givenId ?? `cp-c${auto}`;
  return (
    <div className={cx('pwa-check', className)}>
      <input id={id} type="checkbox" aria-describedby={hint ? `${id}-h` : undefined} {...rest} />
      <div className="pwa-check-body">
        <label htmlFor={id} className="pwa-check-label">
          {children}
        </label>
        {hint ? (
          <p id={`${id}-h`} className="pwa-text-caption">
            {hint}
          </p>
        ) : null}
      </div>
      {end ?? null}
    </div>
  );
}
