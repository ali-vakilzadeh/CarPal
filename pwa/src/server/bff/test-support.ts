// Test support for the BFF unit tests: an in-memory stand-in for the auth host and the api host behind a fetch
// function, with the same wire formats as the backend (discovery, Ed25519 JWKS, ID tokens, RFC 6749 errors,
// problem+json). Never imported by application code.
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from 'jose';
import { DEFAULT_LIFETIMES, type BffConfig } from './config';
import { createBff, type Bff } from './index';
import { jwkThumbprint } from './oauth/dpop';
import { LiteSessionStore } from './session/store';

export const ORIGIN = 'http://localhost:3000';
export const ISSUER = 'https://id.carpal.app';

export function testConfig(over: Partial<BffConfig> = {}): BffConfig {
  return {
    origin: ORIGIN,
    apiUrl: 'http://api.test',
    authUrl: 'http://auth.test',
    apiAudience: 'https://api.carpal.app',
    clientId: 'cp-web-consumer',
    ssrClientId: 'cp-ssr',
    clientVersion: '0.1.0',
    strict: false,
    locales: ['fa', 'en'],
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
  /** Answers api-host calls (after the default auth-host handling); return undefined for 404. */
  api: { handler: Handler };
  /** Overrides for /oauth/token; return undefined to use the default behaviour. */
  token: { handler: Handler };
  codes: Map<string, { sub: string; nonce: string; acr: string }>;
  refreshTokens: Set<string>;
  revoked: string[];
  anonymousJkts: (string | undefined)[];
  issueCode(o: { nonce: string; sub?: string; acr?: string }): string;
  idTokenNonce?: string;
}

export const problemResponse = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://docs.carpal.app/errors/${code}`, title: code, status, code, request_id: 'req-1' }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

export const oauthError = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function fakeBackend(): Promise<FakeBackend> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  let counter = 0;
  const fb: FakeBackend = {
    calls: [],
    api: { handler: () => undefined },
    token: { handler: () => undefined },
    codes: new Map(),
    refreshTokens: new Set(),
    revoked: [],
    anonymousJkts: [],
    issueCode(o) {
      const code = `code-${++counter}`;
      fb.codes.set(code, { sub: o.sub ?? 'user-1', nonce: o.nonce, acr: o.acr ?? 'aal1' });
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
          const now = Math.floor(Date.now() / 1000);
          switch (f.get('grant_type')) {
            case 'authorization_code': {
              const c = fb.codes.get(f.get('code') ?? '');
              if (!c) return oauthError(400, 'invalid_grant');
              fb.codes.delete(f.get('code')!);
              const idToken = await new SignJWT({ nonce: fb.idTokenNonce ?? c.nonce, acr: c.acr, auth_time: now, sid: 'sid-1' })
                .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
                .setIssuer(ISSUER)
                .setAudience(f.get('client_id')!)
                .setSubject(c.sub)
                .setIssuedAt(now)
                .setExpirationTime(now + 300)
                .sign(privateKey);
              const rt = `cprt_${++counter}`;
              fb.refreshTokens.add(rt);
              return Response.json({
                access_token: `at-${counter}`,
                token_type: 'Bearer',
                expires_in: 300,
                refresh_token: rt,
                id_token: idToken,
                scope: 'openid offline_access',
              });
            }
            case 'refresh_token': {
              const rt = f.get('refresh_token')!;
              if (!fb.refreshTokens.delete(rt)) return oauthError(400, 'invalid_grant');
              const next = `cprt_${++counter}`;
              fb.refreshTokens.add(next);
              return Response.json({
                access_token: `at-${counter}`,
                token_type: 'Bearer',
                expires_in: 300,
                refresh_token: next,
                scope: 'openid offline_access',
              });
            }
            case 'urn:carpal:params:oauth:grant-type:anonymous': {
              const proof = rec.headers.get('dpop');
              let jkt: string | undefined;
              if (proof) jkt = await jwkThumbprint(decodeProtectedHeader(proof).jwk as JWK);
              fb.anonymousJkts.push(jkt);
              return Response.json({
                access_token: `anon-${++counter}`,
                token_type: jkt ? 'DPoP' : 'Bearer',
                expires_in: 900,
                scope: 'public.read search',
              });
            }
            case 'client_credentials':
              return Response.json({ access_token: `ssr-${++counter}`, token_type: 'Bearer', expires_in: 300, scope: 'public.read' });
          }
          return oauthError(400, 'unsupported_grant_type');
        }
        if (u.pathname === '/oauth/challenge')
          return Response.json({
            challenge_id: 'ch-1',
            prefix: 'abcdefghijklmnop',
            difficulty_bits: 4,
            expires_at: '2099-01-01T00:00:00Z',
          });
        if (u.pathname === '/oauth/authorize')
          return new Response(null, {
            status: 302,
            headers: [
              ['location', `${ISSUER}/signin?interaction_id=ia-1`],
              ['set-cookie', '__Host-cp_ia=ia-1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800'],
              ['set-cookie', 'tracking=1; Path=/'],
            ],
          });
        if (u.pathname.startsWith('/v1/auth/')) return Response.json({ next: 'complete' }, { headers: { 'carpal-request-id': 'r-auth' } });
        return problemResponse(404, 'NOT_FOUND');
      }
      if (u.origin === 'http://api.test') {
        const custom = await fb.api.handler(rec);
        if (custom) return custom;
        if (u.pathname === '/v1/me' && rec.headers.get('authorization')?.startsWith('Bearer at-'))
          return Response.json({ id: 'user-1', full_name: 'Sara Example', display_name: 'Sara', locale: 'fa' });
        return problemResponse(404, 'NOT_FOUND');
      }
      throw new TypeError(`fetch failed: ${url}`);
    }) as typeof fetch,
  };
  return fb;
}

export interface TestBff {
  bff: Bff;
  backend: FakeBackend;
  store: LiteSessionStore;
  /** A browser: keeps cookies set by the BFF and sends same-origin fetch metadata. */
  browser: Browser;
  clock: { now: number };
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

  /** /bff/login → (hosted sign-in, faked) → /bff/oauth/callback; returns the callback response. */
  async signIn(backend: FakeBackend, o: { returnTo?: string; acr?: string; stepUp?: string } = {}): Promise<Response> {
    const q = new URLSearchParams({ return_to: o.returnTo ?? '/en/garage', ...(o.stepUp ? { step_up: o.stepUp } : {}) });
    const login = await this.fetch(`/bff/login?${q}`);
    const authorize = new URL(login.headers.get('location')!);
    const code = backend.issueCode({ nonce: authorize.searchParams.get('nonce')!, ...(o.acr ? { acr: o.acr } : {}) });
    const cb = new URLSearchParams({ code, state: authorize.searchParams.get('state')!, iss: ISSUER });
    return this.fetch(`/bff/oauth/callback?${cb}`);
  }
}

export async function testBff(over: Partial<BffConfig> = {}): Promise<TestBff> {
  const backend = await fakeBackend();
  const store = new LiteSessionStore({ sweepMs: 0 });
  const clock = { now: Date.now() };
  const bff = createBff({ config: testConfig(over), store, fetch: backend.fetch, now: () => clock.now });
  return { bff, backend, store, browser: new Browser(bff), clock };
}

export const decodeProof = (proof: string) => ({ header: decodeProtectedHeader(proof), claims: decodeJwt(proof) });
