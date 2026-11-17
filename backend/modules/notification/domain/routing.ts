// Event → notification routing of W5 (41 §6.2; 52 Notification event types).
// Pure: an event becomes zero or more intents with a symbolic audience that
// the dispatcher resolves (users, organization members by role, followers).
// Templates take plain values only: no VIN, plate or contact data.
import type { Category, Channel } from './preferences.js';

export type Audience =
  | { kind: 'users'; ids: string[] }
  | { kind: 'members'; orgId: string; roles: string[] }
  | { kind: 'followers'; orgId: string; preferences: ('all' | 'important_only')[] }
  /** Active platform staff with one of `roles` (S17 staff notices), without `except`. */
  | { kind: 'staff'; roles: string[]; except: string | null };

export interface Intent {
  audience: Audience;
  event_type: string;
  category: Category;
  priority: 'normal' | 'critical';
  template_key: string;
  params: Record<string, string | number | boolean>;
  reference: { type: string; id: string } | null;
  organization_context_id: string | null;
  /** Channels this intent may use (in_app is always the notification itself). */
  channels: Channel[];
}

export interface RoutedEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const ALL: Channel[] = ['in_app', 'email', 'push', 'sms'];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

const VENDOR_ROLES = ['vendor_owner', 'vendor_staff'];
const FLEET_COORDINATORS = ['fleet_owner', 'fleet_manager', 'fleet_maintenance_coordinator'];
const FLEET_APPROVERS = ['fleet_owner', 'fleet_manager'];
const ORG_MANAGERS = ['provider_owner', 'provider_manager', 'vendor_owner', 'fleet_owner', 'fleet_manager'];

/** Subjects W5 consumes (S3-S6 events; appointment, review and AI events join in S7-S9). */
export const ROUTED_EVENTS = [
  'user.registered',
  'user.security_alert',
  'inquiry.sent',
  'vendor.inventory.imported',
  'vehicle.reminder.due',
  'fleet.approval.requested',
  'community.post.published',
  'media.scan.completed',
  // S7: appointments, reviews, invitations, inquiry answers
  'appointment.requested',
  'appointment.confirmed',
  'appointment.status_changed',
  'appointment.completed',
  'appointment.reminder.due',
  'appointment.note_added',
  'appointment.delay_reported',
  'review.invitation.sent',
  'review.invitation.reminded',
  'review.approval.requested',
  // S25a: the business is reminded of a Path 2 review still waiting for its answer (days of the notification rules)
  'review.approval.reminded',
  'review.published',
  'review.response.published',
  'inquiry.status_changed',
  // S8: fleet decisions, moderation outcomes, verification and location corrections, DSR deadlines (staff)
  'fleet.approval.decided',
  'moderation.action.taken',
  // S20: a staff message in a dispute thread (the party is told to read and answer it)
  'dispute.message.posted',
  // S24: CarPal answered or solved the user's support ticket (staff replies only; the requester's own replies wait in the inbox)
  'support.message.posted',
  'support.ticket.solved',
  'organization.verified',
  'organization.location.corrected',
  // S19: CarPal asks a business for more information on a verification check; staff corrected its profile
  'organization.verification.info_requested',
  'organization.profile.corrected',
  // S25a: a rejected verification check (the owners and managers learn what to fix)
  'organization.verification.rejected',
  'dsr.deadline.approaching',
  // S9: an AI result the member or user asked for is ready (in-app only, OQ-13 default for AI suggestions)
  'ai.insight.generated',
  // S9 decision follow-ups: vehicle transfers (GD-33) and fleet data shared with a provider (GD-34)
  'vehicle.transfer.requested',
  'vehicle.transfer.decided',
  'fleet.vehicle_data.shared',
  // S17: staff notices on the admin plane (four-eyes outcome, AI kill switch, staff account security)
  'four_eyes.decided',
  'feature_flag.changed',
  'staff.recovery_requested',
  'staff.recovery_completed',
  'staff.break_glass',
  // S26a: the display exchange rate was not set by the reminder hour (administrators, console and email)
  'exchange_rate.reminder_due',
] as const;

const PROVIDER_MEMBERS = ['provider_owner', 'provider_manager', 'provider_staff'];
const REVIEW_MANAGERS = ['provider_owner', 'provider_manager', 'vendor_owner'];

/** The requester side of an appointment: the user, or the fleet's coordinators. */
function requesterAudience(p: Record<string, unknown>): { audience: Audience; org: string | null } | null {
  const fleet = str(p.requester_organization_id);
  if (fleet) return { audience: { kind: 'members', orgId: fleet, roles: FLEET_COORDINATORS }, org: fleet };
  const user = str(p.requester_user_id);
  return user ? { audience: { kind: 'users', ids: [user] }, org: null } : null;
}

function appointmentIntent(
  e: RoutedEvent,
  to: { audience: Audience; org: string | null },
  eventType: string,
  template: string,
  params: Intent['params'] = {},
  channels: Channel[] = ALL,
): Intent {
  return {
    audience: to.audience,
    event_type: eventType,
    category: 'appointments',
    priority: 'normal',
    template_key: template,
    params,
    reference: { type: 'appointment', id: e.aggregateId },
    organization_context_id: to.org,
    channels,
  };
}

/** S7 routes (appointments, reviews, invitations, inquiry answers); empty for other events. */
function routeS7(e: RoutedEvent): Intent[] {
  const p = e.payload;
  const provider = str(p.provider_organization_id);
  const providerSide = provider
    ? { audience: { kind: 'members', orgId: provider, roles: PROVIDER_MEMBERS } as Audience, org: provider }
    : null;
  const requesterSide = requesterAudience(p);
  switch (e.type) {
    case 'appointment.requested':
      return providerSide ? [appointmentIntent(e, providerSide, 'appointment_request_received', 'appointment.request_received')] : [];
    case 'appointment.confirmed':
      // The email with the check-in link went out through the Messenger; the notification stays in-app and push.
      return requesterSide
        ? [appointmentIntent(e, requesterSide, 'appointment_confirmed', 'appointment.confirmed', {}, ['in_app', 'push'])]
        : [];
    case 'appointment.status_changed': {
      const to = str(p.new_status);
      const by = str(p.changed_by_side);
      // confirmed and completed have their own events.
      if (!to || to === 'confirmed' || to === 'completed' || to === 'requested' || to === 'draft') return [];
      if (to === 'cancelled') {
        const other = by === 'requester' ? providerSide : requesterSide;
        return other
          ? [appointmentIntent(e, other, 'appointment_cancelled', 'appointment.cancelled', { changed_by_side: by ?? 'system' })]
          : [];
      }
      if (to === 'alternative_proposed')
        return requesterSide
          ? [appointmentIntent(e, requesterSide, 'appointment_alternative_proposed', 'appointment.alternative_proposed')]
          : [];
      const other = by === 'requester' ? providerSide : requesterSide;
      return other ? [appointmentIntent(e, other, 'appointment_status_updated', 'appointment.status_updated', { new_status: to })] : [];
    }
    case 'appointment.completed': {
      if (!requesterSide) return [];
      const fleet = requesterSide.org !== null;
      return [appointmentIntent(e, requesterSide, fleet ? 'repair_completed' : 'appointment_status_updated', 'appointment.completed')];
    }
    case 'appointment.reminder.due':
      return requesterSide
        ? [
            appointmentIntent(e, requesterSide, 'appointment_reminder', 'appointment.reminder', {
              confirmed_start_at: str(p.confirmed_start_at) ?? '',
            }),
          ]
        : [];
    case 'appointment.note_added': {
      const to = p.author_side === 'provider' ? requesterSide : providerSide;
      return to ? [appointmentIntent(e, to, 'customer_message', 'appointment.customer_message')] : [];
    }
    case 'appointment.delay_reported':
      return providerSide
        ? [
            appointmentIntent(e, providerSide, 'appointment_status_updated', 'appointment.delay', {
              customer_delay_minutes: num(p.customer_delay_minutes),
            }),
          ]
        : [];
    case 'review.invitation.sent':
    case 'review.invitation.reminded': {
      const user = str(p.invited_user_id);
      if (!user) return [];
      return [
        {
          audience: { kind: 'users', ids: [user] },
          event_type: 'review_invitation',
          category: 'reviews',
          priority: 'normal',
          template_key: 'review.invitation_in_app',
          params: {},
          reference: { type: 'review_request', id: e.aggregateId },
          organization_context_id: null,
          channels: ['in_app', 'push'],
        },
      ];
    }
    case 'review.approval.requested':
    case 'review.approval.reminded': {
      const org = str(p.subject_organization_id);
      if (!org || p.business_confirmation_status !== 'pending') return [];
      // S25a.T2: a reminder names the days left before the answer counts as no objection.
      const reminder = e.type === 'review.approval.reminded';
      return [
        {
          audience: { kind: 'members', orgId: org, roles: REVIEW_MANAGERS },
          event_type: 'review_approval_needed',
          category: 'reviews',
          priority: 'normal',
          template_key: reminder ? 'review.approval_reminder' : 'review.approval_needed',
          params: reminder ? { days_left: Math.min(7, Math.max(1, num(p.days_left))) } : {},
          reference: { type: 'review', id: e.aggregateId },
          organization_context_id: org,
          channels: ALL,
        },
      ];
    }
    case 'review.published': {
      const org = str(p.subject_organization_id);
      const author = str(p.author_user_id);
      const out: Intent[] = [];
      if (org)
        out.push({
          audience: { kind: 'members', orgId: org, roles: [...PROVIDER_MEMBERS, ...VENDOR_ROLES] },
          event_type: 'review_received',
          category: 'reviews',
          priority: 'normal',
          template_key: 'review.received',
          params: {},
          reference: { type: 'review', id: e.aggregateId },
          organization_context_id: org,
          channels: ALL,
        });
      if (author)
        out.push({
          audience: { kind: 'users', ids: [author] },
          event_type: 'review_status_updated',
          category: 'reviews',
          priority: 'normal',
          template_key: 'review.status_updated',
          params: {},
          reference: { type: 'review', id: e.aggregateId },
          organization_context_id: null,
          channels: ['in_app', 'push'],
        });
      return out;
    }
    case 'review.response.published': {
      const author = str(p.author_user_id);
      if (!author) return [];
      return [
        {
          audience: { kind: 'users', ids: [author] },
          event_type: 'review_response_published',
          category: 'reviews',
          priority: 'normal',
          template_key: 'review.response_published',
          params: {},
          reference: { type: 'review', id: e.aggregateId },
          organization_context_id: null,
          channels: ['in_app', 'push'],
        },
      ];
    }
    case 'inquiry.status_changed': {
      const to = str(p.new_status);
      const user = str(p.requester_user_id);
      // The vendor answered, reserved or had nothing: the requester is told (52 inquiry_answered).
      if (!user || !to || !['answered', 'reserved', 'unavailable'].includes(to) || p.requester_type !== 'user') return [];
      return [
        {
          audience: { kind: 'users', ids: [user] },
          event_type: 'inquiry_answered',
          category: 'inquiries',
          priority: 'normal',
          template_key: 'inquiry.answered',
          params: { new_status: to },
          reference: { type: 'stock_inquiry', id: e.aggregateId },
          organization_context_id: null,
          channels: ALL,
        },
      ];
    }
    default:
      return routeS8(e);
  }
}

export function route(e: RoutedEvent): Intent[] {
  const p = e.payload;
  switch (e.type) {
    case 'user.registered':
      return [
        {
          audience: { kind: 'users', ids: [e.aggregateId] },
          event_type: 'system_announcement',
          category: 'system',
          priority: 'normal',
          template_key: 'system.welcome',
          params: {},
          reference: null,
          organization_context_id: null,
          // The verification mail was just sent; the welcome stays in the app.
          channels: ['in_app'],
        },
      ];
    case 'user.security_alert':
      // SEC-AU-5: critical, always in-app; the email went out synchronously from the auth server.
      return [
        {
          audience: { kind: 'users', ids: [str(p.user_id) ?? e.aggregateId] },
          event_type: 'system_announcement',
          category: 'system',
          priority: 'critical',
          template_key: 'system.security_alert',
          params: { kind: str(p.kind) ?? 'security' },
          reference: null,
          organization_context_id: null,
          channels: ['in_app', 'push'],
        },
      ];
    case 'inquiry.sent': {
      const vendor = str(p.vendor_organization_id);
      if (!vendor) return [];
      return [
        {
          audience: { kind: 'members', orgId: vendor, roles: VENDOR_ROLES },
          event_type: 'inquiry_received',
          category: 'inquiries',
          priority: 'normal',
          template_key: 'inquiry.received',
          params: {},
          reference: { type: 'stock_inquiry', id: e.aggregateId },
          organization_context_id: vendor,
          channels: ALL,
        },
      ];
    }
    case 'vendor.inventory.imported': {
      const vendor = str(p.vendor_organization_id);
      if (!vendor) return [];
      const by = str(p.requested_by_user_id);
      return [
        {
          audience: by ? { kind: 'users', ids: [by] } : { kind: 'members', orgId: vendor, roles: ['vendor_owner'] },
          event_type: 'inventory_import_finished',
          category: 'inventory',
          priority: 'normal',
          template_key: 'inventory.import_finished',
          params: { created_count: num(p.created_count), updated_count: num(p.updated_count), error_count: num(p.error_count) },
          reference: { type: 'inventory_import_batch', id: e.aggregateId },
          organization_context_id: vendor,
          channels: ALL,
        },
      ];
    }
    case 'vehicle.reminder.due': {
      const owner = str(p.owner_id);
      if (!owner) return [];
      const fleet = p.owner_type === 'organization';
      return [
        {
          audience: fleet ? { kind: 'members', orgId: owner, roles: FLEET_COORDINATORS } : { kind: 'users', ids: [owner] },
          event_type: fleet ? 'vehicle_due_for_service' : 'service_reminder',
          category: fleet ? 'fleet' : 'service_reminders',
          priority: 'normal',
          template_key: fleet ? 'fleet.vehicle_due' : 'vehicle.reminder_due',
          params: { reminder_type: str(p.reminder_type) ?? 'maintenance', status: str(p.status) ?? 'due' },
          reference: { type: 'maintenance_reminder', id: e.aggregateId },
          organization_context_id: fleet ? owner : null,
          channels: ALL,
        },
      ];
    }
    case 'fleet.approval.requested': {
      // Only an approval that exists (a provider's cost estimate below the fleet threshold opens none, S8).
      const fleet = str(p.organization_id);
      const approval = str(p.approval_id);
      if (!fleet || !approval) return [];
      return [
        {
          audience: { kind: 'members', orgId: fleet, roles: FLEET_APPROVERS },
          event_type: 'fleet_approval_needed',
          category: 'fleet',
          priority: 'normal',
          template_key: 'fleet.approval_needed',
          params: { approval_type: str(p.approval_type) ?? 'repair_request' },
          reference: { type: 'fleet_approval', id: approval },
          organization_context_id: fleet,
          channels: ALL,
        },
      ];
    }
    case 'community.post.published': {
      const org = str(p.organization_id);
      if (!org) return [];
      const important = ['availability', 'special_offer', 'community_event'].includes(String(p.post_type));
      return [
        {
          audience: { kind: 'followers', orgId: org, preferences: important ? ['all', 'important_only'] : ['all'] },
          event_type: 'favorite_provider_update',
          category: 'community',
          priority: 'normal',
          template_key: 'community.followed_update',
          params: { post_type: str(p.post_type) ?? 'update' },
          reference: { type: 'post', id: e.aggregateId },
          organization_context_id: null,
          channels: ALL,
        },
      ];
    }
    case 'media.scan.completed': {
      if (p.scan_status === 'clean') return [];
      const owner = str(p.owner_id);
      if (!owner) return [];
      const org = p.owner_type === 'organization';
      return [
        {
          audience: org ? { kind: 'members', orgId: owner, roles: ORG_MANAGERS } : { kind: 'users', ids: [owner] },
          event_type: 'moderation_update',
          category: 'moderation',
          priority: 'normal',
          template_key: 'media.upload_refused',
          params: { purpose: str(p.purpose) ?? 'media' },
          reference: { type: 'media_asset', id: e.aggregateId },
          organization_context_id: org ? owner : null,
          channels: ALL,
        },
      ];
    }
    default:
      return routeS7(e);
  }
}

/** Moderation actions the affected user or organization is told about (52 Notification moderation_update). */
const NOTIFIED_ACTIONS = [
  'approve',
  'hide',
  'remove',
  'restore',
  'request_changes',
  'warn_user',
  'suspend_account',
  'reactivate_account',
  // S20 (BR-15): the author is asked to edit a review; the vendor's fitment row is downgraded. reduce_weight is silent.
  'edit_request',
  'downgrade_fitment',
];
const ORG_ADMINS = ['provider_owner', 'provider_manager', 'vendor_owner', 'fleet_owner', 'fleet_manager'];

/** S8 routes: fleet decisions, moderation outcomes, verification, location corrections and staff DSR alerts. */
export function routeS8(e: RoutedEvent): Intent[] {
  const p = e.payload;
  switch (e.type) {
    case 'fleet.approval.decided': {
      const requester = str(p.requested_by_user_id);
      const fleet = str(p.organization_id);
      if (!requester || !fleet) return [];
      return [
        {
          audience: { kind: 'users', ids: [requester] },
          event_type: 'system_announcement',
          category: 'fleet',
          priority: 'normal',
          template_key: 'fleet.approval_decided',
          params: { approval_type: str(p.approval_type) ?? 'repair_request', status: String(p.status ?? 'approved') },
          reference: { type: 'fleet_approval', id: e.aggregateId },
          organization_context_id: fleet,
          channels: ['in_app', 'push', 'email'],
        },
      ];
    }
    case 'moderation.action.taken': {
      const action = String(p.action_type ?? '');
      if (!NOTIFIED_ACTIONS.includes(action)) return [];
      const params = { action_type: action, target_type: String(p.target_type ?? 'content') };
      const reference = str(p.target_id) ? { type: String(p.target_type ?? 'content'), id: str(p.target_id)! } : null;
      const user = str(p.user_id);
      if (user)
        return [
          {
            audience: { kind: 'users', ids: [user] },
            event_type: 'moderation_update',
            category: 'moderation',
            priority: action === 'suspend_account' ? 'critical' : 'normal',
            template_key: 'moderation.action_taken',
            params,
            reference,
            organization_context_id: null,
            channels: ['in_app', 'email'],
          },
        ];
      const org = str(p.organization_id);
      if (!org) return [];
      return [
        {
          audience: { kind: 'members', orgId: org, roles: ORG_ADMINS },
          event_type: 'moderation_update',
          category: 'moderation',
          priority: 'normal',
          template_key: 'moderation.action_taken',
          params,
          reference,
          organization_context_id: org,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'dispute.message.posted': {
      // Only staff messages notify (a party's reply waits in the staff queue); staff names never leave the admin plane.
      if (p.author !== 'staff') return [];
      const params = { dispute_type: String(p.dispute_type ?? 'dispute'), template_key: String(p.template_key ?? 'other') };
      const reference = { type: 'dispute', id: str(p.dispute_id) ?? e.aggregateId };
      const user = str(p.user_id);
      const org = str(p.organization_id);
      const base = {
        event_type: 'moderation_update',
        category: 'moderation' as const,
        priority: 'normal' as const,
        template_key: 'dispute.message_received',
      };
      if (user)
        return [
          {
            ...base,
            audience: { kind: 'users', ids: [user] },
            params,
            reference,
            organization_context_id: null,
            channels: ['in_app', 'email'],
          },
        ];
      if (!org) return [];
      return [
        {
          ...base,
          audience: { kind: 'members', orgId: org, roles: ORG_ADMINS },
          params,
          reference,
          organization_context_id: org,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'support.message.posted':
    case 'support.ticket.solved': {
      // Backend S24 (BR-13): only staff messages and solved tickets notify; the notice links to the ticket in the app.
      if (e.type === 'support.message.posted' && p.author !== 'staff') return [];
      const user = str(p.requester_user_id);
      if (!user) return [];
      return [
        {
          audience: { kind: 'users', ids: [user] },
          event_type: 'support_update',
          category: 'system',
          priority: 'normal',
          template_key: e.type === 'support.ticket.solved' ? 'support.ticket_solved' : 'support.reply_received',
          params: {},
          reference: { type: 'support_ticket', id: str(p.ticket_id) ?? e.aggregateId },
          organization_context_id: null,
          channels: ['in_app', 'email', 'push'],
        },
      ];
    }
    case 'organization.verified':
    case 'organization.location.corrected': {
      const org = str(p.organization_id) ?? e.aggregateId;
      return [
        {
          audience: { kind: 'members', orgId: org, roles: ORG_ADMINS },
          event_type: 'moderation_update',
          category: 'moderation',
          priority: 'normal',
          template_key: e.type === 'organization.verified' ? 'organization.verified' : 'organization.location_corrected',
          params: {},
          reference: { type: e.type === 'organization.verified' ? 'organization' : 'organization_location', id: e.aggregateId },
          organization_context_id: org,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'organization.verification.info_requested':
    case 'organization.profile.corrected': {
      // S19: the owners and managers read the request (org.verifications_list) or the corrected profile; never staff names.
      const org = str(p.organization_id);
      if (!org) return [];
      const info = e.type === 'organization.verification.info_requested';
      return [
        {
          audience: { kind: 'members', orgId: org, roles: ORG_ADMINS },
          event_type: 'moderation_update',
          category: 'moderation',
          priority: 'normal',
          template_key: info ? 'organization.verification_info_requested' : 'organization.profile_corrected',
          params: info ? { verification_type: str(p.verification_type) ?? 'business_identity' } : {},
          reference: info
            ? { type: 'organization_verification', id: str(p.verification_id) ?? e.aggregateId }
            : { type: 'organization', id: org },
          organization_context_id: org,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'organization.verification.rejected': {
      // S25a.T3 (Docs/23 A-VER-02): the reason written for the business, never the reviewer's name.
      const org = str(p.organization_id);
      if (!org) return [];
      return [
        {
          audience: { kind: 'members', orgId: org, roles: ORG_ADMINS },
          event_type: 'moderation_update',
          category: 'moderation',
          priority: 'normal',
          template_key: 'organization.verification_rejected',
          params: {
            verification_type: str(p.verification_type) ?? 'business_identity',
            rejection_reason: (str(p.rejection_reason) ?? '').slice(0, 500),
          },
          reference: { type: 'organization_verification', id: str(p.verification_id) ?? e.aggregateId },
          organization_context_id: org,
          channels: ['in_app', 'email', 'push'],
        },
      ];
    }
    case 'dsr.deadline.approaching': {
      const staff = Array.isArray(p.staff_user_ids) ? p.staff_user_ids.map(str).filter((x): x is string => !!x) : [];
      if (staff.length === 0) return [];
      return [
        {
          audience: { kind: 'users', ids: staff.slice(0, 200) },
          event_type: 'moderation_alert',
          category: 'system',
          priority: 'critical',
          template_key: 'admin.dsr_deadline',
          params: { request_count: num(p.request_count) },
          reference: null,
          organization_context_id: null,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'vehicle.transfer.requested': {
      // The current owner (user, or the fleet's owners and managers) decides; the buyer is not named in the message.
      const ownerId = str(p.from_owner_id);
      if (!ownerId) return [];
      const fleet = p.from_owner_type === 'organization';
      return [
        {
          audience: fleet ? { kind: 'members', orgId: ownerId, roles: FLEET_APPROVERS } : { kind: 'users', ids: [ownerId] },
          event_type: 'system_announcement',
          category: fleet ? 'fleet' : 'system',
          priority: 'normal',
          template_key: 'vehicle.transfer_requested',
          params: {},
          reference: { type: 'vehicle_transfer', id: e.aggregateId },
          organization_context_id: fleet ? ownerId : null,
          channels: ['in_app', 'push', 'email'],
        },
      ];
    }
    case 'vehicle.transfer.decided': {
      const buyer = str(p.requested_by_user_id);
      if (!buyer) return [];
      return [
        {
          audience: { kind: 'users', ids: [buyer] },
          event_type: 'system_announcement',
          category: 'system',
          priority: 'normal',
          template_key: 'vehicle.transfer_decided',
          params: { status: str(p.status) ?? 'rejected' },
          reference: { type: 'vehicle_transfer', id: e.aggregateId },
          organization_context_id: p.to_owner_type === 'organization' ? str(p.to_owner_id) : null,
          channels: ['in_app', 'push', 'email'],
        },
      ];
    }
    case 'fleet.vehicle_data.shared': {
      const fleet = str(p.fleet_organization_id);
      if (!fleet) return [];
      return [
        {
          audience: { kind: 'members', orgId: fleet, roles: FLEET_APPROVERS },
          event_type: 'system_announcement',
          category: 'fleet',
          priority: 'normal',
          template_key: 'fleet.vehicle_data_shared',
          params: { document_count: num(p.document_count) },
          reference: { type: 'appointment', id: e.aggregateId },
          organization_context_id: fleet,
          channels: ['in_app', 'email'],
        },
      ];
    }
    case 'ai.insight.generated': {
      // Only answers to a §21.3 request (a job): background insights (W9 imports, W10, W11) notify nobody.
      const requester = str(p.requested_by_user_id);
      if (!requester || !str(p.job_id) || p.visibility === 'internal') return [];
      return [
        {
          audience: { kind: 'users', ids: [requester] },
          event_type: 'ai_suggestion_ready',
          category: 'ai_suggestions',
          priority: 'normal',
          template_key: 'ai.suggestion_ready',
          params: { suggestion_count: num(p.suggestion_count) },
          reference: { type: 'ai_insight', id: e.aggregateId },
          organization_context_id: str(p.organization_id),
          channels: ['in_app'],
        },
      ];
    }
    default:
      return routeStaff(e);
  }
}

/** Template params of staff notices are plain values; the console renders them from its own dictionary. */
const ADMINS = ['platform_admin'];
const KILL_SWITCH_KEY = 'ai.automation.kill_switch';

function staffNotice(
  audience: Audience,
  eventType: 'four_eyes_outcome' | 'staff_security_alert' | 'ai_kill_switch_changed' | 'exchange_rate_reminder',
  template: string,
  params: Intent['params'],
  reference: Intent['reference'],
  priority: Intent['priority'],
): Intent {
  // In-app only: the console lists them (admin.notifications_list); the emails of S16a/S16b stay where they were.
  return {
    audience,
    event_type: eventType,
    category: 'system',
    priority,
    template_key: template,
    params,
    reference,
    organization_context_id: null,
    channels: ['in_app'],
  };
}

/** S17 routes: staff notices (BR-21 four-eyes outcome, BR-26 kill switch, S16a-D6 and S16b-D2 staff security). */
export function routeStaff(e: RoutedEvent): Intent[] {
  const p = e.payload;
  switch (e.type) {
    case 'four_eyes.decided': {
      const requester = str(p.requested_by);
      const status = str(p.status);
      if (!requester || !status || !['approved', 'rejected', 'expired'].includes(status)) return [];
      return [
        staffNotice(
          { kind: 'users', ids: [requester] },
          'four_eyes_outcome',
          'staff.four_eyes_outcome',
          { op_id: str(p.op_id) ?? 'change', status },
          { type: 'pending_change', id: e.aggregateId },
          'normal',
        ),
      ];
    }
    case 'feature_flag.changed': {
      if (p.key !== KILL_SWITCH_KEY || typeof p.enabled !== 'boolean') return [];
      return [
        staffNotice(
          { kind: 'staff', roles: ADMINS, except: null },
          'ai_kill_switch_changed',
          'staff.kill_switch_changed',
          { enabled: p.enabled ? 'on' : 'off' },
          { type: 'feature_flag', id: e.aggregateId },
          'critical',
        ),
      ];
    }
    case 'staff.recovery_requested':
    case 'staff.recovery_completed':
    case 'staff.break_glass': {
      const member = str(p.user_id);
      if (!member) return [];
      const template =
        e.type === 'staff.recovery_requested'
          ? 'staff.recovery_waiting'
          : e.type === 'staff.recovery_completed'
            ? 'staff.recovery_done'
            : 'staff.break_glass_notice';
      return [
        staffNotice(
          { kind: 'staff', roles: ADMINS, except: member },
          'staff_security_alert',
          template,
          { staff_name: str(p.staff_name) ?? '' },
          e.type === 'staff.break_glass' ? { type: 'user_account', id: member } : { type: 'staff_recovery_request', id: e.aggregateId },
          'critical',
        ),
      ];
    }
    case 'exchange_rate.reminder_due': {
      const currency = str(p.currency);
      if (!currency) return [];
      // S26a.T4: the morning reminder goes to the console and by email (normal priority: the person's preferences apply).
      return [
        {
          ...staffNotice(
            { kind: 'staff', roles: ADMINS, except: null },
            'exchange_rate_reminder',
            'staff.exchange_rate_reminder',
            { currency, per_usd: str(p.per_usd) ?? '' },
            { type: 'exchange_rate', id: e.aggregateId },
            'normal',
          ),
          channels: ['in_app', 'email'],
        },
      ];
    }
    default:
      return [];
  }
}

/** Event types of the S17 staff notices: never listed on the api host (40 §20.2 notifications.list). */
export const STAFF_ONLY_EVENT_TYPES = [
  'four_eyes_outcome',
  'staff_security_alert',
  'ai_kill_switch_changed',
  'exchange_rate_reminder',
] as const;
/** Event types admin.notifications_list shows (also the DSR deadline and reviewer queue notices). */
export const STAFF_EVENT_TYPES = [...STAFF_ONLY_EVENT_TYPES, 'moderation_alert', 'review_awaiting_approval'] as const;
