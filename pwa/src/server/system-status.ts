// System pages with a real HTTP status (P3.T8, W-SYS-01). App Router pages can only produce 404/403/401
// (notFound/forbidden/unauthorized), so statuses decided before rendering — maintenance 503, and 410/404/403 when a
// cheap check can run in the proxy — are served by rewriting to the internal /<locale>/system/<kind> route with the
// status on the rewrite. The page renders only when the proxy set x-carpal-system (a direct visit is a 404).
import { NextResponse, type NextRequest } from 'next/server';
import { SYSTEM_STATUS, type SystemKind } from '@/lib/system';

export const SYSTEM_HEADER = 'x-carpal-system';
export const MAINTENANCE_UNTIL_HEADER = 'x-carpal-maintenance-until';
/** Retry-After when the maintenance end is unknown. */
export const MAINTENANCE_RETRY_S = 300;

export type Maintenance = { active: false } | { active: true; until: string | null };

/** CARPAL_PWA_MAINTENANCE: empty/off = live; "on" = maintenance without an estimate; an ISO time = until then. */
export function maintenanceOf(value: string | undefined, now = Date.now()): Maintenance {
  const v = (value ?? '').trim();
  if (v === '' || v === 'off' || v === '0') return { active: false };
  if (v === 'on' || v === '1') return { active: true, until: null };
  const at = Date.parse(v);
  if (Number.isNaN(at)) return { active: true, until: null };
  return at > now ? { active: true, until: new Date(at).toISOString() } : { active: false };
}

export function retryAfterSeconds(until: string | null, now = Date.now()): number {
  if (!until) return MAINTENANCE_RETRY_S;
  return Math.max(60, Math.ceil((Date.parse(until) - now) / 1000));
}

/** The rewrite that renders a system page for `request` with the kind's status. */
export function systemRewrite(
  request: NextRequest,
  locale: string,
  kind: SystemKind,
  requestHeaders: Headers,
  o: { until?: string | null } = {},
): NextResponse {
  const headers = new Headers(requestHeaders);
  headers.set(SYSTEM_HEADER, kind);
  headers.set('x-carpal-locale', locale);
  if (o.until) headers.set(MAINTENANCE_UNTIL_HEADER, o.until);
  const target = new URL(`/${locale}/system/${kind}`, request.url);
  const response = NextResponse.rewrite(target, { status: SYSTEM_STATUS[kind], request: { headers } });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex');
  if (kind === 'maintenance') response.headers.set('Retry-After', String(retryAfterSeconds(o.until ?? null)));
  return response;
}
