// Response helpers of the BFF: problem+json in the contract's Problem shape (40 §4.2) for errors the BFF raises
// itself, the security headers of every BFF response, and cookie parsing/serialization.
import { uuidv7 } from './crypto';

/** Headers on every BFF response: never cached, never sniffed, never framed or embedded cross-origin. */
export const BFF_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
};

export function withSecurityHeaders(headers: Headers): Headers {
  for (const [k, v] of Object.entries(BFF_SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = withSecurityHeaders(new Headers(extra));
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

/** Codes the BFF itself answers with (the contract's codes where one fits). */
export type BffProblemCode =
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CSRF_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'MALFORMED_REQUEST'
  | 'UNAUTHENTICATED'
  | 'STEP_UP_REQUIRED'
  | 'SESSION_ENDED'
  | 'SIGNIN_FAILED'
  | 'BAD_GATEWAY'
  | 'INTERNAL';

const TITLES: Record<BffProblemCode, string> = {
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  CSRF_FAILED: 'Request blocked',
  PAYLOAD_TOO_LARGE: 'Request too large',
  MALFORMED_REQUEST: 'Malformed request',
  UNAUTHENTICATED: 'Sign-in required',
  STEP_UP_REQUIRED: 'Confirm it is you',
  SESSION_ENDED: 'Session ended',
  SIGNIN_FAILED: 'Sign-in failed',
  BAD_GATEWAY: 'Service unreachable',
  INTERNAL: 'Something went wrong',
};

export function problem(
  status: number,
  code: BffProblemCode,
  o: { requestId?: string; headers?: HeadersInit; extra?: Record<string, unknown> } = {},
): Response {
  const headers = withSecurityHeaders(new Headers(o.headers));
  headers.set('content-type', 'application/problem+json');
  const requestId = o.requestId ?? uuidv7();
  headers.set('carpal-request-id', requestId);
  const body = {
    type: `https://docs.carpal.app/errors/${code}`,
    title: TITLES[code],
    status,
    code,
    request_id: requestId,
    ...o.extra,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirect(location: string, status = 303, extra?: HeadersInit): Response {
  const headers = withSecurityHeaders(new Headers(extra));
  headers.set('location', location);
  return new Response(null, { status, headers });
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  maxAgeS?: number;
  sameSite: 'Strict' | 'Lax';
  httpOnly?: boolean;
}

/** A __Host- cookie: Secure, Path=/, no Domain (localhost counts as a secure context, GD-08). */
export function hostCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', `SameSite=${o.sameSite}`];
  if (o.httpOnly !== false) parts.push('HttpOnly');
  if (o.maxAgeS !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeS))}`);
  return parts.join('; ');
}

/** Reads a request body up to `limit` bytes; null when it is larger. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
