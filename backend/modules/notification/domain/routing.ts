// Event → notification routing of W5 (41 §6.2; 52 Notification event types).
// Pure: an event becomes zero or more intents with a symbolic audience that
// the dispatcher resolves (users, organization members by role, followers).
// Templates take plain values only: no VIN, plate or contact data.
import type { Category, Channel } from './preferences.js';

export type Audience =
  | { kind: 'users'; ids: string[] }
  | { kind: 'members'; orgId: string; roles: string[] }
  | { kind: 'followers'; orgId: string; preferences: ('all' | 'important_only')[] };

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
  'review.published',
  'review.response.published',
  'inquiry.status_changed',
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
    case 'review.approval.requested': {
      const org = str(p.subject_organization_id);
      if (!org || p.business_confirmation_status !== 'pending') return [];
      return [
        {
          audience: { kind: 'members', orgId: org, roles: REVIEW_MANAGERS },
          event_type: 'review_approval_needed',
          category: 'reviews',
          priority: 'normal',
          template_key: 'review.approval_needed',
          params: {},
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
      return [];
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
      const fleet = str(p.organization_id);
      if (!fleet) return [];
      return [
        {
          audience: { kind: 'members', orgId: fleet, roles: FLEET_APPROVERS },
          event_type: 'fleet_approval_needed',
          category: 'fleet',
          priority: 'normal',
          template_key: 'fleet.approval_needed',
          params: {},
          reference: { type: 'vehicle_issue', id: e.aggregateId },
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
