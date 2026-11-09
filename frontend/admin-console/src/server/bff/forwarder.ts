// /api/v1/admin/* → admin-api, 1:1 (AC3.T4, SEC-WEB-1), adapted from pwa/src/server/bff/forwarder.ts (GD-03):
//   - only allowlisted admin operations (allowlist.ts); anything else 404 before a session is even read;
//   - CSRF token, Origin and Sec-Fetch-Site on every state change (SEC-WEB-3); a signed-in staff session or 401;
//   - the server-held, DPoP-bound access token attached; the browser's cookies, Origin, Sec-*, User-Agent … dropped;
//   - CarPal-Client cp-web-admin/<version>; Accept-Language and CarPal-Timezone;
//   - CarPal-Access-Purpose (GD-10) only on PURP operations and only in the contract's format kind:<uuid>;
//   - CarPal-Reason (GD-11, DI-09) only on DELETE operations that take a reason, one printable line;
//   - Idempotency-Key and If-Match passed through; retry and poll delays passed back unchanged (SEC-RL-5);
//   - no-store and the BFF security headers on every response; Set-Cookie and DPoP-Nonce never reach the browser.
// On a 401 the token is renewed once and the request repeated (the API refused it before running the operation);
// STEP_UP_REQUIRED passes through with its WWW-Authenticate challenge, which the browser client turns into /bff/reauth.
import { ADMIN_OPERATIONS } from '@/lib/api/generated';
import { clientHeader, MAX_BODY_BYTES, type BffConfig } from './config';
import { checkCsrf } from './csrf';
import { isCanonicalPath, type AdminAllowlist } from './allowlist';
import { problem, readBody, withSecurityHeaders } from './http';
import { dpopProof } from './oauth/dpop';
import { TokenEndpointError } from './oauth/token-client';
import type { SessionManager } from './session/manager';
import { staffProfileOf } from './staff';
import { SessionEndedError, userCredential, type Credential, type SessionTokens } from './tokens';

/** Request headers the browser may send on to admin-api; everything else is dropped. */
const FORWARD_REQUEST = ['accept', 'content-type', 'idempotency-key', 'if-match', 'carpal-request-id'] as const;
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
/** SEC-ADM-5 purpose header, exactly as the backend parses it (libs/authz/authorizer.ts PURPOSE). */
export const PURPOSE = /^(case|dispute|dsr|verification|approval):[0-9a-f-]{36}$/;
/** CarPal-Reason as sent: one line of printable ASCII (non-ASCII text is percent-encoded by the client, DI-09). */
export const REASON_HEADER = /^[\x20-\x7e]{1,2000}$/;
const STAFF_ME_PATH = ADMIN_OPERATIONS['admin.staff_me'].path;

export interface ForwarderDeps {
  config: BffConfig;
  sessions: SessionManager;
  tokens: SessionTokens;
  allowlist: AdminAllowlist;
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
  if (!path.startsWith('/v1/admin/') || !isCanonicalPath(path)) return problem(404, 'NOT_FOUND');
  if (method === 'HEAD' || method === 'OPTIONS') return problem(405, 'METHOD_NOT_ALLOWED');
  const match = d.allowlist.match(method, path);
  if (match.kind === 'not_found') return problem(404, 'NOT_FOUND');
  if (match.kind === 'method_not_allowed') return problem(405, 'METHOD_NOT_ALLOWED', { headers: { allow: match.allow.join(', ') } });
  const op = match.route.op;

  const session = await d.sessions.load(request);
  const csrf = checkCsrf(request, d.config.origin, session);
  if (csrf) return problem(403, 'CSRF_FAILED', { extra: { reason: csrf } });
  if (!session?.user) return problem(401, 'UNAUTHENTICATED');

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  if (op.purpose) {
    const purpose = request.headers.get('carpal-access-purpose');
    if (purpose !== null && !PURPOSE.test(purpose)) return problem(400, 'MALFORMED_REQUEST', { extra: { reason: 'purpose' } });
    if (purpose !== null) headers.set('carpal-access-purpose', purpose);
  }
  if (method === 'DELETE' && op.reason) {
    const reason = request.headers.get('carpal-reason');
    if (reason !== null && !REASON_HEADER.test(reason)) return problem(400, 'MALFORMED_REQUEST', { extra: { reason: 'reason' } });
    if (reason !== null) headers.set('carpal-reason', reason);
  }
  headers.set('carpal-client', clientHeader(d.config.clientId, d.config.clientVersion));
  headers.set('accept-language', pickLocale(request.headers.get('accept-language'), d.config, session.staff?.locale ?? session.locale));
  const tz = request.headers.get('carpal-timezone') ?? session.staff?.timezone;
  if (tz && TIMEZONE.test(tz)) headers.set('carpal-timezone', tz);

  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    const read = await readBody(request, MAX_BODY_BYTES);
    if (!read) return problem(413, 'PAYLOAD_TOO_LARGE');
    body = read;
  }

  const target = `${d.config.adminApiUrl}${path}${url.search}`;
  const send = async (cred: Credential): Promise<Response> => {
    const h = new Headers(headers);
    h.set('authorization', `${cred.scheme} ${cred.accessToken}`);
    if (cred.dpopKey)
      h.set('dpop', await dpopProof(cred.dpopKey, { method, url: `${d.config.adminApiAudience}${path}`, accessToken: cred.accessToken }));
    return d.fetch(target, { method, headers: h, body: body as BodyInit | undefined, redirect: 'manual' });
  };

  let upstream: Response;
  try {
    let cred = await d.tokens.credential(session);
    upstream = await send(cred);
    if (upstream.status === 401 && (await problemCode(upstream)) !== 'STEP_UP_REQUIRED') {
      const fresh = await d.sessions.get(session.id);
      cred = userCredential(fresh ?? session, await d.tokens.refresh(session.id, true));
      upstream = await send(cred);
      if (upstream.status === 401 && (await problemCode(upstream)) === 'UNAUTHENTICATED') {
        // Still refused with a freshly refreshed token: the session was ended server-side (staff suspended, sessions revoked).
        await d.tokens.endUser(session.id);
        return problem(401, 'SESSION_ENDED');
      }
    }
  } catch (err) {
    return failure(err);
  }

  await d.sessions.touch(session);
  const out = withSecurityHeaders(new Headers());
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  // The session view follows admin.staff_me (roles granted or revoked meanwhile).
  if (path === STAFF_ME_PATH && method === 'GET' && upstream.ok) {
    const text = await upstream.text();
    await rememberStaff(d.sessions, session.id, text);
    return new Response(text, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function rememberStaff(sessions: SessionManager, id: string, text: string): Promise<void> {
  try {
    const profile = staffProfileOf(JSON.parse(text) as Parameters<typeof staffProfileOf>[0]);
    if (!profile) return;
    await sessions.update(
      id,
      (r) => {
        if (r.user?.sub !== profile.userId) return;
        r.staff = profile;
        r.absoluteExpiresAt = Math.min(r.absoluteExpiresAt, profile.sessionExpiresAt);
      },
      { activity: false },
    );
  } catch {
    // not JSON: keep the stored profile
  }
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

/** Token or network failures of the BFF's own calls, mapped to problems the browser client understands. */
export function failure(err: unknown): Response {
  if (err instanceof SessionEndedError) return problem(401, 'SESSION_ENDED');
  if (err instanceof TokenEndpointError) {
    // Backpressure from the auth host reaches the browser unchanged (SEC-RL-5).
    if ((err.status === 429 || err.status === 503) && err.retryAfterMs !== undefined) {
      const headers = new Headers({
        'carpal-retry-after-ms': String(err.retryAfterMs),
        'retry-after': String(Math.ceil(err.retryAfterMs / 1000)),
      });
      return problem(503, 'BAD_GATEWAY', {
        headers,
        ...(err.requestId ? { requestId: err.requestId } : {}),
        extra: { retry_after_ms: err.retryAfterMs },
      });
    }
    return problem(502, 'BAD_GATEWAY', err.requestId ? { requestId: err.requestId } : {});
  }
  if (err instanceof TypeError) return problem(502, 'BAD_GATEWAY');
  throw err;
}
