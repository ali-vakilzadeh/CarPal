// Meter and step bar of mobile/preview/js/kit.js (proposed DS additions, DI-21). Widths are classes in 5 % steps,
// not inline styles: the CSP has no 'unsafe-inline' for styles (GD-15).
import { cx } from './cx';

/** Rounds a percentage to the 5 % step classes of additions.css (pwa-w-0 … pwa-w-100). */
export function widthClass(percent: number): string {
  const step = Math.min(100, Math.max(0, Math.round(percent / 5) * 5));
  return `pwa-w-${step}`;
}

export interface MeterProps {
  value: number;
  /** Accessible name, e.g. "Password strength". */
  label: string;
  /** Spoken value, e.g. "Strength: good". */
  valueText?: string;
  tone?: 'accent' | 'signal' | 'danger';
  className?: string;
}

export function Meter({ value, label, valueText, tone = 'accent', className }: MeterProps) {
  return (
    <div
      className={cx('pwa-meter', tone !== 'accent' && `is-${tone}`, className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
    >
      <span className={widthClass(value)} />
    </div>
  );
}

export interface StepBarProps {
  /** 1-based current step. */
  step: number;
  total: number;
  /** Spoken text, e.g. "Step 2 of 5". */
  label: string;
}

/** Segments: done (accent), now (signal) and to do; announced as a progress bar. */
export function StepBar({ step, total, label }: StepBarProps) {
  return (
    <div
      className="pwa-steps"
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={step}
      aria-valuetext={label}
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i + 1 < step ? 'is-done' : i + 1 === step ? 'is-now' : undefined} />
      ))}
    </div>
  );
}
