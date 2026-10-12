// Vehicle rules without I/O: profile completeness, the vehicle-limit
// statuses (52 §21), reminder status by date and mileage (W15 hourly rule),
// issue transitions (40 §12.2) and the dates the contract restricts.

/** 52 §21: active and in_repair vehicles count toward max_vehicles. */
export const COUNTING_STATUSES = ['active', 'in_repair'] as const;
export const counts = (status: string): boolean => (COUNTING_STATUSES as readonly string[]).includes(status);

export interface CompletenessFacts {
  vinPresent: boolean;
  licensePlate: boolean;
  nickname: boolean;
  series: boolean;
  engineType: boolean;
  fuelType: boolean;
  transmission: boolean;
  bodyStyle: boolean;
  color: boolean;
  mileage: boolean;
  ownershipStart: boolean;
  photo: boolean;
}

/**
 * Vehicle.profile_completeness (52 S, Plan WP5 "profile completeness"): no
 * weights are specified, so every criterion counts the same; brand, model
 * and year are required and count as one met criterion.
 */
export function profileCompleteness(f: CompletenessFacts): number {
  const met = Object.values(f).filter(Boolean).length + 1;
  return Math.round((100 * met) / (Object.keys(f).length + 1));
}

/** 52 Vehicle.year: 1950 to the current year + 2. */
export const maxModelYear = (now = new Date()): number => now.getUTCFullYear() + 2;

export const todayUtc = (now = new Date()): string => now.toISOString().slice(0, 10);

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ReminderStatus = 'upcoming' | 'due' | 'overdue' | 'completed' | 'dismissed';

/** A reminder becomes due this many days or kilometres before its target. */
export const DUE_WINDOW_DAYS = 14;
export const DUE_WINDOW_KM = 500;

export interface ReminderState {
  status: ReminderStatus;
  due_by_date: string | null;
  due_by_mileage_km: number | null;
  snoozed_until: string | null;
}

/**
 * Status of an open reminder (upcoming → due → overdue) from its due date
 * and mileage and the vehicle's current mileage. Completed and dismissed
 * reminders keep their status; a snoozed reminder stays upcoming until the
 * snooze ends.
 */
export function reminderStatus(r: ReminderState, mileage: number | null, today: string): ReminderStatus {
  if (r.status === 'completed' || r.status === 'dismissed') return r.status;
  if (r.snoozed_until && r.snoozed_until > today) return 'upcoming';
  const km = r.due_by_mileage_km;
  if ((r.due_by_date && r.due_by_date < today) || (km !== null && mileage !== null && mileage >= km)) return 'overdue';
  if (
    (r.due_by_date && r.due_by_date <= addDays(today, DUE_WINDOW_DAYS)) ||
    (km !== null && mileage !== null && mileage >= km - DUE_WINDOW_KM)
  )
    return 'due';
  return 'upcoming';
}

/** Document expiry reminders are created this many days ahead (W15). */
export const DOCUMENT_EXPIRY_NOTICE_DAYS = 30;

export type IssueStatus = 'open' | 'investigating' | 'scheduled' | 'resolved' | 'cancelled';

/** issues.status_change: scheduled is set by appointments (S7); resolved and cancelled are final. */
const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ['investigating', 'resolved', 'cancelled'],
  investigating: ['resolved', 'cancelled'],
  scheduled: ['investigating', 'resolved', 'cancelled'],
  resolved: [],
  cancelled: [],
};

export const issueTransitionAllowed = (from: string, to: string): boolean =>
  (ISSUE_TRANSITIONS[from as IssueStatus] ?? []).includes(to as IssueStatus);

export const issueOpen = (status: string): boolean => status === 'open' || status === 'investigating' || status === 'scheduled';
