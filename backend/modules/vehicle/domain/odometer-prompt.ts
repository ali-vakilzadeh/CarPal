// Monthly odometer prompt (backend S26b, DQ-24; Docs/21 C-GARAGE-08). Pure rules; the sweep is odometer-prompt-rule.ts.
//   Cycle: it starts at the newest reading by recorded_at (the vehicle's creation when it has none) or at the owner's
//   last skip, whichever is later. The owner is asked once the cycle is `odometer_prompt_days` old. An open prompt
//   ends with a reading that is the newest by recorded_at (a database trigger clears it) or with a skip; an ignored
//   prompt is asked again `odometer_prompt_days` after it, not before.

/** The region's time zone for "the digest hour" (the pilot region; the work SLAs and discovery use the same). */
export const PROMPT_TIME_ZONE = 'Asia/Tehran';

/** Hour (0-23) of `at` on the region's clock. */
export function regionHour(at: Date, timeZone = PROMPT_TIME_ZONE): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at);
  return Number(h);
}

export interface PromptFacts {
  /** recorded_at of the newest reading, or null when the vehicle has none. */
  newestReadingAt: Date | null;
  createdAt: Date;
  skippedAt: Date | null;
  promptedAt: Date | null;
}

const DAY_MS = 86_400_000;

/** Start of the current cycle. */
export function cycleStart(f: PromptFacts): Date {
  const base = f.newestReadingAt ?? f.createdAt;
  return f.skippedAt && f.skippedAt > base ? f.skippedAt : base;
}

/** When the owner is next due to be asked (null: the prompt is off). */
export function nextDue(f: PromptFacts, days: number): Date | null {
  return days > 0 ? new Date(cycleStart(f).getTime() + days * DAY_MS) : null;
}

/** The sweep asks now: the cycle is old enough and the owner was not asked in the last `days` days. */
export function shouldPrompt(f: PromptFacts, days: number, now: Date): boolean {
  const due = nextDue(f, days);
  if (!due || due > now) return false;
  return f.promptedAt === null || f.promptedAt.getTime() + days * DAY_MS <= now.getTime();
}

/** Vehicle.odometer_prompt: an open prompt (asked, and neither answered nor skipped since). */
export function promptView(promptedAt: Date | null): { due: boolean; due_since: string | null } {
  return { due: promptedAt !== null, due_since: promptedAt ? promptedAt.toISOString() : null };
}
