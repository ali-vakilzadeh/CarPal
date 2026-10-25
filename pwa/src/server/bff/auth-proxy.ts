// Dev topology of GD-05 (P2.T3): the hosted sign-in UI and the auth endpoints share the PWA origin, so the auth
// host's interaction cookie (__Host-cp_ia) is first-party. /id/oauth/authorize, /id/oauth/challenge, /id/v1/auth/*
// and /id/.well-known/* go to the auth host; /oauth/token and /oauth/revoke stay server-to-server (the BFF's only).
// Only the interaction cookie travels; the BFF session cookie never reaches the auth host.
import { OPERATIONS } from '@carpal/api-contracts';
import { clientHeader, INTERACTION_COOKIE, MAX_BODY_BYTES, type BffConfig } from './config';
import { checkSameOrigin } from './csrf';
import { isCanonicalPath } from './allowlist';
import { parseCookies, problem, readBody } from './http';

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
  if (location) out.set('location', await rewriteLocation(location, d));
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Redirects that point at the issuer or the internal auth host become <origin>/id/…; others are left alone. */
export async function rewriteLocation(location: string, d: Pick<AuthProxyDeps, 'config' | 'issuer'>): Promise<string> {
  for (const base of [d.config.authUrl, await d.issuer().catch(() => '')]) {
    if (base && (location === base || location.startsWith(`${base}/`) || location.startsWith(`${base}?`)))
      return `${d.config.origin}/id${location.slice(base.length)}`;
  }
  return location;
}
