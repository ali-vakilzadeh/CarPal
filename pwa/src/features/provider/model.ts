// CarPal Workshop rules without React (frontend/provider-dev-plan.json PW1): which memberships are provider
// businesses, which business is active, the Today counters and the "Finish your profile" items, and the addresses of
// the Workshop and of the provider Web UI. The server decides access (PRV-GD-03); the role here only hides what the
// server would refuse anyway (approvals and insights are P+).
import type { Appointment, Membership, OrgStatus, Role, VerificationStatus } from '@carpal/api-contracts';

export const PROVIDER_ROLES = ['provider_owner', 'provider_manager', 'provider_staff'] as const satisfies readonly Role[];
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

const ROLE_RANK: Record<ProviderRole, number> = { provider_staff: 0, provider_manager: 1, provider_owner: 2 };

export const isProviderRole = (r: Role): r is ProviderRole => (PROVIDER_ROLES as readonly string[]).includes(r);

/** A provider business the signed-in user belongs to (PRV-GD-07 roles). */
export interface Business {
  orgId: string;
  name: string;
  role: ProviderRole;
  orgStatus: OrgStatus;
  verification: VerificationStatus;
}

/** P+ = provider_owner or provider_manager (Docs/40 §0.5). Staff are P*. */
export const isPlus = (b: Pick<Business, 'role'>) => b.role !== 'provider_staff';

/**
 * Provider businesses from me.memberships_list: active memberships with a provider role. Chosen by role, not by the
 * organization type, so a hybrid provider-vendor where the user is only vendor staff is not offered here. One entry
 * per organization (the highest role), in the order the server lists them.
 */
export function providerBusinesses(memberships: readonly Membership[]): Business[] {
  const out = new Map<string, Business>();
  for (const m of memberships) {
    if (m.status !== 'active' || !m.organization || !isProviderRole(m.role)) continue;
    const prev = out.get(m.organization.id);
    if (prev && ROLE_RANK[prev.role] >= ROLE_RANK[m.role]) continue;
    out.set(m.organization.id, {
      orgId: m.organization.id,
      name: m.organization.name,
      role: m.role,
      orgStatus: m.organization.status,
      verification: m.organization.verification_status,
    });
  }
  return [...out.values()];
}

/** The active business: the one asked for in the address, else the one kept on this device, else the first. */
export function pickBusiness(list: readonly Business[], requested: string | null, stored: string | null): Business | null {
  return list.find((b) => b.orgId === requested) ?? list.find((b) => b.orgId === stored) ?? list[0] ?? null;
}

/** Key of the active business of a user in this device's localStorage (an id only, no API answer; PRV-GD-05, PRV-OQ-12). */
export const activeKey = (userId: string) => `cp:provider:active:${userId}`;
export const ACTIVE_KEY_PREFIX = 'cp:provider:';

// ---------------------------------------------------------------- addresses

export const WORKSHOP_TABS = ['today', 'requests', 'replies', 'photos'] as const;
export type WorkshopTab = (typeof WORKSHOP_TABS)[number];

export const workshopPath = (locale: string, sub = 'today') => `/${locale}/provider${sub ? `/${sub}` : ''}`;

/** The Workshop tab of a path (/fa/provider/requests/123 → requests), or null outside the tabs. */
export function workshopTabOf(pathname: string): WorkshopTab | null {
  const m = /^\/[a-z]{2}\/provider\/([a-z]+)/.exec(pathname);
  const tab = m?.[1];
  return tab && (WORKSHOP_TABS as readonly string[]).includes(tab) ? (tab as WorkshopTab) : null;
}

/**
 * "Open in Web UI" (PW1.T7): the provider area of the business web app at web.<DOMAIN> in the same language, with the
 * organization to open. Another origin, so a new tab and a separate sign-in (PRV-GD-01).
 */
export function portalHref(portalUrl: string, locale: string, orgId: string | null, path = 'dashboard'): string {
  const url = new URL(`/${locale}/provider/${path.replace(/^\/+/, '')}`, portalUrl);
  if (orgId) url.searchParams.set('org', orgId);
  return url.toString();
}

// ---------------------------------------------------------------- notifications

/** Business notifications the Workshop renders in its own words (dictionary provider.notifications.templates.*). */
export const WORKSHOP_TEMPLATE_KEYS = [
  'appointment.request_received',
  'appointment.customer_message',
  'appointment.delay',
  'appointment.cancelled',
  'appointment.status_updated',
  'review.received',
  'review.approval_needed',
  'review.approval_reminder',
  'organization.verified',
  'organization.location_corrected',
  'organization.verification_info_requested',
  'organization.verification_rejected',
  'organization.profile_corrected',
] as const;
const WORKSHOP_TEMPLATES = new Set<string>(WORKSHOP_TEMPLATE_KEYS);
export const isWorkshopTemplate = (key: string) => WORKSHOP_TEMPLATES.has(key);

/**
 * Where a business notification opens inside the Workshop (surfaces.workshop_pwa.push_and_deep_links). Requests and
 * replies open their Workshop page; organization notices (verification, corrections) have no Workshop page: null,
 * the row says to open the Web UI.
 */
export function workshopDestination(
  n: { template_key: string; reference: { type: string; id: string } | null },
  locale: string,
): string | null {
  const id = n.reference ? encodeURIComponent(n.reference.id) : null;
  switch (n.template_key) {
    case 'review.approval_needed':
    case 'review.approval_reminder':
      return workshopPath(locale, id ? `replies/approvals/${id}` : 'replies');
    case 'review.received':
      return workshopPath(locale, id ? `replies/reviews/${id}` : 'replies');
  }
  if (n.reference?.type === 'appointment' && id) return workshopPath(locale, `requests/${id}`);
  return null;
}

// ---------------------------------------------------------------- Today

/** Requests waiting for the shop's answer (Docs/40 provider.appointments_list group=new). */
export const isWaiting = (a: Pick<Appointment, 'status'>) => a.status === 'requested' || a.status === 'provider_reviewing';

/** Safety-critical: the customer's safety flag or the urgency level (Docs/11 Ch.5). */
export const isSafetyCritical = (a: Pick<Appointment, 'safety_flag' | 'urgency_level'>) =>
  a.safety_flag || a.urgency_level === 'safety_critical';

/** Safety-critical first, then by start time (confirmed, else proposed, else asked), oldest first. */
export function safetyFirst<
  T extends Pick<Appointment, 'safety_flag' | 'urgency_level' | 'confirmed_start_at' | 'proposed_start_at' | 'created_at'>,
>(items: readonly T[]): T[] {
  const at = (a: T) => Date.parse(a.confirmed_start_at ?? a.proposed_start_at ?? a.created_at) || 0;
  return [...items].sort((a, b) => Number(isSafetyCritical(b)) - Number(isSafetyCritical(a)) || at(a) - at(b));
}

/** Minutes the oldest waiting request has waited, or null when none waits. */
export function oldestWaitingMinutes(items: readonly Pick<Appointment, 'status' | 'created_at'>[], now: number): number | null {
  const times = items
    .filter(isWaiting)
    .map((a) => Date.parse(a.created_at))
    .filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  return Math.max(0, Math.round((now - Math.min(...times)) / 60_000));
}

/**
 * A count from one page of a list without a total (Docs/40 Page<T> has items and next_cursor only): "50+" when the
 * server has more.
 */
export function pageCount(
  page: { items: readonly unknown[]; next_cursor: string | null } | undefined,
  number: (n: number) => string,
): string | null {
  if (!page) return null;
  return page.next_cursor ? `${number(page.items.length)}+` : number(page.items.length);
}

/** Hours and minutes of a waiting time: { h, m } for the "11 h" / "2 h 10 min" texts. */
export function splitMinutes(total: number): { h: number; m: number } {
  return { h: Math.floor(total / 60), m: total % 60 };
}

/**
 * "Finish your profile" (RF-07): the completeness gaps (ProviderProfile.completeness_gaps, backend profile-rules.ts)
 * the shop can act on, in the order a phone-first workshop would do them. Reviews and response rate come with time;
 * location verification is CarPal's check (NX-02). Where it is done: 'photos' in this app, 'web' in the Web UI.
 */
export const FINISH_ITEMS = [
  { gap: 'hours_set', where: 'web' },
  { gap: 'service_categories', where: 'web' },
  { gap: 'business_info', where: 'web' },
  { gap: 'appointment_availability', where: 'web' },
  { gap: 'portfolio_items', where: 'photos' },
  { gap: 'certifications', where: 'web' },
] as const;
export type FinishGap = (typeof FINISH_ITEMS)[number]['gap'];

export function finishItems(gaps: readonly string[]): (typeof FINISH_ITEMS)[number][] {
  return FINISH_ITEMS.filter((i) => gaps.includes(i.gap));
}

/** The 'Verification pending' line (PRV-DI-02): shown until CarPal has verified the business. */
export const verificationPending = (b: Pick<Business, 'verification'>) => b.verification !== 'verified';

/**
 * Completed CarPal appointments that have no showcase yet (PW-PHO-01 "Jobs ready for photos", PRV-OQ-06), from one
 * page of each list. Counted in the browser: the contract has no "without showcase" filter (provider plan PRV-BR-12).
 */
export function jobsReadyForPhotos<A extends Pick<Appointment, 'id' | 'status'>>(
  closed: readonly A[],
  portfolio: readonly { appointment_id?: string }[],
): A[] {
  const shown = new Set(portfolio.map((p) => p.appointment_id).filter(Boolean));
  return closed.filter((a) => a.status === 'completed' && !shown.has(a.id));
}

/** Showcases sent to the customer and not answered yet (PW-PHO-01 "Waiting for customer"). */
export const waitingForCustomer = (p: { customer_consent_status: string; status: string }) =>
  p.customer_consent_status === 'requested' && p.status !== 'archived';
