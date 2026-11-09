// Test support for the admin BFF unit tests (AC3.T7), adapted from pwa/src/server/bff/test-support.ts: an in-memory
// stand-in for the auth host and admin-api behind a fetch function, with the backend's wire formats (discovery, Ed25519
// JWKS, ID tokens with acr and auth_time, RFC 6749 errors, problem+json, admin.staff_me), and a browser that keeps the
// BFF's cookies. Never imported by application code.
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from 'jose';
import { DEFAULT_LIFETIMES, type BffConfig } from './config';
import { createBff, type Bff } from './index';
import { jwkThumbprint } from './oauth/dpop';
import { LiteSessionStore } from './session/store';

export const ORIGIN = 'http://localhost:3200';
export const ISSUER = 'https://id.carpals.ir';
export const AUDIENCE = 'https://admin-api.carpals.ir';
export const STAFF_ID = '01937000-0000-7000-8000-000000000001';

export function testConfig(over: Partial<BffConfig> = {}): BffConfig {
  return {
    origin: ORIGIN,
    adminApiUrl: 'http://admin.test',
    authUrl: 'http://auth.test',
    adminApiAudience: AUDIENCE,
    clientId: 'cp-web-admin',
    clientVersion: '0.1.0',
    locales: ['fa', 'en'],
    localeCookie: 'cpa_locale',
    ...DEFAULT_LIFETIMES,
    ...over,
  };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Handler = (req: Recorded) => Response | Promise<Response> | undefined;

export interface FakeBackend {
  fetch: typeof fetch;
  calls: Recorded[];
  /** Answers admin-api calls before the default handling (admin.staff_me); return undefined to fall through. */
  api: { handler: Handler };
  /** Overrides for /oauth/token; return undefined to use the default behaviour. */
  token: { handler: Handler };
  /** Overrides for /oauth/authorize (default: the sign-in page with interaction ia-1). */
  authorize: { handler: Handler };
  codes: Map<string, { sub: string; nonce: string; acr: string; authTime?: number }>;
  refreshTokens: Set<string>;
  revoked: string[];
  /** Platform roles admin.staff_me reports per user id (empty: not staff → 403). */
  staffRoles: Map<string, string[]>;
  /** Thumbprints of the DPoP keys the issued tokens are bound to, by access token. */
  boundTo: Map<string, string>;
  issueCode(o: { nonce: string; sub?: string; acr?: string; authTime?: number }): string;
  idTokenNonce?: string;
  tokenLifetimeS: number;
}

export const problemResponse = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://docs.carpals.ir/errors/${code}`, title: code, status, code, request_id: 'req-1' }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

export const oauthError = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function fakeBackend(now: () => number = Date.now): Promise<FakeBackend> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  let counter = 0;
  const subOf = new Map<string, string>();
  const tokenFor = async (rec: Recorded, sub: string) => {
    const at = `at-${++counter}`;
    subOf.set(at, sub);
    const proof = rec.headers.get('dpop');
    if (proof) fb.boundTo.set(at, await jwkThumbprint(decodeProtectedHeader(proof).jwk as JWK));
    return { at, bound: !!proof };
  };
  const fb: FakeBackend = {
    calls: [],
    api: { handler: () => undefined },
    token: { handler: () => undefined },
    authorize: { handler: () => undefined },
    codes: new Map(),
    refreshTokens: new Set(),
    revoked: [],
    staffRoles: new Map([[STAFF_ID, ['platform_admin', 'platform_community_reviewer']]]),
    boundTo: new Map(),
    tokenLifetimeS: 300,
    issueCode(o) {
      const code = `code-${++counter}`;
      fb.codes.set(code, { sub: o.sub ?? STAFF_ID, nonce: o.nonce, acr: o.acr ?? 'aal3', ...(o.authTime ? { authTime: o.authTime } : {}) });
      return code;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const rec: Recorded = {
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: new Headers(init?.headers),
        body: init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body ? String(init.body) : '',
      };
      fb.calls.push(rec);
      const u = new URL(url);
      if (u.origin === 'http://auth.test') {
        if (u.pathname === '/.well-known/openid-configuration')
          return Response.json({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/oauth/authorize`,
            token_endpoint: `${ISSUER}/oauth/token`,
            revocation_endpoint: `${ISSUER}/oauth/revoke`,
            jwks_uri: `${ISSUER}/.well-known/jwks.json`,
          });
        if (u.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
        if (u.pathname === '/oauth/revoke') {
          fb.revoked.push(new URLSearchParams(rec.body).get('token') ?? '');
          return new Response(null, { status: 200 });
        }
        if (u.pathname === '/oauth/token') {
          const custom = await fb.token.handler(rec);
          if (custom) return custom;
          const f = new URLSearchParams(rec.body);
          const nowS = Math.floor(now() / 1000);
          if (f.get('grant_type') === 'authorization_code') {
            const c = fb.codes.get(f.get('code') ?? '');
            if (!c) return oauthError(400, 'invalid_grant');
            fb.codes.delete(f.get('code')!);
            const idToken = await new SignJWT({
              nonce: fb.idTokenNonce ?? c.nonce,
              acr: c.acr,
              auth_time: c.authTime ?? nowS,
              sid: 'sid-1',
            })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
              .setIssuer(ISSUER)
              .setAudience(f.get('client_id')!)
              .setSubject(c.sub)
              .setIssuedAt(nowS)
              .setExpirationTime(nowS + 300)
              .sign(privateKey);
            const { at, bound } = await tokenFor(rec, c.sub);
            const rt = `cprt_${++counter}`;
            fb.refreshTokens.add(rt);
            subOf.set(rt, c.sub);
            return Response.json({
              access_token: at,
              token_type: bound ? 'DPoP' : 'Bearer',
              expires_in: fb.tokenLifetimeS,
              refresh_token: rt,
              id_token: idToken,
              scope: 'openid offline_access',
            });
          }
          if (f.get('grant_type') === 'refresh_token') {
            const rt = f.get('refresh_token')!;
            if (!fb.refreshTokens.delete(rt)) return oauthError(400, 'invalid_grant');
            const sub = subOf.get(rt)!;
            const next = `cprt_${++counter}`;
            fb.refreshTokens.add(next);
            subOf.set(next, sub);
            const { at, bound } = await tokenFor(rec, sub);
            return Response.json({
              access_token: at,
              token_type: bound ? 'DPoP' : 'Bearer',
              expires_in: fb.tokenLifetimeS,
              refresh_token: next,
              scope: 'openid offline_access',
            });
          }
          return oauthError(400, 'unsupported_grant_type');
        }
        if (u.pathname === '/oauth/authorize') {
          const custom = await fb.authorize.handler(rec);
          if (custom) return custom;
          return new Response(null, {
            status: 302,
            headers: [
              ['location', `${ISSUER}/signin?interaction_id=ia-1`],
              ['set-cookie', '__Host-cp_ia=ia-1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800'],
              ['set-cookie', 'tracking=1; Path=/'],
            ],
          });
        }
        if (u.pathname.startsWith('/v1/auth/')) return Response.json({ next: 'complete' }, { headers: { 'carpal-request-id': 'r-auth' } });
        return problemResponse(404, 'NOT_FOUND');
      }
      if (u.origin === 'http://admin.test') {
        const custom = await fb.api.handler(rec);
        if (custom) return custom;
        const token = /^(?:DPoP|Bearer) (\S+)$/.exec(rec.headers.get('authorization') ?? '')?.[1];
        const sub = token ? subOf.get(token) : undefined;
        if (!sub) return problemResponse(401, 'UNAUTHENTICATED');
        if (u.pathname === '/v1/admin/me') {
          const roles = fb.staffRoles.get(sub) ?? [];
          if (!roles.length) return problemResponse(403, 'FORBIDDEN');
          return Response.json({
            user_id: sub,
            display_name: 'Sara Staff',
            email: 'sara@staff.carpals.test',
            locale: 'en',
            timezone: 'Asia/Tehran',
            platform_roles: roles,
            acr: 'aal3',
            auth_time: new Date(now()).toISOString(),
            session_expires_at: new Date(now() + 8 * 3_600_000).toISOString(),
          });
        }
        return problemResponse(404, 'NOT_FOUND');
      }
      throw new TypeError(`fetch failed: ${url}`);
    }) as typeof fetch,
  };
  return fb;
}

export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(
    private readonly bff: Bff,
    readonly origin = ORIGIN,
  ) {}

  async fetch(path: string, init: RequestInit & { site?: string; noOrigin?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const method = (init.method ?? 'GET').toUpperCase();
    headers.set('sec-fetch-site', init.site ?? 'same-origin');
    if (method !== 'GET' && !init.noOrigin && !headers.has('origin')) headers.set('origin', this.origin);
    const res = await this.bff.handle(new Request(`${this.origin}${path}`, { ...init, method, headers }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...value] = pair!.split('=');
      if (/Max-Age=0/.test(c)) this.cookies.delete(name!);
      else this.cookies.set(name!, value.join('='));
    }
    return res;
  }

  async csrf(): Promise<string> {
    return ((await (await this.fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
  }

  /** /bff/login (or /bff/reauth) → (sign-in pages, faked) → /bff/oauth/callback; returns the callback response. */
  async signIn(
    backend: FakeBackend,
    o: { returnTo?: string; acr?: string; sub?: string; authTime?: number; reauth?: boolean; intent?: string } = {},
  ): Promise<Response> {
    const q = new URLSearchParams({ return_to: o.returnTo ?? '/queue', ...(o.intent ? { intent: o.intent } : {}) });
    const login = await this.fetch(`${o.reauth ? '/bff/reauth' : '/bff/login'}?${q}`);
    const authorize = new URL(login.headers.get('location')!);
    const code = backend.issueCode({
      nonce: authorize.searchParams.get('nonce')!,
      ...(o.acr ? { acr: o.acr } : {}),
      ...(o.sub ? { sub: o.sub } : {}),
      ...(o.authTime ? { authTime: o.authTime } : {}),
    });
    const cb = new URLSearchParams({ code, state: authorize.searchParams.get('state')!, iss: ISSUER });
    return this.fetch(`/bff/oauth/callback?${cb}`);
  }
}

export interface TestBff {
  bff: Bff;
  backend: FakeBackend;
  store: LiteSessionStore;
  browser: Browser;
  clock: { now: number };
}

export async function testBff(over: Partial<BffConfig> = {}): Promise<TestBff> {
  const clock = { now: Date.now() };
  const backend = await fakeBackend(() => clock.now);
  const store = new LiteSessionStore({ sweepMs: 0, now: () => clock.now });
  const bff = createBff({ config: testConfig(over), store, fetch: backend.fetch, now: () => clock.now });
  return { bff, backend, store, browser: new Browser(bff), clock };
}

export const decodeProof = (proof: string) => ({ header: decodeProtectedHeader(proof), claims: decodeJwt(proof) });
