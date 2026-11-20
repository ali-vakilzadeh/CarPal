// Notification templates and rules (AC14.T3): the pure rules of the screen, kept apart for unit tests. Limits are the
// contract's (Docs/40 NotificationTemplateWrite, NotificationRulesWrite) and the backend's extra checks
// (modules/notification/application/admin-ops.ts rulesErrors: reminder days strictly ascending, quiet hours HH:MM
// with start <> end).
import type { NotificationRules, NotificationTemplate, NotificationTemplateChannel } from '@carpal/api-contracts';
import { toLatinDigits } from '@/lib/format';

export const CHANNELS: readonly NotificationTemplateChannel[] = ['email', 'push', 'sms'];
export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;

/** Email subject or push title: required for email and push, forbidden for SMS. */
export const hasSubject = (channel: string) => channel === 'email' || channel === 'push';

/** The {name} placeholders of a text. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]!))];
}

export type TemplateProblem = 'subject' | 'body' | 'unknown';

/** The template write (without the reason) or what is wrong with it; unknown lists placeholders the template lacks. */
export function templateWriteOf(
  tpl: Pick<NotificationTemplate, 'channel' | 'locale' | 'variables'>,
  subject: string,
  body: string,
):
  | { value: { channel: NotificationTemplateChannel; locale: 'en' | 'fa'; subject?: string; body: string } }
  | { problems: TemplateProblem[]; unknown: string[] } {
  const problems: TemplateProblem[] = [];
  const s = subject.trim();
  if (hasSubject(tpl.channel) && (!s || s.length > SUBJECT_MAX || /[\r\n]/.test(s))) problems.push('subject');
  if (!body.trim() || body.length > BODY_MAX) problems.push('body');
  const allowed = new Set(tpl.variables);
  const unknown = placeholdersOf(`${hasSubject(tpl.channel) ? s : ''} ${body}`).filter((p) => !allowed.has(p));
  if (unknown.length) problems.push('unknown');
  if (problems.length) return { problems, unknown };
  return { value: { channel: tpl.channel, locale: tpl.locale, ...(hasSubject(tpl.channel) ? { subject: s } : {}), body } };
}

/** The identity of a template row (one key has a row per channel and language). */
export const templateId = (t: Pick<NotificationTemplate, 'template_key' | 'channel' | 'locale'>) =>
  `${t.template_key}|${t.channel}|${t.locale}`;

export interface RulesDraft {
  delay: string;
  invitationDays: string;
  approvalDays: string;
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
  digestHour: string;
  weeklyDay: string;
  maintenanceDays: string;
  mileageKm: string;
}

export type RulesProblem =
  'delay' | 'invitationDays' | 'approvalDays' | 'quietStart' | 'quietEnd' | 'digestHour' | 'maintenanceDays' | 'mileageKm';

export function rulesDraftOf(r: NotificationRules): RulesDraft {
  return {
    delay: String(r.review_invitation_delay_minutes),
    invitationDays: r.review_invitation_reminder_days.join(', '),
    approvalDays: r.review_approval_reminder_days.join(', '),
    quiet: r.default_quiet_hours !== null,
    quietStart: r.default_quiet_hours?.start ?? '22:00',
    quietEnd: r.default_quiet_hours?.end ?? '07:00',
    digestHour: String(r.digest_hour),
    weeklyDay: String(r.weekly_digest_day),
    maintenanceDays: String(r.maintenance_due_window_days),
    mileageKm: String(r.mileage_due_window_km),
  };
}

const int = (s: string, min: number, max: number): number | null => {
  const v = toLatinDigits(s).trim();
  if (!/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

/** "1, 3" → [1, 3]: up to three days from 1 to 6, strictly ascending; '' → []. */
export function parseReminderDays(s: string): number[] | null {
  const v = toLatinDigits(s).replace(/[،]/g, ',').trim();
  if (!v) return [];
  const parts = v.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 3) return null;
  const days: number[] = [];
  for (const p of parts) {
    const n = int(p, 1, 6);
    if (n === null || (days.length && n <= days[days.length - 1]!)) return null;
    days.push(n);
  }
  return days;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The full rules write (without the reason) or the fields that are wrong. The write replaces every rule, so the odometer
 * prompt (backend S26b, edited in AC14b.T4) is sent back as stored (D-100).
 */
export function rulesWriteOf(
  stored: NotificationRules,
  d: RulesDraft,
):
  | {
      value: {
        review_invitation_delay_minutes: number;
        review_invitation_reminder_days: number[];
        default_quiet_hours: { start: string; end: string } | null;
        digest_hour: number;
        weekly_digest_day: number;
        review_approval_reminder_days: number[];
        maintenance_due_window_days: number;
        mileage_due_window_km: number;
        odometer_prompt_days: number;
      };
    }
  | { problems: RulesProblem[] } {
  const problems: RulesProblem[] = [];
  const delay = int(d.delay, 0, 2880);
  if (delay === null) problems.push('delay');
  const inv = parseReminderDays(d.invitationDays);
  if (inv === null) problems.push('invitationDays');
  const appr = parseReminderDays(d.approvalDays);
  if (appr === null) problems.push('approvalDays');
  const start = toLatinDigits(d.quietStart).trim();
  const end = toLatinDigits(d.quietEnd).trim();
  if (d.quiet) {
    if (!HH_MM.test(start)) problems.push('quietStart');
    if (!HH_MM.test(end) || end === start) problems.push('quietEnd');
  }
  const digest = int(d.digestHour, 0, 23);
  if (digest === null) problems.push('digestHour');
  const weekly = int(d.weeklyDay, 1, 7) ?? stored.weekly_digest_day;
  const maint = int(d.maintenanceDays, 1, 90);
  if (maint === null) problems.push('maintenanceDays');
  const km = int(d.mileageKm, 50, 5000);
  if (km === null) problems.push('mileageKm');
  if (problems.length) return { problems };
  return {
    value: {
      review_invitation_delay_minutes: delay!,
      review_invitation_reminder_days: inv!,
      default_quiet_hours: d.quiet ? { start, end } : null,
      digest_hour: digest!,
      weekly_digest_day: weekly,
      review_approval_reminder_days: appr!,
      maintenance_due_window_days: maint!,
      mileage_due_window_km: km!,
      odometer_prompt_days: stored.odometer_prompt_days,
    },
  };
}

/** "0.0423" → 4.2 (percent, one decimal); null stays null. */
export function ratePercent(rate: string | null): number | null {
  if (rate === null) return null;
  const n = Number(rate);
  return Number.isFinite(n) ? Math.round(n * 1000) / 10 : null;
}
