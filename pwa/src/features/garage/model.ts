// My Garage view models (P7: W-GAR-01/02/03, Docs/21 C-GARAGE-01..09, C-PLAN-01). Pure functions over the contract
// types, so the screens stay thin and the rules are unit-tested: list groups and status chips, the plan line, the
// service history order and filters, the source mark, document expiry, reminder groups, issue segments, mileage
// input and the "looks like a record you already added" check.
import type {
  MaintenanceReminder,
  ServiceRecord,
  Subscription,
  Vehicle,
  VehicleDocument,
  VehicleIssue,
  VehicleStatus,
  VehicleTransfer,
} from '@carpal/api-contracts';
import { daysBetweenIso } from '@/lib/format/jalali';
import { toLatinDigits } from '@/lib/format';

export const TABS = ['overview', 'history', 'issues', 'documents', 'reminders'] as const;
export type GarageTab = (typeof TABS)[number];

export function isTab(value: string | undefined): value is GarageTab {
  return (TABS as readonly string[]).includes(value ?? '');
}

export function garagePath(locale: string, vehicleId?: string | null, tab: GarageTab | 'edit' | 'print' = 'overview'): string {
  return vehicleId ? `/${locale}/garage/${vehicleId}/${tab}` : `/${locale}/garage`;
}

/** The add (recordId 'new') or edit page of a service record. */
export function recordPath(locale: string, vehicleId: string, recordId: string | 'new'): string {
  return `/${locale}/garage/${vehicleId}/records/${recordId === 'new' ? 'new' : `${recordId}/edit`}`;
}

// ---------- Vehicles ----------

/** Vehicles that count toward the plan's limit (Docs/40 vehicles.status_change: active and in repair). */
export function countsTowardLimit(v: Pick<Vehicle, 'status'>): boolean {
  return v.status === 'active' || v.status === 'in_repair';
}

/** W-GAR-01 list: vehicles in use first (as listed), sold / inactive / archived in the collapsed group. */
export function groupVehicles(vehicles: readonly Vehicle[]): { inUse: Vehicle[]; parked: Vehicle[] } {
  return { inUse: vehicles.filter(countsTowardLimit), parked: vehicles.filter((v) => !countsTowardLimit(v)) };
}

export type VehicleChip = 'openIssue' | 'safetyIssue' | 'serviceDue' | 'inRepair';

/** Status chips of a vehicle card (Docs/21 C-GARAGE-01): open issue, service due (a reminder due within 30 days), in repair. */
export function vehicleChips(v: Vehicle, todayIso: string): VehicleChip[] {
  const chips: VehicleChip[] = [];
  if (v.status === 'in_repair') chips.push('inRepair');
  if (v.open_issue_count > 0) chips.push('openIssue');
  if (v.next_reminder_due && daysBetweenIso(todayIso, v.next_reminder_due) <= 30) chips.push('serviceDue');
  return chips;
}

export interface PlanLine {
  used: number;
  max: number | null;
  atLimit: boolean;
}

/** "2 of 5 vehicles on the free plan": the subscription's usage, else the vehicles in use. */
export function planLine(sub: Subscription | undefined, vehicles: readonly Vehicle[]): PlanLine {
  const used = sub?.usage.active_vehicles ?? vehicles.filter(countsTowardLimit).length;
  const max = sub?.plan.max_vehicles ?? null;
  return { used, max, atLimit: max !== null && used >= max };
}

/** Status choices of C-GARAGE-09 (archived is an admin/fleet state, in_repair comes from appointments). */
export const STATUS_CHOICES = ['active', 'inactive', 'sold'] as const satisfies readonly VehicleStatus[];

/** The fields the completeness meter of W-GAR-03 counts (the server's profile_completeness is authoritative). */
export const PROFILE_FIELDS = [
  'vin',
  'series_node_id',
  'engine_type_node_id',
  'fuel_type_node_id',
  'transmission',
  'drivetrain',
  'body_style',
  'color',
  'license_plate',
  'nickname',
  'mileage_km',
  'ownership_start_date',
  'primary_photo_media_id',
] as const;

/** Live estimate for the form preview: brand, model and year are required, so they make the first 40 %. */
export function completenessEstimate(values: Partial<Record<(typeof PROFILE_FIELDS)[number], unknown>>): number {
  const filled = PROFILE_FIELDS.filter((k) => values[k] !== undefined && values[k] !== null && values[k] !== '').length;
  return Math.round(40 + (60 * filled) / PROFILE_FIELDS.length);
}

/** "Mileage went down — correct a typo?" (C-GARAGE-08). */
export function mileageDrop(previous: number | undefined, next: number): boolean {
  return previous !== undefined && next < previous;
}

export const MAX_MILEAGE_KM = 2_000_000;

/** Typed mileage ("152,400", "۱۵۲٬۴۰۰") → km, or null when it is not a whole number in range. */
export function parseMileage(raw: string): number | null {
  const s = toLatinDigits(raw).replace(/[\s,٬.']/g, '');
  if (!/^\d{1,7}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_MILEAGE_KM ? n : null;
}

// ---------- Service history ----------

/** Verified = from a completed appointment, the provider, an invoice check or an admin; else "Added by you". */
export function isVerified(r: Pick<ServiceRecord, 'verification_status'>): boolean {
  return r.verification_status !== 'self_reported';
}

/** Edit and Delete only for records the user added (provider and appointment records can only be disputed). */
export function canEditRecord(r: Pick<ServiceRecord, 'created_by_type' | 'source_type'>): boolean {
  return r.created_by_type === 'user' && (r.source_type === 'user_manual' || r.source_type === 'invoice_upload');
}

export type RecordSort = 'date' | 'mileage' | 'cost';

export function sortRecords(records: readonly ServiceRecord[], by: RecordSort, dir: 'asc' | 'desc'): ServiceRecord[] {
  const key = (r: ServiceRecord): number =>
    by === 'date'
      ? Date.parse(`${r.service_date}T00:00:00Z`)
      : by === 'mileage'
        ? (r.mileage_km ?? -1)
        : r.cost
          ? Number(r.cost.amount)
          : -1;
  const sign = dir === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => sign * (key(a) - key(b)) || b.created_at.localeCompare(a.created_at));
}

/** Timeline view: newest first, grouped by year of the service date (`yearOf` gives the Jalali year in FA). */
export function groupByYear(
  records: readonly ServiceRecord[],
  yearOf: (isoDate: string) => number = (d) => Number(d.slice(0, 4)),
): { year: number; records: ServiceRecord[] }[] {
  const groups = new Map<number, ServiceRecord[]>();
  for (const r of sortRecords(records, 'date', 'desc')) {
    const y = yearOf(r.service_date);
    groups.set(y, [...(groups.get(y) ?? []), r]);
  }
  return [...groups.entries()].map(([year, list]) => ({ year, records: list }));
}

/** C-GARAGE-05: "This looks like a record you already added on …" — same date and category. */
export function findDuplicate(
  records: readonly ServiceRecord[],
  draft: { service_date: string; service_system_node_id: string },
  exceptId?: string,
): ServiceRecord | null {
  return (
    records.find(
      (r) =>
        r.id !== exceptId &&
        r.status !== 'removed' &&
        r.service_date === draft.service_date &&
        r.service_system_node_id === draft.service_system_node_id,
    ) ?? null
  );
}

/** C-GARAGE-05: "This is the third brake job in 2 years" — other records of the category in the last 2 years. */
export function recurringCount(records: readonly ServiceRecord[], systemId: string, dateIso: string): number {
  return records.filter(
    (r) => r.service_system_node_id === systemId && r.status !== 'removed' && Math.abs(daysBetweenIso(r.service_date, dateIso)) <= 730,
  ).length;
}

/** "12.5" / "12" → a Dec<10,2> string, or null. */
export function parseAmount(raw: string): string | null {
  const s = toLatinDigits(raw)
    .replace(/[\s,٬']/g, '')
    .replace('٫', '.');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  return s;
}

// ---------- Documents ----------

export type ExpiryTone = 'expired' | 'soon' | 'ok' | 'none';

/** Documents tab colours: expired red, under 30 days amber (C-GARAGE-02). */
export function expiryTone(expiresAt: string | undefined, todayIso: string): ExpiryTone {
  if (!expiresAt) return 'none';
  const days = daysBetweenIso(todayIso, expiresAt);
  return days < 0 ? 'expired' : days < 30 ? 'soon' : 'ok';
}

/** W-GAR-02: the documents table sorted by nearest expiry; documents without expiry last, newest first. */
export function sortDocuments(docs: readonly VehicleDocument[]): VehicleDocument[] {
  return [...docs]
    .filter((d) => d.status === 'active')
    .sort((a, b) => {
      if (a.expires_at && b.expires_at) return a.expires_at.localeCompare(b.expires_at);
      if (a.expires_at) return -1;
      if (b.expires_at) return 1;
      return b.created_at.localeCompare(a.created_at);
    });
}

export const REMINDER_OFFSETS_DAYS = [7, 14, 30] as const;

// ---------- Reminders ----------

/** Overdue, Due soon, Upcoming (C-GARAGE-02 Reminders); completed and dismissed are not listed. */
export function groupReminders(reminders: readonly MaintenanceReminder[]): {
  overdue: MaintenanceReminder[];
  due: MaintenanceReminder[];
  upcoming: MaintenanceReminder[];
} {
  const live = reminders.filter((r) => r.status !== 'completed' && r.status !== 'dismissed');
  const byDue = (a: MaintenanceReminder, b: MaintenanceReminder) =>
    (a.due_by_date ?? '9999').localeCompare(b.due_by_date ?? '9999') || (a.due_by_mileage_km ?? 0) - (b.due_by_mileage_km ?? 0);
  return {
    overdue: live.filter((r) => r.status === 'overdue').sort(byDue),
    due: live.filter((r) => r.status === 'due').sort(byDue),
    upcoming: live.filter((r) => r.status === 'upcoming').sort(byDue),
  };
}

/** Overview "Upcoming reminders (next 2)". */
export function nextReminders(reminders: readonly MaintenanceReminder[], count = 2): MaintenanceReminder[] {
  const g = groupReminders(reminders);
  return [...g.overdue, ...g.due, ...g.upcoming].slice(0, count);
}

// ---------- Issues ----------

export function isActiveIssue(i: Pick<VehicleIssue, 'status'>): boolean {
  return i.status === 'open' || i.status === 'investigating' || i.status === 'scheduled';
}

/** The safety banner of the Overview: an active issue that is safety-critical or flagged by the safety check. */
export function safetyIssue(issues: readonly VehicleIssue[]): VehicleIssue | null {
  return issues.find((i) => isActiveIssue(i) && (i.urgency_level === 'safety_critical' || i.safety_flag)) ?? null;
}

/** Contract urgency → the design system's urgency style (always icon + word, DI-21). */
export function urgencyStyle(level: VehicleIssue['urgency_level']): 'critical' | 'urgent' | 'soon' | 'ok' {
  return level === 'safety_critical' ? 'critical' : level === 'high' ? 'urgent' : level === 'medium' ? 'soon' : 'ok';
}

export const MIN_ISSUE_DESCRIPTION = 10; // BA-29

// ---------- Ownership transfers (BA-04) ----------

export function pendingTransfers(list: readonly VehicleTransfer[]): { incoming: VehicleTransfer[]; outgoing: VehicleTransfer[] } {
  const pending = list.filter((t) => t.status === 'pending');
  return { incoming: pending.filter((t) => t.direction === 'incoming'), outgoing: pending.filter((t) => t.direction === 'outgoing') };
}
