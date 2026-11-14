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
/** SMS costs money per message and stays for what cannot wait (40 notification_prefs.put). */
export const SMS_CATEGORIES: readonly Category[] = ['appointments', 'service_reminders', 'fleet'];

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
    if (!p.enabled || o.criticalAlertsOnly || (channel === 'sms' && !SMS_CATEGORIES.includes(o.category)))
      out.push({ channel, outcome: 'suppressed' });
    else if (channel === 'email' && p.frequency !== 'immediate') out.push({ channel, outcome: 'digest' });
    else out.push({ channel, outcome: 'send' });
  }
  return out;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Hour (0-23) and ISO weekday (1 Monday … 7 Sunday) on the recipient's clock. */
export function localClock(now: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value) % 24,
    weekday: WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'] ?? 1,
  };
}

/**
 * Whether a recipient's email digest goes out now (52 NotificationRules, backend S17): daily ones at the digest hour
 * on the recipient's clock, weekly ones at that hour on the weekly day; never later than a day (daily) or a week
 * (weekly) after the oldest message, so a missed run does not hold a digest for another cycle.
 */
export function digestDue(o: {
  now: Date;
  timeZone: string;
  oldest: Date;
  weekly: boolean;
  digestHour: number;
  weeklyDigestDay: number;
}): boolean {
  const age = o.now.getTime() - o.oldest.getTime();
  if (age >= (o.weekly ? 7 : 1) * 86_400_000) return true;
  if (age < 0) return false;
  const c = localClock(o.now, o.timeZone);
  return c.hour === o.digestHour && (!o.weekly || c.weekday === o.weeklyDigestDay);
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * When a delivery held by quiet hours may go out: the end of the window on the user's clock, or null outside it. The
 * window may cross midnight (22:00-07:00).
 */
export function quietUntil(now: Date, timeZone: string, quiet: { start: string; end: string } | null): Date | null {
  if (!quiet) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string): number => Number(parts.find((x) => x.type === type)?.value);
  const current = part('hour') * 60 + part('minute');
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  return inside ? new Date(now.getTime() + ((end - current + 1440) % 1440) * 60_000) : null;
}
