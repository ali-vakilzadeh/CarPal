// Port of the design system's TextField (bundle.js; same classes and props) with the `prefix` and `end` slots of
// mobile/preview/js/kit.js Field (proposed DS addition, DI-21). The id comes from useId so server and client agree.
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { Icon, type IconName } from './icon';

type Shared = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: IconName;
  /** proposed DS addition: content before the input inside the box (e.g. a fixed "+98"). */
  prefix?: ReactNode;
  /** proposed DS addition: content after the input inside the box (e.g. a clear button or unit). */
  end?: ReactNode;
  className?: string;
};

export type TextFieldProps =
  | (Shared & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'>)
  | (Shared & { multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>);

export function TextField(props: TextFieldProps) {
  const auto = useId();
  const { label, hint, error, icon, prefix, end, className, multiline, id: givenId, ...rest } = props;
  const id = givenId ?? `cp-f${auto}`;
  const described = error || hint ? `${id}-d` : undefined;
  const common = {
    dir: 'auto',
    id,
    className: 'cp-field-input',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described,
  } as const;
  return (
    <div className={cx('cp-field', !!error && 'is-error', className)}>
      <label className="cp-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cp-field-box">
        {icon ? <Icon name={icon} size={20} /> : null}
        {prefix ?? null}
        {multiline ? (
          <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...common} />
        ) : (
          <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...common} />
        )}
        {end ?? null}
      </div>
      {described ? (
        <p id={described} className="cp-field-hint">
          {error ? <Icon name="alert" size={16} /> : null}
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}
