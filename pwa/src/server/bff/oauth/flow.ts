// The BFF's OAuth client (P2.T2): /bff/login starts an authorization-code + PKCE request through the hosted sign-in
// (/id/oauth/authorize, proxied to the auth host, GD-05); /bff/oauth/callback checks state and issuer, exchanges the
// code server-to-server, verifies the ID token and rotates the session id (no fixation); /bff/logout revokes the
// refresh token and drops the session. Step-up = acr_values + prompt=login (BA-11).
import { clientHeader, redirectUri, type BffConfig } from '../config';
import { createPkce, randomToken, timingSafeEqual } from '../crypto';
import { json, problem, redirect } from '../http';
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
const MAX_PENDING_LOGINS = 5;
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

export async function login(request: Request, d: FlowDeps): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const existing = await d.sessions.load(request);
  const requestedLocale = q.get('locale');
  const fallbackLocale = existing?.locale ?? d.config.locales[0]!;
  const returnTo = safeReturnTo(
    q.get('return_to'),
    d.config.origin,
    `/${requestedLocale && d.config.locales.includes(requestedLocale) ? requestedLocale : fallbackLocale}`,
  );
  const locale =
    localeOf(returnTo, d.config) ?? (requestedLocale && d.config.locales.includes(requestedLocale) ? requestedLocale : fallbackLocale);
  const stepUp = q.get('step_up');

  const pkce = await createPkce();
  const pending: PendingLogin = {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: pkce.verifier,
    returnTo,
    createdAt: d.now(),
    ...(isAcr(stepUp) && stepUp !== 'aal1' ? { acrValues: stepUp } : {}),
  };
  const addLogin = (r: SessionRecord) => {
    r.logins = [...r.logins.filter((l) => l.createdAt + LOGIN_TTL_MS > d.now()), pending].slice(-MAX_PENDING_LOGINS);
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
  if (pending.acrValues && ACR_RANK[acr] < ACR_RANK[pending.acrValues]) {
    await d.client.revoke(d.config.clientId, tokens.refresh_token!, 'refresh_token').catch(() => undefined);
    return back(pending.returnTo, 'step_up', d.config.origin);
  }

  // A previous sign-in of this browser (re-login, step-up) leaves no orphan session on the auth server.
  if (session.user) await d.client.revoke(d.config.clientId, session.user.refreshToken, 'refresh_token').catch(() => undefined);
  const profile = await loadProfile(tokens.access_token, d);
  const next = await d.sessions.rotate(session, (r) => {
    r.user = {
      accessToken: tokens.access_token,
      accessExpiresAt: d.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token!,
      sub: String(claims.sub),
      sid: String(claims.sid ?? ''),
      acr,
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time : Math.floor(d.now() / 1000),
      scope: tokens.scope,
    };
    if (profile) r.profile = profile;
    r.locale = localeOf(pending.returnTo, d.config) ?? profile?.locale ?? session.locale ?? d.config.locales[0]!;
    r.intents = session.intents.filter((i) => i.createdAt + INTENT_TTL_MS > d.now());
  });
  return redirect(pending.returnTo, 303, { 'set-cookie': d.sessions.cookie(next) });
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
