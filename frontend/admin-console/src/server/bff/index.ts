// The admin BFF (AC3, GD-03): one request handler over standard Request/Response for
//   /api/*                                   1:1 forwarder of the admin operations (forwarder.ts); others 404
//   /bff/login[/restart] | /bff/reauth | /bff/oauth/callback | /bff/logout    OAuth client at aal3 (oauth/flow.ts)
//   /bff/session | /bff/csrf | /bff/intents[/<id>/consume]                   session view, CSRF token, pending actions
//   /id/oauth/* | /id/v1/auth/* | /id/.well-known/*                          auth host, same origin (auth-proxy.ts)
// Adapted from pwa/src/server/bff/index.ts: no guest pre-session API calls, no anonymous or cp-ssr tokens. No Next.js
// imports, so it can move to backend/api-gateway or a shared package with the PWA's and the portal's copies.
import { AdminAllowlist } from './allowlist';
import { proxyAuth } from './auth-proxy';
import { clientHeader, type BffConfig } from './config';
import { checkCsrf } from './csrf';
import { consumeIntent, csrfToken, saveIntent, sessionView } from './endpoints';
import { failure, forward } from './forwarder';
import { json, problem } from './http';
import { callback, login, logout, methodNotAllowed, reauth, restartLogin, uiLocale } from './oauth/flow';
import { TokenClient, type ClientAuthentication } from './oauth/token-client';
import { SessionManager } from './session/manager';
import type { SessionStore } from './session/store';
import { SessionTokens } from './tokens';

export type { BffConfig } from './config';
export { DEFAULT_LIFETIMES, SESSION_COOKIE, INTERACTION_COOKIE, RESUME_COOKIE, clientHeader } from './config';
export { readResumeCookie, resumeUrl, restartUrl, type ResumeInfo } from './auth-proxy';
export { LiteSessionStore, type SessionStore } from './session/store';
export { RedisSessionStore, RespClient } from './session/redis';
export { privateKeyJwt, noClientAuthentication, TokenEndpointError, type ClientAuthentication } from './oauth/token-client';
export { sessionView, type SessionView } from './endpoints';

export interface BffOptions {
  config: BffConfig;
  store: SessionStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Client authentication at /oauth/token and /oauth/revoke: private_key_jwt with the cp-web-admin key; none in lite dev. */
  clientAuth?: ClientAuthentication;
}

export interface Bff {
  handle(request: Request): Promise<Response>;
  readonly sessions: SessionManager;
  readonly allowlist: AdminAllowlist;
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
    now,
    ...(o.clientAuth ? { clientAuth: o.clientAuth } : {}),
  });
  const tokens = new SessionTokens(sessions, tokenClient, config, { config, fetch: doFetch }, now);
  const allowlist = new AdminAllowlist();
  const flow = { config, sessions, client: tokenClient, fetch: doFetch, now };

  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();
    if (pathname === '/api' || pathname.startsWith('/api/'))
      return forward(request, { config, sessions, tokens, allowlist, fetch: doFetch });
    if (pathname.startsWith('/id/'))
      return proxyAuth(request, { config, fetch: doFetch, issuer: async () => (await tokenClient.discovery()).issuer });

    switch (pathname) {
      case '/bff/login':
        return method === 'GET' ? login(request, flow) : methodNotAllowed('GET');
      case '/bff/login/restart':
        return method === 'GET' ? restartLogin(request, flow) : methodNotAllowed('GET');
      case '/bff/reauth':
        return method === 'GET' ? reauth(request, flow) : methodNotAllowed('GET');
      case '/bff/oauth/callback':
        return method === 'GET' ? callback(request, flow) : methodNotAllowed('GET');
      case '/bff/session':
        // Reading the view is not activity: it never moves the idle deadline it reports.
        return method === 'GET' ? json(sessionView(await sessions.load(request), sessions, now())) : methodNotAllowed('GET');
      case '/bff/csrf':
        return method === 'GET' ? csrfToken(request, sessions, uiLocale(request, config)) : methodNotAllowed('GET');
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
          // Never log request bodies, tokens or URLs with personal data (GD-12): the error class only.
          console.error('BFF: unexpected error', err instanceof Error ? err.name : typeof err);
          return problem(500, 'INTERNAL');
        }
      }
    },
    sessions,
    allowlist,
    tokenClient,
    async close() {
      await o.store.close?.();
    },
  };
}
