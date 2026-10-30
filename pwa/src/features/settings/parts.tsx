'use client';
// Building blocks of the settings sections: a titled card, the GD-13 state for a failed read, and the error line of a
// failed write (field errors, 412 "changed elsewhere", 429 waits, step-up refusals).
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { ApiProblem } from '@/lib/api/problem';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

export function Card({ title, text, children, id }: { title: ReactNode; text?: ReactNode; children?: ReactNode; id?: string }) {
  const auto = useId();
  const headingId = id ?? `${auto}-t`;
  return (
    <section className="pwa-settings-card" aria-labelledby={headingId}>
      <div className="pwa-stack-xs">
        <h3 id={headingId} className="pwa-onb-card-title">
          {title}
        </h3>
        {text ? <p className="pwa-text-caption m-0">{text}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Loading skeleton, or the failure state with Retry, for a section's main read. */
export function ReadState({ status, error, refetch }: { status: 'pending' | 'error' | 'success'; error: unknown; refetch: () => unknown }) {
  const t = useT();
  if (status === 'pending') return <SkeletonCard lines={4} />;
  if (status === 'error')
    return (
      <StateView
        kind={stateFromProblem(error)}
        t={t}
        compact
        action={
          <Button size="sm" onClick={() => void refetch()}>
            {t('common.actions.retry')}
          </Button>
        }
      />
    );
  return null;
}

/** The message key of a failed settings write. */
export function problemKey(err: unknown): MessageKey {
  if (!(err instanceof ApiProblem)) return 'settings.errors.failed';
  if (err.versionMismatch) return 'settings.errors.changedElsewhere';
  if (err.rateLimited) return 'settings.errors.tooMany';
  if (err.code === 'CODE_INVALID') return 'settings.errors.codeInvalid';
  if (err.code === 'INVALID_CREDENTIALS') return 'settings.errors.wrongPassword';
  if (err.code === 'DUPLICATE') return 'settings.errors.duplicate';
  if (err.code === 'CONSENT_REQUIRED') return 'settings.errors.consentRequired';
  if (err.code === 'NETWORK') return 'settings.errors.offline';
  // BA-13: breached or trivial password; a phone outside the region list.
  if (err.field('/new_password')?.code === 'pattern') return 'settings.errors.weakPassword';
  if (err.field('/phone')?.code === 'enum') return 'settings.errors.phoneRegion';
  if (err.code === 'VALIDATION_FAILED') return 'settings.errors.invalid';
  return 'settings.errors.failed';
}

export function ErrorLine({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return (
    <p className="pwa-error-text m-0" role="alert">
      {t(problemKey(error))}
    </p>
  );
}

/** A switch row: a native checkbox (role switch) with its label and the explanation under it. */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  end,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  end?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="pwa-check pwa-switch-row">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-h` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="pwa-check-body">
        <label htmlFor={id} className="pwa-check-label">
          {label}
        </label>
        {hint ? (
          <div id={`${id}-h`} className="pwa-text-caption">
            {hint}
          </div>
        ) : null}
      </div>
      {end ?? null}
    </div>
  );
}

/** Saves a text file in the browser (consent history CSV). */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
