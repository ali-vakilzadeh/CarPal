// The time window of an audited search (AC13.T1/T3: admin.audit_search, admin.mcp_access_log_search take from/to
// instants, at most 93 days apart, and each search writes an audit row and counts against admin.bulk_read). The console
// sends a search only when staff press Search; the submitted search lives in the URL (window=7, or from/to as calendar
// days on the viewer's clock, both included), so Back and shared links repeat it on purpose.
import { addDays, checkRange, dayIn, daysBetween } from '@/features/analytics';

export const WINDOW_PRESETS = ['1', '7', '30', '90'] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];
export const isWindowPreset = (v: unknown): v is WindowPreset => typeof v === 'string' && (WINDOW_PRESETS as readonly string[]).includes(v);

/** Docs/40: the range is at most 93 days. */
export const MAX_WINDOW_DAYS = 93;

/** Minutes the time zone is ahead of UTC at an instant (Tehran +210). */
export function zoneOffsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return Math.round((asUtc - (at - (at % 1000))) / 60_000);
}

/** The instant a calendar day starts on the viewer's clock. */
export function dayStart(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - zoneOffsetMinutes(guess, timeZone) * 60_000;
  // Once more at the found instant, for days where the offset changes (daylight saving).
  return guess - zoneOffsetMinutes(first, timeZone) * 60_000;
}

export type SearchWindow = { kind: 'preset'; preset: WindowPreset } | { kind: 'days'; from: string; to: string };

export interface Instants {
  from: string;
  to: string;
}

/** The instants of a window: a preset ends now; typed days run from the first day's start to the end of the last. */
export function instantsOf(w: SearchWindow, now: number, timeZone: string): Instants {
  if (w.kind === 'preset') return { from: new Date(now - Number(w.preset) * 86_400_000).toISOString(), to: new Date(now).toISOString() };
  return { from: new Date(dayStart(w.from, timeZone)).toISOString(), to: new Date(dayStart(addDays(w.to, 1), timeZone)).toISOString() };
}

export type WindowProblem = 'format' | 'order' | 'tooLong';

export function checkWindow(from: string, to: string): WindowProblem | null {
  const p = checkRange(from, to);
  if (p === 'tooLong' || (p === null && daysBetween(from, to) + 1 > MAX_WINDOW_DAYS)) return 'tooLong';
  return p;
}

/** The window in URL parameters (window=…, or from/to), or null when none was submitted. */
export function windowFromParams(params: URLSearchParams): SearchWindow | null {
  const w = params.get('window');
  if (isWindowPreset(w)) return { kind: 'preset', preset: w };
  const from = params.get('from');
  const to = params.get('to');
  if (from && to && checkWindow(from, to) === null) return { kind: 'days', from, to };
  return null;
}

export function windowParams(w: SearchWindow): Record<string, string> {
  return w.kind === 'preset' ? { window: w.preset } : { from: w.from, to: w.to };
}

/** Default typed days: the last 7 days with today. */
export function defaultDays(now: number, timeZone: string): { from: string; to: string } {
  const to = dayIn(now, timeZone);
  return { from: addDays(to, -6), to };
}
