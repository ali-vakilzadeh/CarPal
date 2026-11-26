// Request card (PRV-GD-08; Workshop PW-REQ-01, Web UI P-REQ-01): one appointment request in a list — vehicle, what it
// is about, urgency, the time that matters for its status, its age, and the red safety mark (Docs/11 Ch.5: safety-
// critical requests are marked and listed first; the caller sorts). Words, times and the address come formatted from
// the caller; the card links to the request with the app's own link component.
import type { ReactNode } from 'react';
import type { LinkLike } from './counter-tile';
import { cx } from './cx';
import { StatusChip, type StatusTone } from './status-chip';

export interface RequestCardProps {
  href: string;
  linkAs?: LinkLike | 'a';
  /** Vehicle, e.g. "BMW 320i (E90) 2012". */
  vehicle: string;
  /** What the request is about: the service, the symptom or the start of the description. */
  subject: string;
  /** Who asked (display name of the customer or the fleet). */
  requester?: string;
  status: { label: string; tone: StatusTone };
  urgency?: { label: string; tone: StatusTone };
  /** "Safety-critical": shown as a red line and a red edge. */
  safety?: string;
  /** The time line, e.g. "Preferred: Thu 09:00–12:00" or "Proposed: Thu 14:00". */
  when?: string;
  /** Request age, e.g. "2 hours ago". */
  age?: string;
  /** Extra marks after the status (e.g. "My job"). */
  extra?: ReactNode;
  /** Language of the customer's text (subject), for screen readers and fonts. */
  lang?: string;
  className?: string;
}

export function RequestCard({
  href,
  linkAs = 'a',
  vehicle,
  subject,
  requester,
  status,
  urgency,
  safety,
  when,
  age,
  extra,
  lang,
  className,
}: RequestCardProps) {
  const Link = linkAs;
  return (
    <Link href={href} className={cx('bui-request', safety && 'is-safety', className)}>
      {safety ? (
        <span className="bui-request-safety" role="note">
          {safety}
        </span>
      ) : null}
      <span className="bui-request-head">
        <span className="bui-request-vehicle">
          <bdi>{vehicle}</bdi>
        </span>
        {age ? <span className="bui-request-age">{age}</span> : null}
      </span>
      <span className="bui-request-subject" dir="auto" lang={lang}>
        {subject}
      </span>
      {requester || when ? (
        <span className="bui-request-meta">
          {requester ? <bdi>{requester}</bdi> : null}
          {requester && when ? ' · ' : null}
          {when}
        </span>
      ) : null}
      <span className="bui-request-chips">
        <StatusChip label={status.label} tone={status.tone} />
        {urgency ? <StatusChip label={urgency.label} tone={urgency.tone} /> : null}
        {extra}
      </span>
    </Link>
  );
}

/** Tone of an urgency level (Docs/40 UrgencyLevel): safety-critical is danger, high is signal. */
export function urgencyTone(level: string): StatusTone {
  switch (level) {
    case 'safety_critical':
      return 'danger';
    case 'high':
      return 'signal';
    case 'medium':
      return 'accent';
    default:
      return 'neutral';
  }
}
