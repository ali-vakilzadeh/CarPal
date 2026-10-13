// Opening hours (40 HoursSpec): whether a location is open at a moment in
// its own time zone. Shared by the organization module (PublicLocation) and
// discovery (search cards and map pins computed from the index, S6).

export interface HoursSpec {
  weekly: { day_of_week: number; open: string; close: string }[];
  exceptions?: { date: string; closed: boolean; open?: string; close?: string }[];
}

/**
 * Whether a location is open at `now` in its time zone (40 PublicLocation.open_now):
 * a dated exception wins over the weekly hours. day_of_week 0 = Sunday … 6 = Saturday.
 * Null when no hours are set.
 */
export function openNow(h: HoursSpec | null | undefined, timezone: string, now: Date): boolean | null {
  if (!h) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  const exception = h.exceptions?.find((e) => e.date === date);
  if (exception) return !exception.closed && !!exception.open && !!exception.close && exception.open <= time && time < exception.close;
  return h.weekly.some((w) => w.day_of_week === day && w.open <= time && time < w.close);
}

const PARTS = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = PARTS.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    PARTS.set(timezone, f);
  }
  return f;
}

/** Wall-clock date (YYYY-MM-DD), time (HH:MM) and weekday (0 = Sunday) of an instant in a time zone. */
export function localParts(at: Date, timezone: string): { date: string; time: string; dayOfWeek: number } {
  const p = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

/** Offset of a time zone at an instant, in ms (local − UTC). */
function offsetMs(at: Date, timezone: string): number {
  const p = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant of a wall-clock date and time (HH:MM or HH:MM:SS) in a time
 * zone. A time skipped by a DST change resolves to the later offset.
 */
export function zonedToUtc(date: string, time: string, timezone: string): Date {
  const [h = 0, m = 0, s = 0] = time.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, m, s);
  let t = guess - offsetMs(new Date(guess), timezone);
  const second = guess - offsetMs(new Date(t), timezone);
  if (second !== t) t = second;
  return new Date(t);
}

/** YYYY-MM-DD plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
