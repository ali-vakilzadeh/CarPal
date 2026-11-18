// Suspension durations (AC10.T0/T2, Docs/23 A-USR-02 Suspend "duration", Docs/40 admin.user_status and admin.case_action
// suspend_account `suspend_until`). Since backend S14 (BR-07) a suspension with an end is lifted by the scheduler once
// the end has passed (StaffUserView.suspended_until), so the console offers fixed durations; "until reactivated" sends
// no end. AC8 suspended without an end (D-52).

export const SUSPEND_DURATIONS = ['until_reactivated', '1d', '3d', '7d', '30d'] as const;
export type SuspendDuration = (typeof SUSPEND_DURATIONS)[number];

const DAYS: Record<Exclude<SuspendDuration, 'until_reactivated'>, number> = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 };

export function isSuspendDuration(v: string): v is SuspendDuration {
  return (SUSPEND_DURATIONS as readonly string[]).includes(v);
}

/** The end of a suspension of this duration from `now` (ISO, whole minute), or null for "until reactivated". */
export function suspendUntil(duration: SuspendDuration, now: number = Date.now()): string | null {
  if (duration === 'until_reactivated') return null;
  const end = new Date(now + DAYS[duration] * 86_400_000);
  end.setUTCSeconds(0, 0);
  return end.toISOString();
}
