// Wall-clock time in a time zone as an instant (moved from features/appointments/times.ts for provider plan PW3, so
// the Workshop's answer sheets and the customer's time picker share it without a cross-feature import). Pure.

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
