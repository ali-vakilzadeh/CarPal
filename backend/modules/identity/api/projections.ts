// Response projections of the identity module (40 §6.1), built by allowlist:
// credential references, token hashes, invitation hashes and staff ids never
// leave the module (SEC-OUT-1).
import type { Selectable } from 'kysely';
import type { Session as StoredSession } from '#libs/auth/index.js';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { SubscriptionSummary } from '#modules/billing/interface/billing.js';
import { toOrgSummary, type OrgCard } from '#modules/organization/interface/org-cards.js';
import type { MembershipRow, MethodRow, PreferenceRow, UserRow } from '../infrastructure/accounts.js';

type ConsentRow = Selectable<DB['identity.consent_records']>;
type DsrRow = Selectable<DB['identity.data_subject_requests']>;
type OnboardingRow = Selectable<DB['identity.onboarding_progress']>;

/** 40 UserPreference. */
export function toPreference(p: PreferenceRow) {
  return {
    ...meta(p),
    default_role_membership_id: p.default_role_membership_id,
    calendar_system: p.calendar_system as 'gregorian' | 'jalali',
    digit_style: p.digit_style as 'latin' | 'persian',
    distance_unit: p.distance_unit as 'km' | 'mi',
    navigation_app_key: p.navigation_app_key,
    preferred_currency: p.preferred_currency,
    profile_visibility: p.profile_visibility as 'public' | 'members_only' | 'private',
    show_vehicles_on_profile: p.show_vehicles_on_profile,
    ai_personalization_enabled: p.ai_personalization_enabled,
    ai_suggestions_enabled: p.ai_suggestions_enabled,
    critical_alerts_only: p.critical_alerts_only,
    marketing_opt_in: p.marketing_opt_in,
  };
}

/** 40 Membership (organization null for individual and platform_* roles). */
export function toMembership(m: MembershipRow, orgs: Map<string, OrgCard>) {
  const card = m.organization_id ? orgs.get(m.organization_id) : undefined;
  return {
    ...meta(m),
    organization: card ? toOrgSummary(card) : null,
    role: m.role,
    status: m.status,
    joined_at: isoOrNull(m.joined_at),
  };
}

/** 40 Me. */
export function toMe(u: UserRow, pref: PreferenceRow, memberships: ReturnType<typeof toMembership>[], subscription: SubscriptionSummary) {
  return {
    ...meta(u),
    full_name: u.full_name,
    display_name: u.display_name,
    email: u.email,
    phone: u.phone,
    locale: u.locale,
    timezone: u.timezone,
    status: u.status,
    email_verified_at: isoOrNull(u.email_verified_at),
    phone_verified_at: isoOrNull(u.phone_verified_at),
    mfa_enabled: u.mfa_enabled,
    preferred_contact_channel: u.preferred_contact_channel,
    last_active_at: isoOrNull(u.last_active_at),
    preference: toPreference(pref),
    memberships,
    subscription,
  };
}

/** 40 Session (from the session store; country is not resolved in lite mode). */
export function toSession(s: StoredSession, currentSid: string) {
  return {
    id: s.sid,
    client_id: s.clientId,
    device_label: (s.deviceLabel ?? s.clientId).slice(0, 80),
    created_at: iso(s.createdAt),
    last_seen_at: iso(s.lastSeenAt ?? s.createdAt),
    country: s.country ?? null,
    acr: s.acr,
    current: s.sid === currentSid,
  };
}

/** 40 MfaMethod. */
export function toMfaMethod(m: MethodRow) {
  return {
    id: m.id,
    method_type: m.method_type as 'totp_mfa' | 'webauthn',
    label: m.label ?? (m.method_type === 'webauthn' ? 'Security key' : 'Authenticator app'),
    created_at: iso(m.created_at),
    last_used_at: isoOrNull(m.last_used_at),
    status: m.status as 'pending' | 'active' | 'disabled',
  };
}

/** 40 ConsentRecord. */
export function toConsentRecord(c: ConsentRow) {
  return {
    ...meta(c),
    subject_type: c.subject_type as 'user' | 'organization',
    subject_id: c.subject_id,
    consent_type: c.consent_type,
    scope_entity_type: c.scope_entity_type,
    scope_entity_id: c.scope_entity_id,
    granted_to_type: c.granted_to_type as 'organization' | 'platform' | 'mcp_client' | null,
    granted_to_id: c.granted_to_id,
    policy_version: c.policy_version,
    granted: c.granted,
    granted_at: isoOrNull(c.granted_at),
    withdrawn_at: isoOrNull(c.withdrawn_at),
    expires_at: isoOrNull(c.expires_at),
    source: c.source as 'ui' | 'admin' | 'import' | 'api',
  };
}

/** 40 DataSubjectRequest (export_available: derived per request). */
export function toDataSubjectRequest(d: DsrRow, exportAvailable: boolean) {
  return {
    ...meta(d),
    request_type: d.request_type as 'export' | 'deletion' | 'rectification' | 'consent_withdrawal',
    details: d.details,
    status: d.status as 'received' | 'verifying_identity' | 'in_progress' | 'completed' | 'rejected',
    requested_at: iso(d.requested_at),
    due_at: iso(d.due_at),
    rejection_reason: d.rejection_reason,
    completed_at: isoOrNull(d.completed_at),
    export_available: exportAvailable,
  };
}

/** 40 OnboardingProgress: the assisting staff member by display name only. */
export function toOnboarding(o: OnboardingRow, assistedBy: string | null) {
  return {
    ...meta(o),
    flow_type: o.flow_type as 'individual' | 'fleet' | 'provider' | 'vendor',
    organization_id: o.organization_id,
    current_step: o.current_step,
    completed_steps: o.completed_steps,
    status: o.status as 'in_progress' | 'completed' | 'abandoned' | 'reset',
    completed_at: isoOrNull(o.completed_at),
    assisted: o.assisted,
    assisted_by_display_name: o.assisted ? assistedBy : null,
  };
}
