// The consumer BFF (GD-03, Docs/41 G2): one request handler over standard Request/Response for
//   /api/v1/*                 1:1 forwarder of the consumer operations (forwarder.ts)
//   /bff/login | /bff/oauth/callback | /bff/logout     OAuth client (oauth/flow.ts)
//   /bff/session | /bff/csrf | /bff/intents[/<id>/consume]   session view, CSRF token, pending intents (endpoints.ts)
//   /id/oauth/* | /id/v1/auth/* | /id/.well-known/*    auth host, same origin (auth-proxy.ts, GD-05)
// plus the cp-ssr credentials for server rendering. No Next.js imports, so backend/api-gateway can host it (BA-23).
import { ConsumerAllowlist } from './allowlist';
import { proxyAuth } from './auth-proxy';
import { clientHeader, type BffConfig } from './config';
import { checkCsrf } from './csrf';
import { consumeIntent, csrfToken, saveIntent, sessionView } from './endpoints';
import { failure, forward, pickLocale } from './forwarder';
import { json, problem } from './http';
import { callback, login, logout, methodNotAllowed } from './oauth/flow';
import { TokenClient, type ClientAuthentication } from './oauth/token-client';
import { SessionManager } from './session/manager';
import type { SessionStore } from './session/store';
import { SessionTokens, SsrTokens } from './tokens';

export type { BffConfig } from './config';
export { DEFAULT_LIFETIMES, SESSION_COOKIE, INTERACTION_COOKIE, clientHeader } from './config';
export { LiteSessionStore, type SessionStore } from './session/store';
export { RedisSessionStore, RespClient } from './session/redis';
export { privateKeyJwt, noClientAuthentication, TokenEndpointError, type ClientAuthentication } from './oauth/token-client';
export type { Credential } from './tokens';
export { dpopProof } from './oauth/dpop';

export interface BffOptions {
  config: BffConfig;
  store: SessionStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Client authentication at /oauth/token (none in lite; private_key_jwt in strict mode, P2.T10). */
  clientAuth?: (clientId: string) => ClientAuthentication;
}

export interface Bff {
  handle(request: Request): Promise<Response>;
  readonly ssr: SsrTokens;
  readonly sessions: SessionManager;
  readonly allowlist: ConsumerAllowlist;
  readonly tokenClient: TokenClient;
  close(): Promise<void>;
}

export function createBff(o: BffOptions): Bff {
  const config = o.config;
  const doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  const now = o.now ?? Date.now;
  const sessions = new SessionManager(o.store, config, now);
  const tokenClient = new TokenClient({
    authUrl: config.authUrl,
    clientHeader: (id) => clientHeader(id, config.clientVersion),
    fetch: doFetch,
    powUpFront: config.strict,
    now,
    ...(o.clientAuth ? { clientAuth: o.clientAuth } : {}),
  });
  const tokens = new SessionTokens(sessions, tokenClient, config, now);
  const ssr = new SsrTokens(tokenClient, config, now);
  const allowlist = new ConsumerAllowlist();
  const flow = { config, sessions, client: tokenClient, fetch: doFetch, now };

  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();
    if (pathname.startsWith('/api/')) return forward(request, { config, sessions, tokens, allowlist, fetch: doFetch });
    if (pathname.startsWith('/id/'))
      return proxyAuth(request, { config, fetch: doFetch, issuer: async () => (await tokenClient.discovery()).issuer });

    const locale = pickLocale(request.headers.get('accept-language'), config);
    switch (pathname) {
      case '/bff/login':
        return method === 'GET' ? login(request, flow) : methodNotAllowed('GET');
      case '/bff/oauth/callback':
        return method === 'GET' ? callback(request, flow) : methodNotAllowed('GET');
      case '/bff/session':
        return method === 'GET' ? json(sessionView(await sessions.load(request), now())) : methodNotAllowed('GET');
      case '/bff/csrf':
        return method === 'GET' ? csrfToken(request, sessions, locale) : methodNotAllowed('GET');
    }

    // State-changing BFF endpoints: CSRF token, Sec-Fetch-Site and Origin (SEC-WEB-3).
    const intent = /^\/bff\/intents\/([A-Za-z0-9_-]{1,64})\/consume$/.exec(pathname);
    if (pathname === '/bff/logout' || pathname === '/bff/intents' || intent) {
      if (method !== 'POST') return methodNotAllowed('POST');
      const session = await sessions.load(request);
      const csrf = checkCsrf(request, config.origin, session);
      if (csrf) return problem(403, 'CSRF_FAILED', { extra: { reason: csrf } });
      if (pathname === '/bff/logout') return logout(flow, session);
      if (pathname === '/bff/intents') return saveIntent(request, sessions, session!, config.origin, now());
      return consumeIntent(sessions, session!, intent![1]!, now());
    }
    return problem(404, 'NOT_FOUND');
  }

  return {
    async handle(request) {
      try {
        return await route(request);
      } catch (err) {
        try {
          return failure(err);
        } catch {
          console.error('BFF: unexpected error', err);
          return problem(500, 'INTERNAL');
        }
      }
    },
    ssr,
    sessions,
    allowlist,
    tokenClient,
    async close() {
      await o.store.close?.();
    },
  };
}
