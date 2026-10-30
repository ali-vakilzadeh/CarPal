// Preferred time windows of an appointment request (P10.T3/T4; Docs/22 W-HELP-01 "a calendar grid of the provider's
// available slots for the next 14 days to pick up to 3 windows"; Docs/40 TimeWindowInput: future, end after start,
// ≤ 30 days ahead, ≤ 5). Used by the request step and by "Suggest another time" on W-APP-01. A shop without published
// slots (no availability rules, BA-19) still takes requests: the user then picks a day and a part of the day, read as
// wall-clock time at the shop. Pure functions.
import type { Slot, TimeWindowInput } from '@carpal/api-contracts';
import { addDaysIso, todayIso } from '@/lib/format/jalali';

export const MAX_WINDOWS = 3;
export const GRID_DAYS = 14;
/** Parts of the day for "Request anyway" (local time at the shop). */
export const DAY_PARTS = { morning: [9, 12], afternoon: [12, 16], evening: [16, 19] } as const;
export type DayPart = keyof typeof DAY_PARTS;

/** Offset of a time zone from UTC at an instant, in ms. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(utcMs)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcMs;
}

/** A wall-clock time at the shop (ISO date + hour) as an ISO instant. */
export function zonedToUtc(date: string, hour: number, timeZone: string, minute = 0): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let t = guess - zoneOffset(guess, timeZone);
  const again = zoneOffset(t, timeZone);
  if (guess - again !== t) t = guess - again;
  return new Date(t).toISOString();
}

export interface GridDay {
  /** ISO calendar date at the shop. */
  date: string;
  slots: Slot[];
}

/** The 14 days from today at the shop, each with its open future slots in time order (days without slots stay). */
export function slotGrid(slots: readonly Slot[], timeZone: string, now = Date.now(), days = GRID_DAYS): GridDay[] {
  const today = todayIso(timeZone, now);
  const grid: GridDay[] = Array.from({ length: days }, (_, i) => ({ date: addDaysIso(today, i), slots: [] }));
  const byDate = new Map(grid.map((d) => [d.date, d]));
  for (const s of [...slots].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))) {
    if (Date.parse(s.start_at) <= now) continue;
    byDate.get(todayIso(timeZone, Date.parse(s.start_at)))?.slots.push(s);
  }
  return grid;
}

export type WindowChoice = { kind: 'slot'; start: string; end: string } | { kind: 'part'; date: string; part: DayPart };

export function choiceKey(c: WindowChoice): string {
  return c.kind === 'slot' ? `slot:${new Date(c.start).toISOString()}` : `part:${c.date}:${c.part}`;
}

/** Adds or removes a choice; at most 3, in the order picked (the priority). */
export function toggleChoice(list: readonly WindowChoice[], c: WindowChoice): WindowChoice[] {
  const key = choiceKey(c);
  if (list.some((x) => choiceKey(x) === key)) return list.filter((x) => choiceKey(x) !== key);
  return list.length >= MAX_WINDOWS ? [...list] : [...list, c];
}

/** TimeWindowInput list (priority 1-3 in the order picked); windows already in the past are dropped. */
export function windowsOf(choices: readonly WindowChoice[], timeZone: string, now = Date.now()): TimeWindowInput[] {
  return choices
    .map((c) => {
      if (c.kind === 'slot') return { start_at: new Date(c.start).toISOString(), end_at: new Date(c.end).toISOString() };
      const [from, to] = DAY_PARTS[c.part];
      return { start_at: zonedToUtc(c.date, from, timeZone), end_at: zonedToUtc(c.date, to, timeZone) };
    })
    .filter((w) => Date.parse(w.start_at) > now)
    .map((w, i) => ({ ...w, priority: i + 1 }));
}

/** A slot picked elsewhere (the profile's Request card): the matching published slot, else a one-hour window. */
export function choiceFromSlot(start: string, slots: readonly Slot[]): WindowChoice {
  const t = Date.parse(start);
  const hit = slots.find((s) => Date.parse(s.start_at) === t);
  return { kind: 'slot', start: new Date(t).toISOString(), end: hit ? hit.end_at : new Date(t + 3_600_000).toISOString() };
}
