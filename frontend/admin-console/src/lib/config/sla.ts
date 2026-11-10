// SLA targets of the work queues (AC5.T7, OQ-05 default: the Docs/23 §6 proposals, kept in this console config).
// A timer starts at the item's created_at (or the moment the contract says the clock starts) and ends at the target;
// a privacy request uses the contract's own due_at, a pending four-eyes change its expires_at. Colours: 'ok' until
// WARN_AT of the window has passed, then 'warn' (amber), 'breach' (red) after the target. Working days skip the
// region's weekend in the staff member's time zone; public holidays are not known to the console (OQ-05 note).

export type SlaTarget = { hours: number } | { workingDays: number };
export type SlaState = 'ok' | 'warn' | 'breach';

/** Share of the window after which a timer turns amber. */
export const WARN_AT = 0.75;

/** Weekend days (0 = Sunday … 6 = Saturday). Iran: Friday (the pilot region); change here for another region. */
export const WEEKEND_DAYS: readonly number[] = [5];

/** Docs/23 §6 (proposed for WP0; OQ-05 default). */
export const SLA_TARGETS = {
  verification: { workingDays: 2 },
  reviewApproval: { workingDays: 2 },
  reportUrgent: { hours: 4 },
  reportOther: { hours: 48 },
  inventory: { hours: 48 },
  dispute: { workingDays: 5 },
} as const satisfies Record<string, SlaTarget>;

/** Moderation reasons that get the 4-hour target (Docs/23 §6: unsafe advice, non-consensual media, privacy). */
export const URGENT_REASONS: ReadonlySet<string> = new Set(['unsafe_advice', 'non_consensual_media', 'privacy']);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const weekdayFormat = new Map<string, Intl.DateTimeFormat>();
/** The weekday (0 = Sunday) of an instant in a time zone. */
export function weekdayIn(at: number, timeZone: string): number {
  let f = weekdayFormat.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
    weekdayFormat.set(timeZone, f);
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.format(at));
}

/** start + n working days: whole days are added one by one and a day that lands on a weekend does not count. */
export function addWorkingDays(start: number, n: number, timeZone: string, weekend: readonly number[] = WEEKEND_DAYS): number {
  let at = start;
  let left = n;
  // At most n + 7 days per working week, so the loop always ends (a weekend of 7 days is refused).
  if (weekend.length >= 7) return start + n * DAY;
  while (left > 0) {
    at += DAY;
    if (!weekend.includes(weekdayIn(at, timeZone))) left -= 1;
  }
  return at;
}

/** When the target is reached for a timer that started at `start`. */
export function dueAt(start: number, target: SlaTarget, timeZone: string, weekend: readonly number[] = WEEKEND_DAYS): number {
  return 'hours' in target ? start + target.hours * HOUR : addWorkingDays(start, target.workingDays, timeZone, weekend);
}

/** Where a timer stands now. */
export function slaState(start: number, due: number, now: number): SlaState {
  if (now >= due) return 'breach';
  const window = due - start;
  if (window <= 0) return 'breach';
  return (now - start) / window >= WARN_AT ? 'warn' : 'ok';
}

/** The worse of two states (for a queue: its most urgent item). */
export function worse(a: SlaState, b: SlaState): SlaState {
  const rank: Record<SlaState, number> = { ok: 0, warn: 1, breach: 2 };
  return rank[a] >= rank[b] ? a : b;
}
