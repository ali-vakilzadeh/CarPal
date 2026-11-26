// Status chip (PRV-GD-08): a short status word in a design-system badge. The caller passes the words (its own
// dictionary) and picks the tone; appointmentTone() and showcaseTone() give the tones the Workshop PWA and the Web UI
// share, so a status looks the same on the phone and on the desk.
import { cx } from './cx';

export type StatusTone = 'neutral' | 'signal' | 'accent' | 'success' | 'danger';

export interface StatusChipProps {
  label: string;
  tone?: StatusTone;
  className?: string;
}

export function StatusChip({ label, tone = 'neutral', className }: StatusChipProps) {
  return <span className={cx('cp-badge', `cp-badge-${tone}`, 'bui-status', className)}>{label}</span>;
}

/** Tone of an appointment status (Docs/40 AppointmentStatus): waiting on the shop → signal, going well → success. */
export function appointmentTone(status: string): StatusTone {
  switch (status) {
    case 'requested':
    case 'provider_reviewing':
      return 'signal';
    case 'alternative_proposed':
    case 'awaiting_parts':
      return 'accent';
    case 'confirmed':
    case 'checked_in':
    case 'in_progress':
    case 'ready_for_pickup':
    case 'completed':
      return 'success';
    case 'cancelled':
    case 'no_show':
      return 'danger';
    default:
      return 'neutral';
  }
}

export type ShowcaseState = 'draft' | 'waiting_for_customer' | 'being_reviewed' | 'live' | 'declined';

/** Tone of a showcase as the Workshop shows it (PW-PHO-01): Draft, Waiting for customer, Being reviewed, Live, Declined. */
export function showcaseTone(state: ShowcaseState): StatusTone {
  switch (state) {
    case 'live':
      return 'success';
    case 'waiting_for_customer':
      return 'signal';
    case 'being_reviewed':
      return 'accent';
    case 'declined':
      return 'danger';
    default:
      return 'neutral';
  }
}
