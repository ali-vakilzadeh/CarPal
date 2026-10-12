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
] as const;

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
      return [];
  }
}
