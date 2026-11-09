// The admin BFF's OAuth client (AC3.T3), adapted from pwa/src/server/bff/oauth/flow.ts (GD-03):
//   /bff/login           authorization code + PKCE at aal3 through the console's own sign-in (/id/oauth/authorize,
//                        proxied to the auth host, GD-04)
//   /bff/reauth          step-up for an AAL3/STEP_UP action (GD-11): prompt=login, and the same staff member must sign
//                        in again; the browser comes back to the pending action
//   /bff/login/restart   the sign-in page's "Start again" after its interaction expired, with the same return path
//   /bff/oauth/callback  checks state and issuer, exchanges the code server-to-server (DPoP-bound, private_key_jwt),
//                        verifies the ID token, demands aal3, loads admin.staff_me and rotates the session id
//   /bff/logout          revokes the refresh token and drops the session
// Not taken over from the PWA: sign-up screens, gated-action labels on the sign-in page, "Keep me signed in".
import { redirectUri, type BffConfig } from '../config';
import { createPkce, randomToken, timingSafeEqual } from '../crypto';
import { json, parseCookies, problem, redirect } from '../http';
import type { SessionManager } from '../session/manager';
import type { Acr, PendingLogin, SessionRecord } from '../session/types';
import { loadStaffProfile, type StaffFetch } from '../staff';
import { generateDpopKey } from './dpop';
import type { TokenClient, TokenResponse } from './token-client';

export interface FlowDeps {
  config: BffConfig;
  sessions: SessionManager;
  client: TokenClient;
  fetch: typeof fetch;
  now: () => number;
}

/** A sign-in started more than this long ago is forgotten (the auth host's interaction cookie lasts 30 min). */
export const LOGIN_TTL_MS = 30 * 60_000;
/** An expired sign-in is remembered this long only so /bff/login/restart can start it again with the same return path. */
export const LOGIN_RESTART_MS = 2 * 3_600_000;
const MAX_PENDING_LOGINS = 5;
/** A step-up must produce an authentication at least this recent (clock skew between the hosts). */
const STEP_UP_SKEW_S = 5;
const INTENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const INTENT_TTL_MS = 30 * 60_000;
/** Path prefixes that are never a return destination: the BFF, the API forwarder and the sign-in pages. */
const NOT_A_DESTINATION = ['/bff', '/api', '/id'];
export const isAcr = (v: unknown): v is Acr => v === 'aal1' || v === 'aal2' || v === 'aal3';

/**
 * A return path is a same-origin path: it starts with one '/', has no scheme or authority, no backslash and no control
 * characters, and resolves to the console origin. The BFF's own endpoints, the API and the sign-in pages are never a
 * destination (no login loops, no logout by redirect). Anything else becomes `fallback`.
 */
export function safeReturnTo(value: string | null, origin: string, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some((c) => c < ' ' || c === '\x7f'))
    return fallback;
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin) return fallback;
    if (NOT_A_DESTINATION.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`))) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}

/** The sign-in page's language: the console's language cookie, else Accept-Language, else the default. */
export function uiLocale(request: Request, config: Pick<BffConfig, 'locales' | 'localeCookie'>, fallback?: string): string {
  const cookie = parseCookies(request.headers.get('cookie')).get(config.localeCookie);
  if (cookie && config.locales.includes(cookie)) return cookie;
  for (const part of (request.headers.get('accept-language') ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase().split('-')[0]!;
    if (config.locales.includes(tag)) return tag;
  }
  return fallback && config.locales.includes(fallback) ? fallback : config.locales[0]!;
}

interface LoginOptions {
  returnTo: string;
  stepUp?: boolean;
  intentId?: string;
}

/** GET /bff/login?return_to=… */
export async function login(request: Request, d: FlowDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const existing = await d.sessions.load(request);
  return startLogin(request, existing, { returnTo: safeReturnTo(q.get('return_to'), d.config.origin) }, d);
}

/**
 * GET /bff/reauth?return_to=…[&intent=…] — a fresh aal3 sign-in for an action that needs one (GD-11). Only for a signed-in
 * session: without one it is an ordinary sign-in.
 */
export async function reauth(request: Request, d: FlowDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const existing = await d.sessions.load(request);
  const intentId = q.get('intent');
  return startLogin(
    request,
    existing,
    {
      returnTo: safeReturnTo(q.get('return_to'), d.config.origin),
      stepUp: !!existing?.user,
      ...(intentId && INTENT_ID.test(intentId) ? { intentId } : {}),
    },
    d,
  );
}

/** GET /bff/login/restart?state=… — a new sign-in with the return path (and step-up) of the expired one. */
export async function restartLogin(request: Request, d: FlowDeps): Promise<Response> {
  const existing = await d.sessions.load(request);
  const state = new URL(request.url).searchParams.get('state') ?? '';
  const old = existing?.logins.find((l) => l.createdAt + LOGIN_RESTART_MS > d.now() && timingSafeEqual(l.state, state));
  if (!old) return startLogin(request, existing, { returnTo: '/' }, d);
  return startLogin(
    request,
    existing,
    {
      returnTo: old.returnTo,
      ...(old.stepUp && existing?.user ? { stepUp: true } : {}),
      ...(old.intentId ? { intentId: old.intentId } : {}),
    },
    d,
  );
}

async function startLogin(request: Request, existing: SessionRecord | null, o: LoginOptions, d: FlowDeps): Promise<Response> {
  const pkce = await createPkce();
  const pending: PendingLogin = {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: pkce.verifier,
    returnTo: o.returnTo,
    createdAt: d.now(),
    ...(o.stepUp ? { stepUp: true } : {}),
    ...(o.intentId ? { intentId: o.intentId } : {}),
  };
  const locale = uiLocale(request, d.config, existing?.staff?.locale ?? existing?.locale);
  const addLogin = (r: SessionRecord) => {
    r.logins = [...r.logins.filter((l) => l.createdAt + LOGIN_RESTART_MS > d.now()), pending].slice(-MAX_PENDING_LOGINS);
    r.locale = locale;
  };
  let setCookie: string | undefined;
  // Starting a sign-in is not activity: a signed-in session's idle deadline does not move.
  if (!existing || !(await d.sessions.update(existing.id, addLogin, { activity: !existing.user }))) {
    const fresh = d.sessions.create(locale);
    addLogin(fresh);
    await d.sessions.save(fresh);
    setCookie = d.sessions.cookie(fresh);
  }

  const authorize = new URL(`${d.config.origin}/id/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: d.config.clientId,
    redirect_uri: redirectUri(d.config),
    scope: 'openid offline_access',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    // SEC-ADM-2: staff sign in with a device-bound passkey, every time.
    acr_values: 'aal3',
    ui_locales: locale,
  };
  // Step-up: credentials again even though the auth host remembers this browser's sign-in (the auth host's authorize
  // takes no max_age; prompt=login always means a new authentication, BA-11).
  if (pending.stepUp) params.prompt = 'login';
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);
  return redirect(authorize.toString(), 303, setCookie ? { 'set-cookie': setCookie } : undefined);
}

/**
 * Where a sign-in ended without a session: `expired` (no pre-session or pending sign-in), `state` (unknown state),
 * `issuer` (mix-up), `cancelled`, `failed`, `step_up` (not a fresh aal3), `account` (a step-up by another staff member),
 * `not_staff` (the account has no staff role, or admin.staff_me refused the token).
 */
export type SigninOutcome = 'expired' | 'state' | 'issuer' | 'cancelled' | 'failed' | 'step_up' | 'account' | 'not_staff';

/** Back to the page with ?signin=<outcome>; the sign-in pages (AC4) show the message. Never carries codes or tokens. */
function back(returnTo: string, outcome: SigninOutcome, origin: string): Response {
  const u = new URL(returnTo, origin);
  u.searchParams.set('signin', outcome);
  return redirect(`${u.pathname}${u.search}${u.hash}`, 303);
}

export async function callback(request: Request, d: FlowDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const session = await d.sessions.load(request);
  if (!session) return back('/', 'expired', d.config.origin);
  const state = q.get('state') ?? '';
  const pending = session.logins.find((l) => l.createdAt + LOGIN_TTL_MS > d.now() && timingSafeEqual(l.state, state));
  if (!pending) return back('/', 'state', d.config.origin);
  // One use per state, whatever the outcome.
  await d.sessions.update(
    session.id,
    (r) => {
      r.logins = r.logins.filter((l) => l.state !== pending.state);
    },
    { activity: false },
  );

  const error = q.get('error');
  if (error)
    return back(pending.returnTo, error === 'access_denied' || error === 'login_required' ? 'cancelled' : 'failed', d.config.origin);
  const code = q.get('code');
  if (!code) return back(pending.returnTo, 'failed', d.config.origin);

  let tokens: TokenResponse;
  let claims: Record<string, unknown>;
  // A key of its own per sign-in (also per step-up: the old tokens are revoked below).
  const dpopKey = await generateDpopKey();
  try {
    const { issuer } = await d.client.discovery();
    // RFC 9207: the authorization response names its issuer (mix-up defence).
    const iss = q.get('iss');
    if (iss !== null && iss !== issuer) return back(pending.returnTo, 'issuer', d.config.origin);
    tokens = await d.client.authorizationCode(d.config.clientId, {
      code,
      redirectUri: redirectUri(d.config),
      verifier: pending.verifier,
      dpopKey,
    });
    if (!tokens.id_token || !tokens.refresh_token) throw new Error('token response without id_token or refresh_token');
    claims = await d.client.verifyIdToken(tokens.id_token, { clientId: d.config.clientId, nonce: pending.nonce });
  } catch {
    return back(pending.returnTo, 'failed', d.config.origin);
  }
  const drop = async (outcome: SigninOutcome) => {
    await d.client.revoke(d.config.clientId, tokens.refresh_token!, 'refresh_token').catch(() => undefined);
    return back(pending.returnTo, outcome, d.config.origin);
  };
  const acr = isAcr(claims.acr) ? claims.acr : 'aal1';
  const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : 0;
  const sub = String(claims.sub ?? '');
  // SEC-ADM-2: a staff session is aal3, always. A step-up must also be a new authentication of the same person.
  if (acr !== 'aal3') return drop('step_up');
  if (pending.stepUp) {
    if (authTime < Math.floor(pending.createdAt / 1000) - STEP_UP_SKEW_S) return drop('step_up');
    if (session.user && session.user.sub !== sub) return drop('account');
  }

  const bound = tokens.token_type === 'DPoP';
  const staffFetch: StaffFetch = { config: d.config, fetch: d.fetch };
  const staff = await loadStaffProfile(tokens.access_token, bound ? dpopKey : undefined, staffFetch);
  if (!staff || staff.roles.length === 0 || staff.userId !== sub) return drop('not_staff');

  // A previous sign-in of this browser (re-login, step-up) leaves no orphan session on the auth server.
  if (session.user) await d.client.revoke(d.config.clientId, session.user.refreshToken, 'refresh_token').catch(() => undefined);
  const next = await d.sessions.rotate(session, (r) => {
    r.user = {
      accessToken: tokens.access_token,
      accessExpiresAt: d.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token!,
      sub,
      sid: String(claims.sid ?? ''),
      acr,
      authTime,
      scope: tokens.scope,
      bound,
    };
    r.dpopKey = dpopKey;
    r.staff = staff;
    r.locale = staff.locale || session.locale || d.config.locales[0]!;
    r.absoluteExpiresAt = Math.min(r.absoluteExpiresAt, staff.sessionExpiresAt);
    // A step-up keeps the action saved for it; a first sign-in starts clean.
    r.intents = pending.stepUp ? session.intents.filter((i) => i.createdAt + INTENT_TTL_MS > d.now()) : [];
  });
  const headers = new Headers({ 'set-cookie': d.sessions.cookie(next) });
  const language = staffLocaleCookie(request, staff.locale, d.config);
  if (language) headers.append('set-cookie', language);
  return redirect(pending.returnTo, 303, headers);
}

/**
 * GD-05 (AC4): the console speaks the staff member's language (admin.staff_me locale) from the first sign-in on. Only
 * when this browser has no language choice yet: a language picked in the avatar menu (or on the sign-in page) stays.
 * Not a __Host- cookie: the pages read it (src/proxy.ts), and it holds no secret.
 */
export function staffLocaleCookie(
  request: Request,
  locale: string,
  config: Pick<BffConfig, 'locales' | 'localeCookie' | 'origin'>,
): string | null {
  if (!config.locales.includes(locale)) return null;
  if (config.locales.includes(parseCookies(request.headers.get('cookie')).get(config.localeCookie) ?? '')) return null;
  const secure = config.origin.startsWith('https://') ? '; Secure' : '';
  return `${config.localeCookie}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export async function logout(d: FlowDeps, session: SessionRecord | null): Promise<Response> {
  if (session?.user) await d.client.revoke(d.config.clientId, session.user.refreshToken, 'refresh_token').catch(() => undefined);
  if (session) await d.sessions.destroy(session.id);
  return json({ ok: true }, 200, { 'set-cookie': d.sessions.clearCookie() });
}

export function methodNotAllowed(allow: string): Response {
  return problem(405, 'METHOD_NOT_ALLOWED', { headers: { allow } });
}
