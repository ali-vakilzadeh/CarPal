// Status and urgency words of appointments (Docs/21 C-APP-01/02): colour + icon + word, never colour alone.
import type { Appointment, UrgencyLevel } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import type { UrgencyLevel as UiLevel } from '@/components/ds/urgency';
import type { Translate } from '@/lib/i18n/keys';
import { STATUS_STYLE } from './model';

/** The design-system urgency of a contract level. */
export function uiLevelOf(level: UrgencyLevel): UiLevel {
  return level === 'safety_critical' ? 'critical' : level === 'high' ? 'urgent' : level === 'medium' ? 'soon' : 'ok';
}

/** "Declined by the shop" for a provider cancellation with reason "declined" (40 AppointmentTransition). */
export function statusLabel(a: Pick<Appointment, 'status' | 'cancelled_by' | 'cancellation_reason'>, t: Translate): string {
  if (a.status === 'cancelled' && a.cancelled_by === 'provider' && a.cancellation_reason?.trim().toLowerCase() === 'declined')
    return t('appointments.status.declined');
  if (a.status === 'cancelled' && a.cancelled_by) return t(`appointments.status.cancelledBy.${a.cancelled_by}`);
  return t(`appointments.status.${a.status}`);
}

export function AppointmentStatusBadge({
  a,
  t,
}: {
  a: Pick<Appointment, 'status' | 'cancelled_by' | 'cancellation_reason'>;
  t: Translate;
}) {
  const s = STATUS_STYLE[a.status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {statusLabel(a, t)}
    </Badge>
  );
}
