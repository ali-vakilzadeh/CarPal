// /bff/session, /bff/csrf and the pending-action store (AC3.T2, AC3.T3), adapted from pwa/src/server/bff/endpoints.ts
// (GD-03). The session view never contains tokens: who is signed in, the staff roles, assurance, language, time zone
// and when the session ends (idle and absolute), so the shell can warn before the 30-minute idle limit.
import { randomToken } from './crypto';
import { json, problem, readBody } from './http';
import { INTENT_TTL_MS, safeReturnTo } from './oauth/flow';
import type { SessionManager } from './session/manager';
import type { Acr, PendingIntent, SessionRecord } from './session/types';
import type { StaffRole } from '@/lib/api/generated';

export interface SessionView {
  signed_in: boolean;
  staff: {
    id: string;
    display_name: string;
    roles: StaffRole[];
    locale: string;
    timezone: string;
    acr: Acr;
    /** ISO time of the last authentication (step-up freshness). */
    auth_time: string;
  } | null;
  /** UI language of this browser's session (also before sign-in). */
  locale: string | null;
  /** ISO: the session ends at this time unless an API call happens before (30-minute idle limit). */
  idle_expires_at: string | null;
  /** ISO: the session ends at this time whatever happens (8 hours after sign-in). */
  expires_at: string | null;
  pending_intents: { id: string; type: string; target: string | null; return_to: string }[];
  /** ISO: the server's clock when this view was made. The shell measures the deadlines against it (AC4.T4), so a
   *  staff PC whose clock is off still warns at 25 minutes. */
  server_time: string;
}

export function sessionView(r: SessionRecord | null, sessions: Pick<SessionManager, 'idleDeadline'>, now: number): SessionView {
  const signedIn = !!(r?.user && r.staff);
  return {
    signed_in: signedIn,
    staff:
      signedIn && r?.user && r.staff
        ? {
            id: r.staff.userId,
            display_name: r.staff.displayName,
            roles: r.staff.roles,
            locale: r.staff.locale,
            timezone: r.staff.timezone,
            acr: r.user.acr,
            auth_time: new Date(r.user.authTime * 1000).toISOString(),
          }
        : null,
    locale: r?.staff?.locale || r?.locale || null,
    idle_expires_at: signedIn && r ? new Date(sessions.idleDeadline(r)).toISOString() : null,
    expires_at: signedIn && r ? new Date(r.absoluteExpiresAt).toISOString() : null,
    pending_intents: signedIn
      ? (r?.intents ?? [])
          .filter((i) => i.createdAt + INTENT_TTL_MS > now)
          .map((i) => ({ id: i.id, type: i.type, target: i.target ?? null, return_to: i.returnTo }))
      : [],
    server_time: new Date(now).toISOString(),
  };
}

/** The synchronizer token for X-CSRF-Token; creates the pre-session when the browser has none yet. */
export async function csrfToken(request: Request, sessions: SessionManager, locale: string): Promise<Response> {
  const existing = await sessions.load(request);
  if (existing) return json({ csrf_token: existing.csrf });
  const fresh = sessions.create(locale);
  await sessions.save(fresh);
  return json({ csrf_token: fresh.csrf }, 200, { 'set-cookie': sessions.cookie(fresh) });
}

const MAX_INTENT_BYTES = 8 * 1024;
const MAX_INTENTS = 5;
const INTENT_TYPE = /^[a-z][a-z0-9_.]{1,59}$/;

/**
 * POST /bff/intents {type, target?, return_to, draft?} → {intent_id}: an action that needs a step-up (GD-11) is saved
 * before /bff/reauth and replayed once after it. Signed-in sessions only; size-capped, 30 min, at most 5. The draft
 * (e.g. the reason note) stays on the server, never in browser storage (GD-12).
 */
export async function saveIntent(
  request: Request,
  sessions: SessionManager,
  session: SessionRecord,
  origin: string,
  now: number,
): Promise<Response> {
  if (!session.user) return problem(401, 'UNAUTHENTICATED');
  const raw = await readBody(request, MAX_INTENT_BYTES);
  if (!raw) return problem(413, 'PAYLOAD_TOO_LARGE');
  let input: { type?: unknown; target?: unknown; return_to?: unknown; draft?: unknown };
  try {
    input = JSON.parse(new TextDecoder().decode(raw)) as typeof input;
  } catch {
    return problem(400, 'MALFORMED_REQUEST');
  }
  const returnTo = typeof input.return_to === 'string' ? safeReturnTo(input.return_to, origin, '') : '';
  if (typeof input.type !== 'string' || !INTENT_TYPE.test(input.type) || !returnTo) return problem(400, 'MALFORMED_REQUEST');
  if (input.target !== undefined && (typeof input.target !== 'string' || input.target.length > 200))
    return problem(400, 'MALFORMED_REQUEST');
  const intent: PendingIntent = {
    id: randomToken(16),
    type: input.type,
    returnTo,
    createdAt: now,
    ...(typeof input.target === 'string' ? { target: input.target } : {}),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
  };
  const saved = await sessions.update(session.id, (r) => {
    r.intents = [...r.intents.filter((i) => i.createdAt + INTENT_TTL_MS > now), intent].slice(-MAX_INTENTS);
  });
  if (!saved) return problem(401, 'SESSION_ENDED');
  return json({ intent_id: intent.id }, 201);
}

/** POST /bff/intents/<id>/consume → the intent once (with its draft); 404 when unknown, expired or already used. */
export async function consumeIntent(sessions: SessionManager, session: SessionRecord, id: string, now: number): Promise<Response> {
  if (!session.user) return problem(401, 'UNAUTHENTICATED');
  let found: PendingIntent | undefined;
  await sessions.update(session.id, (r) => {
    found = r.intents.find((i) => i.id === id && i.createdAt + INTENT_TTL_MS > now);
    r.intents = r.intents.filter((i) => i.id !== id);
  });
  if (!found) return problem(404, 'NOT_FOUND');
  return json({ id: found.id, type: found.type, target: found.target ?? null, return_to: found.returnTo, draft: found.draft ?? null });
}
