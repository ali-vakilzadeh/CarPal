// /bff/session, /bff/csrf and the pending-intent store (P2.T7, GD-06). The session view never contains tokens.
import { randomToken } from './crypto';
import { json, problem, readBody } from './http';
import { INTENT_TTL_MS, safeReturnTo } from './oauth/flow';
import type { SessionManager } from './session/manager';
import type { PendingIntent, SessionRecord } from './session/types';

export interface SessionView {
  signed_in: boolean;
  user: { id: string; display_name: string; acr: string; auth_time: number } | null;
  locale: string | null;
  pending_intents: { id: string; type: string; target: string | null; return_to: string }[];
}

export function sessionView(r: SessionRecord | null, now: number): SessionView {
  return {
    signed_in: !!r?.user,
    user: r?.user ? { id: r.user.sub, display_name: r.profile?.displayName ?? '', acr: r.user.acr, auth_time: r.user.authTime } : null,
    locale: r?.locale ?? null,
    pending_intents: (r?.intents ?? [])
      .filter((i) => i.createdAt + INTENT_TTL_MS > now)
      .map((i) => ({ id: i.id, type: i.type, target: i.target ?? null, return_to: i.returnTo })),
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

const MAX_LABEL_CHARS = 160;

/**
 * POST /bff/intents {type, target?, return_to, draft?, label?} → {intent_id} (size-capped, 30 min, at most 5 per
 * session). `label` is the plain-text context line the hosted sign-in shows ("Sign in to follow …", P4.T1).
 */
export async function saveIntent(
  request: Request,
  sessions: SessionManager,
  session: SessionRecord,
  origin: string,
  now: number,
): Promise<Response> {
  const raw = await readBody(request, MAX_INTENT_BYTES);
  if (!raw) return problem(413, 'PAYLOAD_TOO_LARGE');
  let input: { type?: unknown; target?: unknown; return_to?: unknown; draft?: unknown; label?: unknown };
  try {
    input = JSON.parse(new TextDecoder().decode(raw)) as typeof input;
  } catch {
    return problem(400, 'MALFORMED_REQUEST');
  }
  const returnTo = typeof input.return_to === 'string' ? safeReturnTo(input.return_to, origin, '') : '';
  if (typeof input.type !== 'string' || !INTENT_TYPE.test(input.type) || !returnTo) return problem(400, 'MALFORMED_REQUEST');
  if (input.target !== undefined && (typeof input.target !== 'string' || input.target.length > 200))
    return problem(400, 'MALFORMED_REQUEST');
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > MAX_LABEL_CHARS))
    return problem(400, 'MALFORMED_REQUEST');
  const intent: PendingIntent = {
    id: randomToken(16),
    type: input.type,
    returnTo,
    createdAt: now,
    ...(typeof input.target === 'string' ? { target: input.target } : {}),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
    ...(typeof input.label === 'string' && input.label.trim() ? { label: input.label.trim() } : {}),
  };
  const saved = await sessions.update(session.id, (r) => {
    r.intents = [...r.intents.filter((i) => i.createdAt + INTENT_TTL_MS > now), intent].slice(-MAX_INTENTS);
  });
  if (!saved) return problem(401, 'SESSION_ENDED');
  return json({ intent_id: intent.id }, 201);
}

/** POST /bff/intents/<id>/consume → the intent once (with its draft); 404 when unknown, expired or already used. */
export async function consumeIntent(sessions: SessionManager, session: SessionRecord, id: string, now: number): Promise<Response> {
  let found: PendingIntent | undefined;
  await sessions.update(session.id, (r) => {
    found = r.intents.find((i) => i.id === id && i.createdAt + INTENT_TTL_MS > now);
    r.intents = r.intents.filter((i) => i.id !== id);
  });
  if (!found) return problem(404, 'NOT_FOUND');
  return json({ id: found.id, type: found.type, target: found.target ?? null, return_to: found.returnTo, draft: found.draft ?? null });
}
