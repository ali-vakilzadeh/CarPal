// Job status bar (PRV-GD-08; Workshop PW-JOB-01, Web UI P-REQ-02 status actions): where a booked visit stands —
// Booked, Car arrived, In progress, Ready for pickup, Completed — with a side mark (e.g. "Awaiting parts") on the
// current step, and the status buttons the caller derived from Appointment.allowed_transitions (the server decides,
// PRV-GD-03). Words, the current step and the actions come from the caller; the buttons use design-system classes.
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface JobStep {
  key: string;
  label: string;
}

export interface JobAction {
  key: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}

export interface JobStatusBarProps {
  /** Accessible name of the step list, e.g. "Job progress". */
  label: string;
  steps: readonly JobStep[];
  /** Index of the current step; -1 when the job left the steps (cancelled, no-show). */
  current: number;
  /** A mark on the current step, e.g. "Awaiting parts". */
  mark?: string;
  /** Accessible name of the action group, e.g. "Update job". */
  actionsLabel: string;
  actions: readonly JobAction[];
  /** Shown under the steps (e.g. the parts note and the estimated completion). */
  children?: ReactNode;
  className?: string;
}

export function JobStatusBar({ label, steps, current, mark, actionsLabel, actions, children, className }: JobStatusBarProps) {
  return (
    <section className={cx('bui-job', className)} aria-label={label}>
      <ol className="bui-job-steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={cx('bui-job-step', i < current && 'is-done', i === current && 'is-current')}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="bui-job-dot" aria-hidden="true" />
            <span className="bui-job-step-label">{s.label}</span>
            {i === current && mark ? <span className="bui-job-mark">{mark}</span> : null}
          </li>
        ))}
      </ol>
      {children}
      {actions.length ? (
        <div className="bui-job-actions" role="group" aria-label={actionsLabel}>
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              className={cx('cp-btn', `cp-btn-${a.variant ?? 'secondary'}`, 'cp-btn-md', a.busy && 'is-loading')}
              onClick={a.onClick}
              disabled={a.disabled || a.busy}
              aria-busy={a.busy || undefined}
              data-action={a.key}
            >
              <span className="cp-btn-label">{a.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
