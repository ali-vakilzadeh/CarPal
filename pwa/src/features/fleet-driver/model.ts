// Fleet driver web views (DRV-WEB, P12.T4; Docs/02 WP19, Docs/55 §10.4 F-ISSUE-01). Pure rules, tested in node:
//   - which fleets the user drives for (me.memberships_list: role fleet_driver, active); the backend limits every
//     {flt} read to the vehicles assigned to the driver (SEC-AZ-7, backend GD-20/GD-38), so the PWA lists whatever
//     vehicles.list returns and offers no fleet-manager feature (BA-22; fleet role model OQ-18 stays the backend's);
//   - the issue report: title from the shortcut or the first words, at least 10 characters of description (BA-29),
//     "Vehicle feels unsafe" raises the urgency to safety-critical, a suggestion from the optional guided check
//     can only raise it;
//   - drafts and the offline queue: a report that cannot be sent (no network) is kept on this device per user and
//     sent when the browser is back online (F-ISSUE-01 "Offline: save draft and sync later"); photos cannot travel
//     offline, so a queued report goes text-only (F-ISSUE-01 "Media upload failed: allow text-only submission").
import type { Membership, UrgencyLevel, VehicleIssue } from '@carpal/api-contracts';

export interface DriverFleet {
  orgId: string;
  name: string;
}

/** The fleets the user is an active driver of. */
export function driverFleets(memberships: readonly Membership[]): DriverFleet[] {
  const out = new Map<string, DriverFleet>();
  for (const m of memberships)
    if (m.role === 'fleet_driver' && m.status === 'active' && m.organization)
      out.set(m.organization.id, { orgId: m.organization.id, name: m.organization.name });
  return [...out.values()];
}

export const URGENCIES = ['low', 'medium', 'high', 'safety_critical'] as const satisfies readonly UrgencyLevel[];
const RANK: Record<UrgencyLevel, number> = { low: 0, medium: 1, high: 2, safety_critical: 3 };

/** The urgency a report is sent with: the driver's choice, raised by "feels unsafe" and an accepted suggestion. */
export function reportUrgency(chosen: UrgencyLevel, unsafe: boolean, suggested: UrgencyLevel | null = null): UrgencyLevel {
  let u = chosen;
  if (suggested && RANK[suggested] > RANK[u]) u = suggested;
  return unsafe ? 'safety_critical' : u;
}

/** Common issue shortcuts (F-ISSUE-01): a key for the label and the title it fills in. */
export const SHORTCUTS = ['warningLight', 'noise', 'brakes', 'tyre', 'noStart', 'leak', 'overheating', 'accident'] as const;
export type Shortcut = (typeof SHORTCUTS)[number];

export const MIN_DESCRIPTION = 10; // BA-29
export const MAX_TITLE = 120;

/** The title the report is sent with: the chosen shortcut's words, else the first words of the description. */
export function reportTitle(description: string, shortcutTitle: string | null): string {
  if (shortcutTitle) return shortcutTitle.slice(0, MAX_TITLE);
  const words = description.trim().replace(/\s+/g, ' ');
  if ([...words].length <= 60) return words;
  const cut = [...words].slice(0, 60).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

export type ReportError = 'vehicle' | 'description' | 'mileage';

export interface ReportDraft {
  /** Local id of the draft (one per vehicle while editing; queued reports keep theirs). */
  id: string;
  orgId: string;
  vehicleId: string;
  shortcut: Shortcut | null;
  description: string;
  urgency: UrgencyLevel;
  unsafe: boolean;
  /** The odometer reading to record with the report (vehicles.mileage_add), as typed. */
  mileage: string;
  savedAt: string;
}

export function validateReport(d: Pick<ReportDraft, 'vehicleId' | 'description' | 'mileage'>, mileageKm: number | null): ReportError[] {
  const errors: ReportError[] = [];
  if (!d.vehicleId) errors.push('vehicle');
  if ([...d.description.trim()].length < MIN_DESCRIPTION) errors.push('description');
  if (d.mileage.trim() && mileageKm === null) errors.push('mileage');
  return errors;
}

/** Fleet approval of a driver's report, in words (null for none). */
export function approvalKey(i: Pick<VehicleIssue, 'fleet_approval_status'>): 'pending' | 'approved' | 'rejected' | null {
  return i.fleet_approval_status ?? null;
}

// ---------- drafts and the offline queue (localStorage, per user) ----------

export interface DriverStore {
  /** Unsent drafts by vehicle id. */
  drafts: Record<string, ReportDraft>;
  /** Reports waiting for the network, oldest first. */
  queue: ReportDraft[];
}

export const EMPTY_STORE: DriverStore = { drafts: {}, queue: [] };
export const MAX_QUEUE = 20;

export function storeKey(userId: string): string {
  return `cp:drive:${userId}`;
}

export function parseStore(raw: string | null): DriverStore {
  if (!raw) return EMPTY_STORE;
  try {
    const o = JSON.parse(raw) as Partial<DriverStore>;
    const drafts = o.drafts && typeof o.drafts === 'object' ? o.drafts : {};
    const queue = Array.isArray(o.queue) ? o.queue.filter((d) => d && typeof d.id === 'string' && typeof d.vehicleId === 'string') : [];
    return { drafts, queue: queue.slice(-MAX_QUEUE) };
  } catch {
    return EMPTY_STORE;
  }
}

export function withDraft(s: DriverStore, d: ReportDraft): DriverStore {
  return { ...s, drafts: { ...s.drafts, [d.vehicleId]: d } };
}

export function withoutDraft(s: DriverStore, vehicleId: string): DriverStore {
  const drafts = { ...s.drafts };
  delete drafts[vehicleId];
  return { ...s, drafts };
}

export function withQueued(s: DriverStore, d: ReportDraft): DriverStore {
  return { drafts: withoutDraft(s, d.vehicleId).drafts, queue: [...s.queue.filter((q) => q.id !== d.id), d].slice(-MAX_QUEUE) };
}

export function withoutQueued(s: DriverStore, id: string): DriverStore {
  return { ...s, queue: s.queue.filter((q) => q.id !== id) };
}
