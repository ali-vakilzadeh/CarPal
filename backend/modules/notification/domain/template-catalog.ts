// Template catalog of the admin plane (A-NOTIF-01, backend S17, owner decision DQ-05): which code templates staff
// may override per channel and language, the placeholders each one may use, the translation flags, and rendering
// with an override over the code text (templates.ts stays the fallback). Pure.
//
//   kind transactional  links, codes, invitations and account security mails sent at once through the Messenger
//                       (also on the auth host, which cannot read overrides): listed, never edited.
//   always_delivered    critical alerts (no user opt-out): listed, never edited.
//   channels            the channels the router can use for the template (in-app texts are the clients' dictionary,
//                       so templates that only reach the app are not listed).
import { render, TEMPLATES, type Rendered } from './templates.js';

export type TemplateChannel = 'email' | 'push' | 'sms';
export type TemplateLocale = 'en' | 'fa';
export const TEMPLATE_CHANNELS: readonly TemplateChannel[] = ['email', 'push', 'sms'];
export const TEMPLATE_LOCALES: readonly TemplateLocale[] = ['en', 'fa'];

/** Sent through the Messenger: secrets or account security, at once, bypassing preferences. */
const TRANSACTIONAL_CHANNELS: Record<string, TemplateChannel[]> = {
  'identity.email_verification': ['email'],
  'identity.account_exists': ['email'],
  'identity.password_reset': ['email'],
  'identity.email_change_notice': ['email'],
  'identity.otp_code': ['email', 'sms'],
  'identity.password_changed': ['email'],
  'identity.security_alert': ['email'],
  'identity.staff_passkey_added': ['email'],
  'identity.staff_passkey_removed': ['email'],
  'identity.staff_recovery_codes_created': ['email'],
  'identity.staff_break_glass_account': ['email'],
  'identity.staff_break_glass_admins': ['email'],
  'identity.staff_recovery_code': ['email'],
  'identity.staff_recovery_requested_admins': ['email'],
  'identity.staff_recovery_approved': ['email'],
  'identity.staff_recovery_rejected': ['email'],
  'identity.staff_recovery_completed_account': ['email'],
  'identity.staff_recovery_completed_admins': ['email'],
  'identity.consent_request': ['email'],
  'organization.member_invitation': ['email'],
  'appointment.check_in_link': ['email'],
  'review.invitation': ['email'],
  'review.invitation_code': ['email'],
};

const EMAIL_PUSH_SMS: TemplateChannel[] = ['email', 'push', 'sms'];
const EMAIL_PUSH: TemplateChannel[] = ['email', 'push'];

/**
 * Channels of the routed templates (domain/routing.ts intents; SMS only for the SMS categories appointments,
 * service_reminders and fleet). Templates that only reach the app have none.
 */
const NOTIFICATION_CHANNELS: Record<string, TemplateChannel[]> = {
  'system.welcome': [],
  'system.security_alert': ['push'],
  'appointment.request_received': EMAIL_PUSH_SMS,
  'appointment.confirmed': ['push'],
  'appointment.alternative_proposed': EMAIL_PUSH_SMS,
  'appointment.cancelled': EMAIL_PUSH_SMS,
  'appointment.status_updated': EMAIL_PUSH_SMS,
  'appointment.completed': EMAIL_PUSH_SMS,
  'appointment.reminder': EMAIL_PUSH_SMS,
  'appointment.customer_message': EMAIL_PUSH_SMS,
  'appointment.delay': EMAIL_PUSH_SMS,
  'review.invitation_in_app': ['push'],
  'review.approval_needed': EMAIL_PUSH,
  'review.received': EMAIL_PUSH,
  'review.status_updated': ['push'],
  'review.response_published': ['push'],
  'inquiry.answered': EMAIL_PUSH,
  'inquiry.received': EMAIL_PUSH,
  'inventory.import_finished': EMAIL_PUSH,
  'vehicle.reminder_due': EMAIL_PUSH_SMS,
  'fleet.vehicle_due': EMAIL_PUSH_SMS,
  'fleet.approval_needed': EMAIL_PUSH_SMS,
  'fleet.approval_decided': EMAIL_PUSH,
  'fleet.vehicle_data_shared': ['email'],
  'vehicle.transfer_requested': EMAIL_PUSH,
  'vehicle.transfer_decided': EMAIL_PUSH,
  'ai.suggestion_ready': [],
  'moderation.action_taken': ['email'],
  'organization.verified': ['email'],
  'organization.location_corrected': ['email'],
  'admin.dsr_deadline': ['email'],
  'community.followed_update': EMAIL_PUSH,
  'media.upload_refused': EMAIL_PUSH,
  'notification.digest': ['email'],
  'staff.four_eyes_outcome': [],
  'staff.kill_switch_changed': [],
  'staff.recovery_waiting': [],
  'staff.recovery_done': [],
  'staff.break_glass_notice': [],
};

/** Critical alerts (routing priority critical): marked "Always delivered" and locked. */
export const ALWAYS_DELIVERED: ReadonlySet<string> = new Set([
  'system.security_alert',
  'admin.dsr_deadline',
  'staff.kill_switch_changed',
  'staff.recovery_waiting',
  'staff.recovery_done',
  'staff.break_glass_notice',
]);

/** Params the router puts on a notification that the built-in text does not show. */
const EXTRA_VARIABLES: Record<string, string[]> = {
  'system.security_alert': ['kind'],
  'review.invitation_in_app': [],
};

export interface CatalogTemplate {
  key: string;
  kind: 'notification' | 'transactional';
  channels: TemplateChannel[];
  alwaysDelivered: boolean;
  editable: boolean;
  variables: string[];
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** The {name} placeholders of a text, in order of first use. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

function variablesOf(key: string): string[] {
  const t = TEMPLATES[key]!;
  const texts = [t.en, t.fa].flatMap((x) => [x.subject, x.text, x.push ?? '']);
  return [...new Set([...texts.flatMap(placeholders), ...(EXTRA_VARIABLES[key] ?? [])])].sort().slice(0, 20);
}

/** Every code template with its kind, channels, lock and variables (sorted by key). */
export function catalog(): CatalogTemplate[] {
  return Object.keys(TEMPLATES)
    .sort()
    .map((key) => {
      const transactional = key in TRANSACTIONAL_CHANNELS;
      const alwaysDelivered = ALWAYS_DELIVERED.has(key);
      return {
        key,
        kind: transactional ? 'transactional' : 'notification',
        channels: transactional ? TRANSACTIONAL_CHANNELS[key]! : (NOTIFICATION_CHANNELS[key] ?? EMAIL_PUSH),
        alwaysDelivered,
        editable: !transactional && !alwaysDelivered,
        variables: variablesOf(key),
      } satisfies CatalogTemplate;
    });
}

export function catalogEntry(key: string): CatalogTemplate | undefined {
  return key in TEMPLATES ? catalog().find((t) => t.key === key) : undefined;
}

/** Placeholders of `texts` that the template does not offer. */
export function unknownPlaceholders(entry: CatalogTemplate, ...texts: (string | null | undefined)[]): string[] {
  return [...new Set(texts.flatMap((t) => (t ? placeholders(t) : [])))].filter((p) => !entry.variables.includes(p));
}

/** The built-in text of a template for one channel: email subject and text, push title and body, SMS text. */
export function codeText(key: string, channel: TemplateChannel, locale: TemplateLocale): { subject: string | null; body: string } {
  const t = TEMPLATES[key]![locale];
  if (channel === 'sms') return { subject: null, body: t.text };
  if (channel === 'push') return { subject: t.subject, body: t.push ?? t.text.split('\n')[0]! };
  return { subject: t.subject, body: t.text };
}

export interface OverrideText {
  template_key: string;
  channel: string;
  locale: string;
  subject: string | null;
  body: string;
}

/** Overrides by "key|channel|locale". */
export type OverrideMap = ReadonlyMap<string, OverrideText>;
export const overrideKey = (key: string, channel: string, locale: string): string => `${key}|${channel}|${locale}`;

export function overrideMap(rows: readonly OverrideText[]): OverrideMap {
  return new Map(rows.map((r) => [overrideKey(r.template_key, r.channel, r.locale), r]));
}

/** Translation flags of one language of a template channel (52 NotificationTemplateOverride rules). */
export function translationFlags(
  key: string,
  channel: TemplateChannel,
  locale: TemplateLocale,
  overrides: OverrideMap,
): { missing: boolean; outdated: boolean } {
  const other: TemplateLocale = locale === 'en' ? 'fa' : 'en';
  const text = (l: TemplateLocale) => overrides.get(overrideKey(key, channel, l)) ?? codeText(key, channel, l);
  const mine = text(locale);
  const theirs = text(other);
  const missing = !mine.body.trim() || (mine.body === theirs.body && (mine.subject ?? '') === (theirs.subject ?? ''));
  const outdated = !overrides.has(overrideKey(key, channel, locale)) && overrides.has(overrideKey(key, channel, other));
  return { missing, outdated };
}

const fill = (s: string, params: Record<string, unknown>): string =>
  s.replace(PLACEHOLDER, (_, k: string) => {
    const v = params[k];
    return v === undefined || v === null ? '' : String(v);
  });

/**
 * Renders a template for a channel with the staff override of that channel and language when there is one, else the
 * code text (render() of templates.ts). Email uses subject and text, push title and body, SMS the text.
 */
export function renderWith(
  key: string,
  locale: string,
  channel: TemplateChannel,
  params: Record<string, unknown>,
  overrides: OverrideMap,
): Rendered {
  const base = render(key, locale, params);
  const o = overrides.get(overrideKey(key, channel, locale === 'fa' ? 'fa' : 'en'));
  if (!o) return base;
  const body = fill(o.body, params);
  if (channel === 'sms') return { ...base, text: body };
  if (channel === 'push') {
    const title = o.subject ? fill(o.subject, params) : base.title;
    return { ...base, title, body: body.split('\n')[0]!.slice(0, 180) };
  }
  return { ...base, subject: o.subject ? fill(o.subject, params) : base.subject, text: body };
}

/** Sample values for a preview: a readable stand-in for every variable not given. */
export function sampleParams(variables: readonly string[], given: Record<string, unknown> = {}): Record<string, unknown> {
  const samples: Record<string, string> = {
    organization_name: 'Sample Garage',
    staff_name: 'Sam Example',
    link: 'https://carpals.ir/l#sample',
    code: '123456',
  };
  return Object.fromEntries(variables.map((v) => [v, given[v] ?? samples[v] ?? `[${v}]`]));
}
