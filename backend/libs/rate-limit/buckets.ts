// Rate-limit buckets of 40 §2.8 as configuration (tunable without a contract
// change; CARPAL_RATE_LIMITS overrides whole buckets).
//
// Scopes the pipeline resolves itself: principal (user or anonymous token),
// user, anon (anonymous callers only), org (path organization), org_or_user,
// ip (/24, /56 prefix), staff, device. Scopes that need request data
// (account, destination, author, subject, bytes) are consumed by the use case
// through RateLimiter.consume() with an explicit key.

export type PipelineScope = 'principal' | 'user' | 'anon' | 'org' | 'org_or_user' | 'ip' | 'staff' | 'device';
export type UseCaseScope = 'account' | 'destination' | 'author' | 'subject' | 'bytes';
export type Scope = PipelineScope | UseCaseScope;

export interface Window {
  limit: number;
  windowMs: number;
  scope: Scope;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_BUCKETS: Record<string, Window[]> = {
  'default.read': [{ limit: 300, windowMs: MIN, scope: 'principal' }],
  'default.write': [{ limit: 60, windowMs: MIN, scope: 'user' }],
  'public.read': [
    { limit: 120, windowMs: MIN, scope: 'anon' },
    { limit: 3_000, windowMs: DAY, scope: 'anon' },
    { limit: 600, windowMs: MIN, scope: 'ip' },
  ],
  'auth.signin': [
    { limit: 5, windowMs: 15 * MIN, scope: 'account' },
    { limit: 30, windowMs: 15 * MIN, scope: 'ip' },
  ],
  'auth.otp': [
    { limit: 3, windowMs: HOUR, scope: 'destination' },
    { limit: 5, windowMs: DAY, scope: 'destination' },
    { limit: 20, windowMs: HOUR, scope: 'ip' },
  ],
  search: [
    { limit: 30, windowMs: MIN, scope: 'user' },
    { limit: 10, windowMs: MIN, scope: 'anon' },
    { limit: 500, windowMs: DAY, scope: 'anon' },
  ],
  map: [{ limit: 60, windowMs: MIN, scope: 'principal' }],
  'geo.business': [{ limit: 30, windowMs: HOUR, scope: 'org' }],
  upload: [
    { limit: 60, windowMs: HOUR, scope: 'user' },
    { limit: 2 * 1024 * 1024 * 1024, windowMs: DAY, scope: 'bytes' },
  ],
  'review.create': [
    { limit: 5, windowMs: DAY, scope: 'author' },
    { limit: 1, windowMs: 30 * DAY, scope: 'subject' },
  ],
  'review.invite': [
    { limit: 50, windowMs: DAY, scope: 'org' },
    { limit: 300, windowMs: 30 * DAY, scope: 'org' },
  ],
  'inquiry.create': [{ limit: 20, windowMs: DAY, scope: 'user' }],
  'appointment.request': [{ limit: 10, windowMs: DAY, scope: 'user' }],
  'report.create': [{ limit: 20, windowMs: DAY, scope: 'user' }],
  'ai.user': [
    { limit: 20, windowMs: HOUR, scope: 'user' },
    { limit: 100, windowMs: DAY, scope: 'user' },
  ],
  // Default; the plan entitlement may set another daily limit (use case passes it).
  'ai.org': [{ limit: 200, windowMs: DAY, scope: 'org' }],
  export: [{ limit: 10, windowMs: DAY, scope: 'org_or_user' }],
  events: [{ limit: 60, windowMs: MIN, scope: 'device' }],
  'admin.default': [{ limit: 300, windowMs: MIN, scope: 'staff' }],
  'admin.bulk_read': [{ limit: 20, windowMs: MIN, scope: 'staff' }],
};

export const PIPELINE_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'principal',
  'user',
  'anon',
  'org',
  'org_or_user',
  'ip',
  'staff',
  'device',
]);

export function loadBuckets(overridesJson: string | undefined, scale: number): Record<string, Window[]> {
  const buckets: Record<string, Window[]> = { ...DEFAULT_BUCKETS };
  if (overridesJson) {
    const parsed = JSON.parse(overridesJson) as Record<string, Window[]>;
    for (const [name, windows] of Object.entries(parsed)) {
      if (!Array.isArray(windows) || windows.some((w) => !(w.limit > 0 && w.windowMs > 0 && typeof w.scope === 'string'))) {
        throw new Error(`CARPAL_RATE_LIMITS: invalid bucket ${name}`);
      }
      buckets[name] = windows;
    }
  }
  if (scale !== 1) {
    for (const [name, windows] of Object.entries(buckets))
      buckets[name] = windows.map((w) => ({ ...w, limit: Math.max(1, Math.round(w.limit * scale)) }));
  }
  return buckets;
}
