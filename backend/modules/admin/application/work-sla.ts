// SLA states of work-queue items for admin.work_summary (backend S21, BR-22; Docs/23 §6 targets, OQ-05 defaults).
// The arithmetic is the admin console's (src/lib/config/sla.ts) so both show the same states: an item is 'warn' once
// 75 % of its window has passed and 'breach' at its target; working days are added one whole day at a time and a day
// that lands on the region's weekend does not count, on the caller's clock. Public holidays are not known.
import type { SlaTarget, WorkItem } from '../interface/admin.js';

export type SlaState = 'ok' | 'warn' | 'breach';

/** Share of the window after which a timer turns amber (console WARN_AT). */
export const WARN_AT = 0.75;

/** The pilot region's weekend (Iran: Friday; 0 = Sunday … 6 = Saturday), as the console's WEEKEND_DAYS. */
export const WEEKEND_DAYS: readonly number[] = [5];

/** The clock used without CarPal-Timezone: the pilot region's. */
export const DEFAULT_WORK_TIME_ZONE = 'Asia/Tehran';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formats = new Map<string, Intl.DateTimeFormat>();
/** The weekday (0 = Sunday) of an instant in a time zone. */
export function weekdayIn(at: number, timeZone: string): number {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
    formats.set(timeZone, f);
  }
  return WEEKDAYS.indexOf(f.format(at));
}

/** start + n working days: whole days are added one by one and a day that lands on a weekend does not count. */
export function addWorkingDays(start: number, n: number, timeZone: string, weekend: readonly number[] = WEEKEND_DAYS): number {
  if (weekend.length >= 7) return start + n * DAY;
  let at = start;
  let left = n;
  while (left > 0) {
    at += DAY;
    if (!weekend.includes(weekdayIn(at, timeZone))) left -= 1;
  }
  return at;
}

/** When the target is reached for a clock that started at `start`. */
export function dueAt(start: number, target: SlaTarget, timeZone: string, weekend: readonly number[] = WEEKEND_DAYS): number {
  if ('at' in target) return target.at.getTime();
  return 'hours' in target ? start + target.hours * HOUR : addWorkingDays(start, target.workingDays, timeZone, weekend);
}

/** Where a timer stands now. */
export function slaState(start: number, due: number, now: number): SlaState {
  if (now >= due) return 'breach';
  const window = due - start;
  if (window <= 0) return 'breach';
  return (now - start) / window >= WARN_AT ? 'warn' : 'ok';
}

/** Docs/23 §6 reasons with the 4-hour target (the severity floor reasons). */
const URGENT_REASONS = new Set(['unsafe_advice', 'non_consensual_media', 'privacy']);

/**
 * Docs/23 §6 target of a moderation case or a report waiting for triage (the console's caseTarget): safety reasons
 * and critical cases 4 hours, reviews 24 hours, inventory and other content 48 hours. Reports have no severity.
 */
export function moderationTarget(reason: string, severity: string | null, targetType: string): SlaTarget {
  if (URGENT_REASONS.has(reason) || severity === 'critical') return { hours: 4 };
  return { hours: targetType === 'review' ? 24 : 48 };
}

/** 40 WorkQueueSummary without the queue key: what admin.work_summary says about one queue. */
export interface QueueFigures {
  open: number;
  assigned_to_me: number | null;
  oldest_at: string | null;
  next_due_at: string | null;
  sla: { ok: number; warn: number; breach: number; paused: number } | null;
  breakdown: { key: string; open: number }[];
}

/** Summarizes a queue's items: `open` is the exact count, the rest is computed over the items read. */
export function summarize(
  open: number,
  items: readonly WorkItem[],
  o: { now: number; timeZone: string; assignable: boolean; timed: boolean },
): QueueFigures {
  const sla = o.timed ? { ok: 0, warn: 0, breach: 0, paused: 0 } : null;
  let oldest: number | null = null;
  let nextDue: number | null = null;
  let mine = 0;
  const breakdown = new Map<string, number>();
  for (const item of items) {
    const start = item.startedAt.getTime();
    oldest = oldest === null ? start : Math.min(oldest, start);
    if (item.mine) mine += 1;
    for (const k of item.keys ?? []) breakdown.set(k, (breakdown.get(k) ?? 0) + 1);
    if (!sla || !item.target) continue;
    if (item.paused) {
      sla.paused += 1;
      continue;
    }
    const due = dueAt(start, item.target, o.timeZone);
    nextDue = nextDue === null ? due : Math.min(nextDue, due);
    sla[slaState(start, due, o.now)] += 1;
  }
  return {
    open,
    assigned_to_me: o.assignable ? mine : null,
    oldest_at: oldest === null ? null : new Date(oldest).toISOString(),
    next_due_at: nextDue === null ? null : new Date(nextDue).toISOString(),
    sla,
    breakdown: [...breakdown.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 100)
      .map(([key, n]) => ({ key, open: n })),
  };
}
