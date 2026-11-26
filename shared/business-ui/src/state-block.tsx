// Empty and error states of a business list or panel (PRV-GD-08). The words come from the caller; `action` is one
// clear next step (a Retry button, a link). Errors are announced politely; nothing here decides what went wrong.
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface StateBlockProps {
  kind: 'empty' | 'error';
  title: string;
  text?: string;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}

export function StateBlock({ kind, title, text, action, headingLevel = 3, className }: StateBlockProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      className={cx('bui-state', `is-${kind}`, className)}
      data-state={kind}
      role={kind === 'error' ? 'status' : undefined}
      aria-live={kind === 'error' ? 'polite' : undefined}
    >
      <Heading className="bui-state-title">{title}</Heading>
      {text ? <p className="bui-state-text">{text}</p> : null}
      {action ? <div className="bui-state-action">{action}</div> : null}
    </section>
  );
}
