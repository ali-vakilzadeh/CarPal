// In-app notification texts (P9.T1, BA-18): the API sends template_key + plain template_params and the client renders
// the words from its dictionary (Docs/40 §20.1). Every template key of the backend (modules/notification/domain/
// templates.ts) is classified here — consumer in-app, business (portal contexts only, never listed by the consumer
// PWA: notifications.list without organization_id returns personal notifications) or email/SMS only (secret-bearing
// messages never become notifications) — and a drift test fails when the backend adds a key this file does not know.
// Enumerated params (statuses, types) are words of the dictionary too; unknown keys fall back to a generic line.
import type { Notification } from '@carpal/api-contracts';
import type { Formatter } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

/** Personal notifications the consumer PWA lists and renders (dictionary: notifications.templates.<key>.title|text). */
export const CONSUMER_TEMPLATE_KEYS = [
  'system.welcome',
  'system.security_alert',
  'appointment.confirmed',
  'appointment.alternative_proposed',
  'appointment.cancelled',
  'appointment.status_updated',
  'appointment.completed',
  'appointment.reminder',
  'appointment.customer_message',
  'review.invitation_in_app',
  'review.status_updated',
  'review.response_published',
  'inquiry.answered',
  'vehicle.reminder_due',
  'vehicle.transfer_requested',
  'vehicle.transfer_decided',
  'community.followed_update',
  'media.upload_refused',
  'moderation.action_taken',
  'ai.suggestion_ready',
] as const;

/** Notifications with an organization context: shown in the business portals, not here (DI-16). */
export const BUSINESS_TEMPLATE_KEYS = [
  'appointment.request_received',
  'appointment.delay',
  'review.approval_needed',
  'review.received',
  'inquiry.received',
  'inventory.import_finished',
  'fleet.vehicle_due',
  'fleet.approval_needed',
  'fleet.approval_decided',
  'fleet.vehicle_data_shared',
  'organization.verified',
  'organization.location_corrected',
  'admin.dsr_deadline',
] as const;

/** Sent by email or SMS only (links, codes, invitations, digests): never an in-app notification (BA-18). */
export const MESSAGE_ONLY_TEMPLATE_KEYS = [
  'identity.email_verification',
  'identity.account_exists',
  'identity.password_reset',
  'identity.email_change_notice',
  'identity.otp_code',
  'identity.password_changed',
  'identity.security_alert',
  'identity.consent_request',
  'organization.member_invitation',
  'appointment.check_in_link',
  'review.invitation',
  'review.invitation_code',
  'notification.digest',
] as const;

export type ConsumerTemplateKey = (typeof CONSUMER_TEMPLATE_KEYS)[number];

const CONSUMER = new Set<string>(CONSUMER_TEMPLATE_KEYS);

export function isConsumerTemplate(key: string): key is ConsumerTemplateKey {
  return CONSUMER.has(key);
}

/**
 * Params whose values are enumerations with words in the dictionary (notifications.values.<param>.<value>). The
 * backend fills them from contract enums (AppointmentStatus, MaintenanceReminder, ModerationActionType …).
 */
export const VALUE_PARAMS = {
  new_status: [
    'provider_reviewing',
    'alternative_proposed',
    'confirmed',
    'checked_in',
    'in_progress',
    'awaiting_parts',
    'ready_for_pickup',
    'completed',
    'cancelled',
    'no_show',
    'answered',
    'reserved',
    'unavailable',
  ],
  changed_by_side: ['requester', 'provider', 'system'],
  reminder_type: ['oil', 'brakes', 'tires', 'battery', 'inspection', 'seasonal', 'document_expiry', 'custom', 'maintenance', 'mileage'],
  status: ['upcoming', 'due', 'overdue', 'accepted', 'rejected', 'cancelled', 'expired'],
  post_type: [
    'showcase',
    'availability',
    'seasonal_advice',
    'special_offer',
    'educational_tip',
    'job_completion',
    'community_event',
    'update',
  ],
  action_type: ['approve', 'hide', 'remove', 'restore', 'request_changes', 'warn_user', 'suspend_account', 'reactivate_account'],
  target_type: ['review', 'review_response', 'post', 'comment', 'question', 'answer', 'portfolio_item', 'media_asset', 'user', 'content'],
  purpose: [
    'avatar',
    'vehicle_photo',
    'vehicle_document',
    'issue_photo',
    'service_evidence',
    'review_photo',
    'review_evidence',
    'post',
    'qna',
    'appointment_photo',
    'media',
  ],
  kind: ['refresh_token_reuse', 'security'],
} as const satisfies Record<string, readonly string[]>;

type ValueParam = keyof typeof VALUE_PARAMS;
const isValueParam = (k: string): k is ValueParam => k in VALUE_PARAMS;

/** Date-time params rendered in the viewer's calendar and zone. */
const DATE_PARAMS = new Set(['confirmed_start_at', 'start_at']);

/** "awaiting_parts" → "awaiting parts": the last resort for a value the dictionary does not know. */
const plain = (v: string) => v.replace(/_/g, ' ');

/** The interpolation values of a notification: enumerations as words, dates and numbers in the UI language. */
export function templateVars(params: Notification['template_params'], t: Translate, f: Formatter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'number') out[k] = f.number(v);
    else if (typeof v === 'boolean') out[k] = String(v);
    else if (isValueParam(k) && (VALUE_PARAMS[k] as readonly string[]).includes(v))
      out[k] = t(`notifications.values.${k}.${v}` as MessageKey);
    else if (DATE_PARAMS.has(k) && !Number.isNaN(Date.parse(v))) out[k] = f.date(v, 'dateTime');
    else out[k] = plain(v);
  }
  return out;
}

export interface RenderedNotification {
  title: string;
  text: string;
  /** False when the key is unknown to this build: a generic line is shown (BA-18). */
  known: boolean;
}

export function renderNotification(
  n: Pick<Notification, 'template_key' | 'template_params'>,
  t: Translate,
  f: Formatter,
): RenderedNotification {
  if (!isConsumerTemplate(n.template_key))
    return { title: t('notifications.generic.title'), text: t('notifications.generic.text'), known: false };
  const vars = templateVars(n.template_params, t, f);
  const base = `notifications.templates.${n.template_key}`;
  return { title: t(`${base}.title` as MessageKey, vars), text: t(`${base}.text` as MessageKey, vars), known: true };
}
