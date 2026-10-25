// Urgency of mobile/preview/js/kit.js (proposed DS addition, DI-21): always colour + icon + word. safety-critical =
// danger edge + alert icon; urgent = signal fill; soon = neutral (signal-soft cards); not urgent = success outline.
import { Badge, type BadgeTone } from './badge';
import type { IconName } from './icon';

export type UrgencyLevel = 'critical' | 'urgent' | 'soon' | 'ok';

export const URGENCY_STYLE: Record<UrgencyLevel, { tone: BadgeTone; icon: IconName }> = {
  critical: { tone: 'danger', icon: 'alert' },
  urgent: { tone: 'signal', icon: 'alert' },
  soon: { tone: 'neutral', icon: 'clock' },
  ok: { tone: 'success', icon: 'check' },
};

export interface UrgencyProps {
  level: UrgencyLevel;
  /** The word in the UI language ("Safety-critical", "Urgent", "Soon", "Not urgent"). */
  label: string;
  className?: string;
}

export function Urgency({ level, label, className }: UrgencyProps) {
  const s = URGENCY_STYLE[level];
  return (
    <Badge tone={s.tone} icon={s.icon} className={className}>
      {label}
    </Badge>
  );
}
