'use client';
// Form pieces of the hosted sign-in: a password field with show/hide (Docs/21 S-AUTH-02/03) and, for new passwords,
// the strength meter with its rules shown before typing; and the 6-box code input (S-AUTH-07): numeric keypad,
// autocomplete="one-time-code", a pasted or autofilled code splits across the boxes, Backspace and the arrow keys move
// between boxes, and the last digit submits. Codes stay left-to-right in Persian too (dir="ltr").
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { Meter } from '@/components/ds/meter';
import { TextField } from '@/components/ds/text-field';
import { toLatinDigits } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { checkPassword, PASSWORD_MAX } from './password';

export interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | null;
  hint?: string;
  /** Shows the strength meter and rules (new passwords). */
  strength?: { contacts: readonly string[] };
  name?: string;
  required?: boolean;
}

export function PasswordField({ label, value, onChange, autoComplete, error, hint, strength, name, required }: PasswordFieldProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const check = strength ? checkPassword(value, strength.contacts) : null;
  return (
    <div className="flex flex-col gap-2">
      <TextField
        label={label}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        maxLength={PASSWORD_MAX}
        name={name}
        required={required}
        dir="ltr"
        error={error ?? undefined}
        hint={hint}
        end={
          <IconButton
            icon="eye"
            label={shown ? t('auth.password.hide') : t('auth.password.show')}
            pressed={shown}
            onClick={() => setShown((v) => !v)}
          />
        }
      />
      {check ? (
        <div className="flex flex-col gap-1">
          <Meter
            value={check.score * 25}
            label={t('auth.password.strength')}
            valueText={check.label ? t(check.label) : undefined}
            tone={check.score <= 1 ? 'danger' : check.score === 2 ? 'signal' : 'accent'}
          />
          {check.label ? <p className="pwa-text-caption">{t(check.label)}</p> : null}
          <ul className="pwa-rules">
            <Rule ok={check.rules.length} text={t('auth.password.ruleLength')} />
            <Rule ok={check.rules.mix} text={t('auth.password.ruleMix')} />
            <Rule ok={check.rules.notContact && value.length > 0} text={t('auth.password.ruleNotContact')} />
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Rule({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={cx('pwa-rule', ok && 'is-ok')}>
      <Icon name={ok ? 'check' : 'info'} size={16} />
      <span>{text}</span>
    </li>
  );
}

const LENGTH = 6;

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called once all six digits are entered. */
  onComplete?: (code: string) => void;
  error?: string | null;
  disabled?: boolean;
  label: string;
  autoFocus?: boolean;
}

export function CodeInput({ value, onChange, onComplete, error, disabled, label, autoFocus }: CodeInputProps) {
  const t = useT();
  const id = useId();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? '');

  const set = (next: string, focusAt?: number) => {
    const clean = toLatinDigits(next).replace(/\D/g, '').slice(0, LENGTH);
    onChange(clean);
    const at = focusAt ?? Math.min(clean.length, LENGTH - 1);
    refs.current[at]?.focus();
    if (clean.length === LENGTH) onComplete?.(clean);
  };

  const onInput = (i: number, typed: string) => {
    const incoming = toLatinDigits(typed).replace(/\D/g, '');
    if (!incoming) return;
    // Autofill and fast typing put several digits into one box: spread them from this box on.
    set(value.slice(0, i) + incoming + value.slice(i + incoming.length));
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) set(value.slice(0, i) + value.slice(i + 1), i);
      else if (i > 0) set(value.slice(0, i - 1) + value.slice(i), i - 1);
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < LENGTH - 1) {
      e.preventDefault();
      refs.current[i + 1]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = toLatinDigits(e.clipboardData.getData('text')).replace(/\D/g, '');
    if (!pasted) return;
    e.preventDefault();
    set(pasted);
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cx('pwa-code', !!error && 'is-error')}
        dir="ltr"
        role="group"
        aria-label={label}
        aria-describedby={error ? `${id}-e` : undefined}
      >
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={d}
            onChange={(e) => onInput(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={onPaste}
            onFocus={(e) => e.target.select()}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={i === 0 ? LENGTH : 1}
            aria-label={t('auth.code.digit', { n: i + 1 })}
            aria-invalid={error ? true : undefined}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
          />
        ))}
      </div>
      {error ? (
        <p id={`${id}-e`} className="cp-field-hint pwa-error-text" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
