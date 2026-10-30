// /api/v1/* → api host, 1:1 (SEC-WEB-1, P2.T4): only consumer-audience routes (allowlist), CSRF on state changes,
// the server-held token attached (user, else the pre-session's anonymous token), browser headers stripped both ways,
// retry and poll delays passed through unchanged (SEC-RL-5). On a 401 the token is renewed once and the request
// repeated (the API refused it before running the operation); STEP_UP_REQUIRED passes through with its
// WWW-Authenticate challenge, which the browser client turns into a step-up sign-in (BA-11).
import { clientHeader, MAX_BODY_BYTES, type BffConfig } from './config';
import { checkCsrf } from './csrf';
import { isCanonicalPath, type ConsumerAllowlist } from './allowlist';
import { problem, readBody, withSecurityHeaders } from './http';
import { dpopProof } from './oauth/dpop';
import { TokenEndpointError } from './oauth/token-client';
import type { SessionManager } from './session/manager';
import type { SessionRecord } from './session/types';
import { SessionEndedError, type Credential, type SessionTokens } from './tokens';

/** Request headers the browser may send on to the API; everything else (cookies, Origin, Sec-*, UA …) is dropped. */
const FORWARD_REQUEST = ['accept', 'content-type', 'idempotency-key', 'if-match', 'carpal-request-id', 'carpal-pow'] as const;
/** Response headers passed back to the browser; Set-Cookie, DPoP-Nonce, Server and the like never are. */
export const FORWARD_RESPONSE = [
  'content-type',
  'content-language',
  'content-disposition',
  'etag',
  'location',
  'retry-after',
  'ratelimit',
  'ratelimit-policy',
  'carpal-retry-after-ms',
  'carpal-poll-after-ms',
  'carpal-request-id',
  'carpal-contract',
  'idempotent-replayed',
  'www-authenticate',
  'deprecation',
  'sunset',
] as const;

const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

export interface ForwarderDeps {
  config: BffConfig;
  sessions: SessionManager;
  tokens: SessionTokens;
  allowlist: ConsumerAllowlist;
  fetch: typeof fetch;
}

export function pickLocale(header: string | null, config: Pick<BffConfig, 'locales'>, fallback?: string): string {
  for (const part of (header ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase().split('-')[0]!;
    if (config.locales.includes(tag)) return tag;
  }
  return fallback && config.locales.includes(fallback) ? fallback : config.locales[0]!;
}

export async function forward(request: Request, d: ForwarderDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api'.length);
  const method = request.method.toUpperCase();
  if (!path.startsWith('/v1/') || !isCanonicalPath(path)) return problem(404, 'NOT_FOUND');
  if (method === 'HEAD' || method === 'OPTIONS') return problem(405, 'METHOD_NOT_ALLOWED');
  const match = d.allowlist.match(method, path);
  if (match.kind === 'not_found') return problem(404, 'NOT_FOUND');
  if (match.kind === 'method_not_allowed') return problem(405, 'METHOD_NOT_ALLOWED', { headers: { allow: match.allow.join(', ') } });

  let session = await d.sessions.load(request);
  const csrf = checkCsrf(request, d.config.origin, session);
  if (csrf) return problem(403, 'CSRF_FAILED', { extra: { reason: csrf } });

  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    const read = await readBody(request, MAX_BODY_BYTES);
    if (!read) return problem(413, 'PAYLOAD_TOO_LARGE');
    body = read;
  }

  // A guest's first API call creates the pre-session that holds its anonymous token (GD-07 b).
  let setCookie: string | undefined;
  if (!session) {
    session = d.sessions.create(pickLocale(request.headers.get('accept-language'), d.config));
    await d.sessions.save(session);
    setCookie = d.sessions.cookie(session);
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set('carpal-client', clientHeader(d.config.clientId, d.config.clientVersion));
  headers.set('accept-language', pickLocale(request.headers.get('accept-language'), d.config, session.locale));
  const tz = request.headers.get('carpal-timezone');
  if (tz && TIMEZONE.test(tz)) headers.set('carpal-timezone', tz);

  const target = `${d.config.apiUrl}${path}${url.search}`;
  const send = async (cred: Credential): Promise<Response> => {
    const h = new Headers(headers);
    h.set('authorization', `${cred.scheme} ${cred.accessToken}`);
    if (cred.dpopKey)
      h.set('dpop', await dpopProof(cred.dpopKey, { method, url: `${d.config.apiAudience}${path}`, accessToken: cred.accessToken }));
    return d.fetch(target, { method, headers: h, body: body as BodyInit | undefined, redirect: 'manual' });
  };

  let upstream: Response;
  try {
    let cred = await d.tokens.credential(session);
    upstream = await send(cred);
    if (upstream.status === 401 && (await problemCode(upstream)) !== 'STEP_UP_REQUIRED') {
      cred = await renew(session, cred, d.tokens);
      upstream = await send(cred);
      if (upstream.status === 401 && cred.kind === 'user' && (await problemCode(upstream)) === 'UNAUTHENTICATED') {
        // Still refused with a freshly refreshed token: the session was revoked server-side (sign out everywhere, password change).
        await d.tokens.endUser(session.id);
        return problem(401, 'SESSION_ENDED', { headers: cookieHeader(setCookie) });
      }
    }
  } catch (err) {
    return failure(err, setCookie);
  }

  await d.sessions.touch(session);
  const out = withSecurityHeaders(new Headers(cookieHeader(setCookie)));
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  // The session view's display name (header, P2) follows the account: me.get / me.update refresh it (P9 Profile).
  if (path === ME_PATH && upstream.ok && session.user && (method === 'GET' || method === 'PATCH')) {
    const text = await upstream.text();
    await rememberProfile(d.sessions, session.id, text);
    return new Response(text, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const ME_PATH = '/v1/me';

async function rememberProfile(sessions: ForwarderDeps['sessions'], id: string, text: string): Promise<void> {
  try {
    const me = JSON.parse(text) as { display_name?: string | null; full_name?: string; locale?: string };
    const displayName = me.display_name || me.full_name || '';
    if (!displayName) return;
    await sessions.update(id, (r) => {
      r.profile = { displayName, ...(me.locale ? { locale: me.locale } : {}) };
    });
  } catch {
    // not JSON: leave the stored name
  }
}

async function renew(session: SessionRecord, cred: Credential, tokens: SessionTokens): Promise<Credential> {
  if (cred.kind === 'user') {
    const user = await tokens.refresh(session.id, true);
    return { kind: 'user', accessToken: user.accessToken, scheme: 'Bearer' };
  }
  const anon = await tokens.anonymous(session.id);
  return { kind: 'anonymous', accessToken: anon.token.accessToken, scheme: 'DPoP', dpopKey: anon.key };
}

async function problemCode(res: Response): Promise<string | undefined> {
  if (!(res.headers.get('content-type') ?? '').includes('json')) return undefined;
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

function cookieHeader(setCookie: string | undefined): HeadersInit {
  return setCookie ? { 'set-cookie': setCookie } : {};
}

/** Token or network failures of the BFF's own calls, mapped to problems the browser client understands. */
export function failure(err: unknown, setCookie?: string): Response {
  const headers = new Headers(cookieHeader(setCookie));
  if (err instanceof SessionEndedError) return problem(401, 'SESSION_ENDED', { headers });
  if (err instanceof TokenEndpointError) {
    // Backpressure from the auth host reaches the browser unchanged (SEC-RL-5).
    if ((err.status === 429 || err.status === 503) && err.retryAfterMs !== undefined) {
      headers.set('carpal-retry-after-ms', String(err.retryAfterMs));
      headers.set('retry-after', String(Math.ceil(err.retryAfterMs / 1000)));
      return problem(503, 'BAD_GATEWAY', {
        headers,
        ...(err.requestId ? { requestId: err.requestId } : {}),
        extra: { retry_after_ms: err.retryAfterMs },
      });
    }
    return problem(502, 'BAD_GATEWAY', { headers, ...(err.requestId ? { requestId: err.requestId } : {}) });
  }
  if (err instanceof TypeError) return problem(502, 'BAD_GATEWAY', { headers });
  throw err;
}
