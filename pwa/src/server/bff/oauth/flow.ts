// The BFF's OAuth client (P2.T2): /bff/login starts an authorization-code + PKCE request through the hosted sign-in
// (/id/oauth/authorize, proxied to the auth host, GD-05); /bff/oauth/callback checks state and issuer, exchanges the
// code server-to-server, verifies the ID token and rotates the session id (no fixation); /bff/logout revokes the
// refresh token and drops the session. Step-up = acr_values + prompt=login (BA-11). P4: /bff/login also carries
// what the hosted sign-in shows (screen=signup, the gated action's label, prompt=login for "Switch account"), and
// /bff/login/restart starts an expired sign-in again with the same return URL (BA-12).
import { clientHeader, KEEP_COOKIE, redirectUri, type BffConfig } from '../config';
import { createPkce, randomToken, timingSafeEqual } from '../crypto';
import { json, parseCookies, problem, redirect } from '../http';
import type { SessionManager } from '../session/manager';
import type { Acr, PendingLogin, SessionRecord } from '../session/types';
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
/**
 * An expired sign-in is still remembered this long, only so /bff/login/restart can start it again with the same
 * return URL (BA-12); its state is never accepted by the callback after LOGIN_TTL_MS.
 */
export const LOGIN_RESTART_MS = 12 * 3_600_000;
const MAX_PENDING_LOGINS = 5;
/** A step-up (prompt=login) must produce an authentication at least this recent (clock skew between the hosts). */
const STEP_UP_SKEW_S = 5;
const INTENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACR_RANK: Record<Acr, number> = { aal1: 1, aal2: 2, aal3: 3 };
export const isAcr = (v: unknown): v is Acr => v === 'aal1' || v === 'aal2' || v === 'aal3';

/**
 * A return URL is a same-origin path: it starts with one '/', has no scheme or authority, no backslash and no
 * control characters, and resolves to the app origin. Anything else becomes the locale home.
 */
export function safeReturnTo(value: string | null, origin: string, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some((c) => c < ' ' || c === '\x7f'))
    return fallback;
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin) return fallback;
    // The BFF's own endpoints are never a destination (no login loops, no logout by redirect).
    if (u.pathname.startsWith('/bff/') || u.pathname.startsWith('/api/') || u.pathname.startsWith('/id/oauth/')) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}

function localeOf(path: string, config: Pick<BffConfig, 'locales'>): string | undefined {
  const first = path.split('/')[1]?.split(/[?#]/)[0];
  return first && config.locales.includes(first) ? first : undefined;
}

/** What a sign-in asks for, from the /bff/login query or from the expired sign-in being restarted. */
interface LoginOptions {
  returnTo: string;
  locale: string;
  acrValues?: Acr;
  screen?: 'signup';
  prompt?: 'login';
  intentId?: string;
}

function loginOptions(q: URLSearchParams, existing: SessionRecord | null, config: BffConfig): LoginOptions {
  const requested = q.get('locale');
  const fallbackLocale = requested && config.locales.includes(requested) ? requested : (existing?.locale ?? config.locales[0]!);
  const returnTo = safeReturnTo(q.get('return_to'), config.origin, `/${fallbackLocale}`);
  const stepUp = q.get('step_up');
  const intentId = q.get('intent');
  return {
    returnTo,
    locale: localeOf(returnTo, config) ?? fallbackLocale,
    ...(isAcr(stepUp) && stepUp !== 'aal1' ? { acrValues: stepUp } : {}),
    ...(q.get('screen') === 'signup' ? { screen: 'signup' as const } : {}),
    ...(q.get('prompt') === 'login' ? { prompt: 'login' as const } : {}),
    ...(intentId && INTENT_ID.test(intentId) ? { intentId } : {}),
  };
}

export async function login(request: Request, d: FlowDeps): Promise<Response> {
  const existing = await d.sessions.load(request);
  return startLogin(existing, loginOptions(new URL(request.url).searchParams, existing, d.config), d);
}

/**
 * /bff/login/restart?state=… — the hosted sign-in's "Start again" after its interaction expired (410 LINK_EXPIRED,
 * BA-12): a new sign-in with the return URL, level, screen and intent of the expired one. Unknown states start a plain
 * sign-in that comes back to the locale home.
 */
export async function restartLogin(request: Request, d: FlowDeps): Promise<Response> {
  const existing = await d.sessions.load(request);
  const state = new URL(request.url).searchParams.get('state') ?? '';
  const old = existing?.logins.find((l) => l.createdAt + LOGIN_RESTART_MS > d.now() && timingSafeEqual(l.state, state));
  if (!old) return startLogin(existing, loginOptions(new URLSearchParams(), existing, d.config), d);
  return startLogin(
    existing,
    {
      returnTo: old.returnTo,
      locale: localeOf(old.returnTo, d.config) ?? existing!.locale ?? d.config.locales[0]!,
      ...(old.acrValues ? { acrValues: old.acrValues } : {}),
      ...(old.screen ? { screen: old.screen } : {}),
      ...(old.prompt ? { prompt: old.prompt } : {}),
      ...(old.intentId ? { intentId: old.intentId } : {}),
    },
    d,
  );
}

async function startLogin(existing: SessionRecord | null, o: LoginOptions, d: FlowDeps): Promise<Response> {
  const pkce = await createPkce();
  const pending: PendingLogin = {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: pkce.verifier,
    returnTo: o.returnTo,
    createdAt: d.now(),
    ...(o.acrValues ? { acrValues: o.acrValues } : {}),
    ...(o.screen ? { screen: o.screen } : {}),
    ...(o.prompt ? { prompt: o.prompt } : {}),
    ...(o.intentId ? { intentId: o.intentId } : {}),
  };
  const locale = o.locale;
  const addLogin = (r: SessionRecord) => {
    r.logins = [...r.logins.filter((l) => l.createdAt + LOGIN_RESTART_MS > d.now()), pending].slice(-MAX_PENDING_LOGINS);
    r.locale = locale;
  };
  let setCookie: string | undefined;
  if (existing && (await d.sessions.update(existing.id, addLogin))) {
    // kept the existing (pre-)session
  } else {
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
    ui_locales: locale,
  };
  if (pending.acrValues) {
    params.acr_values = pending.acrValues;
    params.prompt = 'login';
  }
  // "Switch account": credentials again even when the auth host still has a sign-in for this browser.
  if (pending.prompt) params.prompt = pending.prompt;
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);
  return redirect(authorize.toString(), 303, setCookie ? { 'set-cookie': setCookie } : undefined);
}

export type SigninOutcome = 'expired' | 'state' | 'issuer' | 'cancelled' | 'failed' | 'step_up';

/** Back to the page with ?signin=<outcome>; P4 shows the matching message. Never carries codes or tokens. */
function back(returnTo: string, outcome: SigninOutcome, origin: string): Response {
  const u = new URL(returnTo, origin);
  u.searchParams.set('signin', outcome);
  return redirect(`${u.pathname}${u.search}${u.hash}`, 303);
}

export async function callback(request: Request, d: FlowDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const session = await d.sessions.load(request);
  const home = `/${session?.locale ?? d.config.locales[0]}`;
  if (!session) return back(home, 'expired', d.config.origin);
  const state = q.get('state') ?? '';
  const pending = session.logins.find((l) => l.createdAt + LOGIN_TTL_MS > d.now() && timingSafeEqual(l.state, state));
  if (!pending) return back(home, 'state', d.config.origin);
  // One use per state, whatever the outcome.
  await d.sessions.update(session.id, (r) => {
    r.logins = r.logins.filter((l) => l.state !== pending.state);
  });

  const error = q.get('error');
  if (error)
    return back(pending.returnTo, error === 'access_denied' || error === 'login_required' ? 'cancelled' : 'failed', d.config.origin);
  const code = q.get('code');
  if (!code) return back(pending.returnTo, 'failed', d.config.origin);

  let tokens: TokenResponse;
  let claims: Record<string, unknown>;
  try {
    const { issuer } = await d.client.discovery();
    // RFC 9207: the authorization response names its issuer (mix-up defence).
    const iss = q.get('iss');
    if (iss !== null && iss !== issuer) return back(pending.returnTo, 'issuer', d.config.origin);
    tokens = await d.client.authorizationCode(d.config.clientId, { code, redirectUri: redirectUri(d.config), verifier: pending.verifier });
    if (!tokens.id_token || !tokens.refresh_token) throw new Error('token response without id_token or refresh_token');
    claims = await d.client.verifyIdToken(tokens.id_token, { clientId: d.config.clientId, nonce: pending.nonce });
  } catch {
    return back(pending.returnTo, 'failed', d.config.origin);
  }
  const acr = isAcr(claims.acr) ? claims.acr : 'aal1';
  const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : Math.floor(d.now() / 1000);
  if (pending.acrValues) {
    // prompt=login must have produced a new authentication. An account without a second factor meets aal2 through
    // that recent sign-in (the API checks auth_time, BA-11), so only aal3 needs the level itself.
    const fresh = authTime >= Math.floor(pending.createdAt / 1000) - STEP_UP_SKEW_S;
    const enough = ACR_RANK[acr] >= ACR_RANK[pending.acrValues] || pending.acrValues === 'aal2';
    if (!fresh || !enough) {
      await d.client.revoke(d.config.clientId, tokens.refresh_token!, 'refresh_token').catch(() => undefined);
      return back(pending.returnTo, 'step_up', d.config.origin);
    }
  }

  // A previous sign-in of this browser (re-login, step-up) leaves no orphan session on the auth server.
  if (session.user) await d.client.revoke(d.config.clientId, session.user.refreshToken, 'refresh_token').catch(() => undefined);
  const profile = await loadProfile(tokens.access_token, d);
  // "Keep me signed in" off (hosted sign-in, P4.T2): a browser-session cookie that also ends after one idle period.
  const keep = parseCookies(request.headers.get('cookie')).get(KEEP_COOKIE) !== '0';
  const next = await d.sessions.rotate(session, (r) => {
    r.user = {
      accessToken: tokens.access_token,
      accessExpiresAt: d.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token!,
      sub: String(claims.sub),
      sid: String(claims.sid ?? ''),
      acr,
      authTime,
      scope: tokens.scope,
    };
    if (profile) r.profile = profile;
    r.locale = localeOf(pending.returnTo, d.config) ?? profile?.locale ?? session.locale ?? d.config.locales[0]!;
    r.intents = session.intents.filter((i) => i.createdAt + INTENT_TTL_MS > d.now());
    if (!keep) {
      r.persistent = false;
      r.absoluteExpiresAt = Math.min(r.absoluteExpiresAt, d.now() + d.config.sessionIdleMs);
    }
  });
  return redirect(pending.returnTo, 303, [
    ['set-cookie', d.sessions.cookie(next)],
    ['set-cookie', `${KEEP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
  ]);
}

/**
 * What the hosted sign-in shows for one of this browser's sign-ins (found by its state): the screen to open and the
 * gated action's label. The hosted sign-in shares the session store in the GD-05 topology (same origin).
 */
export function loginHint(
  session: SessionRecord | null,
  state: string,
  now: number,
): { screen: 'signin' | 'signup'; context: string | null } {
  const pending = session?.logins.find((l) => l.createdAt + LOGIN_TTL_MS > now && timingSafeEqual(l.state, state));
  const intent = pending?.intentId
    ? session!.intents.find((i) => i.id === pending.intentId && i.createdAt + INTENT_TTL_MS > now)
    : undefined;
  return { screen: pending?.screen ?? 'signin', context: intent?.label ?? null };
}

export const INTENT_TTL_MS = 30 * 60_000;

/** me.get right after sign-in, for the display name and account locale in /bff/session (best effort). */
async function loadProfile(accessToken: string, d: FlowDeps): Promise<SessionRecord['profile'] | undefined> {
  try {
    const res = await d.fetch(`${d.config.apiUrl}/v1/me`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'carpal-client': clientHeader(d.config.clientId, d.config.clientVersion),
        accept: 'application/json',
      },
    });
    if (!res.ok) return undefined;
    const me = (await res.json()) as { display_name?: string | null; full_name?: string; locale?: string };
    return { displayName: me.display_name || me.full_name || '', ...(me.locale ? { locale: me.locale } : {}) };
  } catch {
    return undefined;
  }
}

export async function logout(d: FlowDeps, session: SessionRecord | null): Promise<Response> {
  if (session?.user) await d.client.revoke(d.config.clientId, session.user.refreshToken, 'refresh_token').catch(() => undefined);
  if (session) await d.sessions.destroy(session.id);
  return json({ ok: true }, 200, { 'set-cookie': d.sessions.clearCookie() });
}

export function methodNotAllowed(allow: string): Response {
  return problem(405, 'METHOD_NOT_ALLOWED', { headers: { allow } });
}
