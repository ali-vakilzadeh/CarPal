// Notification rules (52 NotificationRules, A-NOTIF-01 Rules, backend S17): one row the platform's staff edit on the
// admin plane. The notification dispatcher reads the default quiet hours and the digest schedule; the trust module's
// review invitation flow reads the invitation delay and the reminder days. System context (workers).
import type { TxScope } from '#libs/tenancy/index.js';

export interface NotificationRulesValues {
  /** Minutes after an appointment's completion before its review invitation is sent (0: at once). */
  invitationDelayMinutes: number;
  /** Days after sending at which reminders go out (0-3, strictly ascending, each 1-6; the link lives 7 days). */
  reminderDays: number[];
  /** Quiet hours for accounts without their own ('HH:MM', recipient's clock), or none. */
  defaultQuietHours: { start: string; end: string } | null;
  /** Hour (0-23, recipient's clock) of daily digests and weekly ones. */
  digestHour: number;
  /** ISO weekday (1 Monday … 7 Sunday) of weekly digests. */
  weeklyDigestDay: number;
}

/** The behaviour before S17 (and the seed): no delay, reminders on days 2 and 5, no platform quiet hours. */
export const DEFAULT_NOTIFICATION_RULES: NotificationRulesValues = {
  invitationDelayMinutes: 0,
  reminderDays: [2, 5],
  defaultQuietHours: null,
  digestHour: 9,
  weeklyDigestDay: 6,
};

export abstract class NotificationRulesRead {
  /** The rules in force (the defaults when the row is missing). */
  abstract get(scope: TxScope): Promise<NotificationRulesValues>;
}
