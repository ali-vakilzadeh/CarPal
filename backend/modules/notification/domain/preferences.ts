// Notification preferences and channel rules (52 NotificationPreference,
// 40 §20): defaults per channel and category, the merge of stored rows over
// the defaults, and which channels a notification goes to. Critical
// notifications are always delivered in-app and are never suppressed by an
// opt-out; marketing needs the marketing consent (checked by the caller).
import { ENUMS } from '#libs/contract/generated/enums.js';

export type Channel = (typeof ENUMS)['NotificationChannel'][number];
export type Category = (typeof ENUMS)['NotificationCategory'][number];
export type Frequency = 'immediate' | 'daily_digest' | 'weekly_digest';

export interface Preference {
  channel: Channel;
  category: Category;
  enabled: boolean;
  frequency: Frequency;
}

export const CHANNELS = ENUMS.NotificationChannel as readonly Channel[];
export const CATEGORIES = ENUMS.NotificationCategory as readonly Category[];

/** Defaults (proposed, WP14): in-app everything but marketing; email and push for operational categories; SMS off. */
export function defaultPreference(channel: Channel, category: Category): Preference {
  const operational = category !== 'marketing' && category !== 'community' && category !== 'ai_suggestions';
  const enabled = channel === 'in_app' ? category !== 'marketing' : channel === 'email' || channel === 'push' ? operational : false;
  return { channel, category, enabled, frequency: 'immediate' };
}

/** Every channel × category, stored rows over the defaults (40 notification_prefs.get: ≤ 60 items). */
export function mergedPreferences(stored: readonly Preference[]): Preference[] {
  const out: Preference[] = [];
  for (const channel of CHANNELS)
    for (const category of CATEGORIES)
      out.push(stored.find((p) => p.channel === channel && p.category === category) ?? defaultPreference(channel, category));
  return out;
}

export interface ChannelDecision {
  channel: Channel;
  /** Send now, or keep for a digest (email only), or suppress by preference. */
  outcome: 'send' | 'digest' | 'suppressed';
}

/**
 * Channels of one notification for one recipient (in_app is the notification
 * row itself and always exists): critical → email and push regardless of
 * preferences; otherwise the merged preference, and critical_alerts_only
 * keeps everything but in-app quiet. Digests apply to email only.
 */
export function channelsFor(o: {
  category: Category;
  priority: 'normal' | 'critical';
  preferences: readonly Preference[];
  criticalAlertsOnly: boolean;
  allowed: readonly Channel[];
}): ChannelDecision[] {
  const out: ChannelDecision[] = [];
  for (const channel of o.allowed) {
    if (channel === 'in_app') continue;
    if (o.priority === 'critical') {
      if (channel !== 'sms') out.push({ channel, outcome: 'send' });
      continue;
    }
    const p = o.preferences.find((x) => x.channel === channel && x.category === o.category) ?? defaultPreference(channel, o.category);
    if (!p.enabled || o.criticalAlertsOnly) out.push({ channel, outcome: 'suppressed' });
    else if (channel === 'email' && p.frequency !== 'immediate') out.push({ channel, outcome: 'digest' });
    else out.push({ channel, outcome: 'send' });
  }
  return out;
}
