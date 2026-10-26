// Dev topology of GD-05 (P2.T3): the hosted sign-in UI and the auth endpoints share the PWA origin, so the auth
// host's interaction cookie (__Host-cp_ia) is first-party. /id/oauth/authorize, /id/oauth/challenge, /id/v1/auth/*
// and /id/.well-known/* go to the auth host; /oauth/token and /oauth/revoke stay server-to-server (the BFF's only).
// Only the interaction cookie travels; the BFF session cookie never reaches the auth host.
import { OPERATIONS } from '@carpal/api-contracts';
import { clientHeader, INTERACTION_COOKIE, MAX_BODY_BYTES, RESUME_COOKIE, type BffConfig } from './config';
import { checkSameOrigin } from './csrf';
import { isCanonicalPath } from './allowlist';
import { base64url } from './crypto';
import { hostCookie, parseCookies, problem, readBody } from './http';

const BROWSER_OPS = new Set(
  Object.entries(OPERATIONS)
    .filter(([id, op]) => op.routes.some((r) => r.host === 'auth') && id !== 'auth.token' && id !== 'auth.revoke')
    .flatMap(([, op]) => op.routes.map((r) => `${op.method} ${r.path}`)),
);

const FORWARD_REQUEST = [
  'accept',
  'accept-language',
  'content-type',
  'idempotency-key',
  'carpal-request-id',
  'carpal-pow',
  'carpal-timezone',
  'origin',
  'sec-fetch-site',
] as const;
const FORWARD_RESPONSE = [
  'content-type',
  'content-language',
  'cache-control',
  'pragma',
  'retry-after',
  'ratelimit',
  'ratelimit-policy',
  'carpal-retry-after-ms',
  'carpal-request-id',
  'carpal-contract',
  'idempotent-replayed',
  'www-authenticate',
] as const;

export interface AuthProxyDeps {
  config: BffConfig;
  fetch: typeof fetch;
  /** The issuer (from discovery): auth-host redirects to it are rewritten to <origin>/id. */
  issuer: () => Promise<string>;
}

export async function proxyAuth(request: Request, d: AuthProxyDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice('/id'.length);
  const method = request.method.toUpperCase();
  if (!isCanonicalPath(path) || !BROWSER_OPS.has(`${method} ${path}`)) return problem(404, 'NOT_FOUND');
  // The auth host does not check Origin / Sec-Fetch-Site yet (DI-09); the proxy does, for state changes.
  if (checkSameOrigin(request, d.config.origin)) return problem(403, 'CSRF_FAILED');

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set('carpal-client', request.headers.get('carpal-client') ?? clientHeader(d.config.clientId, d.config.clientVersion));
  const interaction = parseCookies(request.headers.get('cookie')).get(INTERACTION_COOKIE);
  if (interaction) headers.set('cookie', `${INTERACTION_COOKIE}=${interaction}`);

  let body: Uint8Array | undefined;
  if (method !== 'GET') {
    const read = await readBody(request, MAX_BODY_BYTES);
    if (!read) return problem(413, 'PAYLOAD_TOO_LARGE');
    body = read;
  }
  let upstream: Response;
  try {
    upstream = await d.fetch(`${d.config.authUrl}${path}${url.search}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
      redirect: 'manual',
    });
  } catch {
    return problem(502, 'BAD_GATEWAY');
  }

  const out = new Headers({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  for (const cookie of upstream.headers.getSetCookie()) if (cookie.startsWith(`${INTERACTION_COOKIE}=`)) out.append('set-cookie', cookie);
  const location = upstream.headers.get('location');
  if (location) {
    const target = await rewriteLocation(location, d);
    out.set('location', target);
    if (path === '/oauth/authorize') out.append('set-cookie', resumeCookie(target, url.search));
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const INTERACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

function interactionOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('interaction_id');
  } catch {
    return null;
  }
}

/**
 * Authorize answered with the hosted sign-in (an interaction_id): remember which authorize query started it, so the
 * hosted sign-in can re-request it on completion (BA-12). Any other answer (the code or an error for the client)
 * ends the sign-in: the cookie is cleared.
 */
function resumeCookie(target: string, authorizeSearch: string): string {
  const interactionId = interactionOf(target);
  if (!interactionId || !INTERACTION_ID.test(interactionId)) return hostCookie(RESUME_COOKIE, '', { sameSite: 'Lax', maxAgeS: 0 });
  const query = base64url(new TextEncoder().encode(authorizeSearch.replace(/^\?/, '')));
  return hostCookie(RESUME_COOKIE, `${interactionId}.${query}`, { sameSite: 'Lax', maxAgeS: 1800 });
}

export interface ResumeInfo {
  interactionId: string;
  /** The authorize query (without '?') that started the interaction. */
  query: URLSearchParams;
}

/** Reads the resume cookie; null when it is missing, malformed or belongs to another interaction. */
export function readResumeCookie(cookieHeader: string | null, interactionId: string | null): ResumeInfo | null {
  const raw = parseCookies(cookieHeader).get(RESUME_COOKIE);
  if (!raw || !interactionId) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || raw.slice(0, dot) !== interactionId) return null;
  try {
    const b64 = raw
      .slice(dot + 1)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return { interactionId, query: new URLSearchParams(new TextDecoder().decode(bytes)) };
  } catch {
    return null;
  }
}

/**
 * Where the hosted sign-in goes when the interaction is complete: the same authorize request, without prompt=login
 * (the auth host never resumes a prompt=login request, it would start a new interaction; the interaction itself
 * already re-authenticated). Only the authorize parameters of the contract are kept.
 */
export function resumeUrl(info: ResumeInfo): string {
  const keep = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'acr_values',
    'ui_locales',
  ];
  const q = new URLSearchParams();
  for (const k of keep) {
    const v = info.query.get(k);
    if (v !== null) q.set(k, v);
  }
  return `/id/oauth/authorize?${q.toString()}`;
}

/**
 * "Start again" after the interaction expired (410 LINK_EXPIRED): for this BFF's own sign-ins a new sign-in with the
 * same return URL (/bff/login/restart); for other clients the same authorize request (a new interaction).
 */
export function restartUrl(info: ResumeInfo | null, config: Pick<BffConfig, 'origin' | 'redirectUri'>): string {
  if (!info) return '/bff/login';
  const redirect = info.query.get('redirect_uri');
  const ownCallback = config.redirectUri ?? `${config.origin}/bff/oauth/callback`;
  const state = info.query.get('state');
  if (redirect === ownCallback && state) return `/bff/login/restart?state=${encodeURIComponent(state)}`;
  const again = resumeUrl(info);
  return info.query.get('prompt') === 'login' ? `${again}&prompt=login` : again;
}

/**
 * Redirects that point at the issuer or the internal auth host become <origin>/id/…; others are left alone. Dev and
 * E2E only: when the registered redirect URI differs from this origin's callback (an http PWA registers the https
 * URL, DI-24, OQ-10), the code goes to this origin's /bff/oauth/callback, so the browser never leaves http.
 */
export async function rewriteLocation(location: string, d: Pick<AuthProxyDeps, 'config' | 'issuer'>): Promise<string> {
  const startsWith = (base: string) => location === base || location.startsWith(`${base}/`) || location.startsWith(`${base}?`);
  for (const base of [d.config.authUrl, await d.issuer().catch(() => '')]) {
    if (base && startsWith(base)) return `${d.config.origin}/id${location.slice(base.length)}`;
  }
  const own = `${d.config.origin}/bff/oauth/callback`;
  const registered = d.config.redirectUri;
  if (registered && registered !== own && (location === registered || location.startsWith(`${registered}?`)))
    return `${own}${location.slice(registered.length)}`;
  return location;
}
