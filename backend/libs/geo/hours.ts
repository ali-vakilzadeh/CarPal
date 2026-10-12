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
