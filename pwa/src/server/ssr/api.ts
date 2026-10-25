// Server-side typed client for React Server Components (GD-09, P2.T5): the same operation map and client rules as
// the browser, sent straight to the api host with the cached cp-ssr token (public.read). When the API refuses cp-ssr
// for an operation (401), the call is repeated once with the server-held anonymous token (DI-14).
import 'server-only';
import { createApiClient, type ApiClient, type Transport } from '@/lib/api';
import { clientHeader, dpopProof, type Credential } from '@/server/bff';
import { bff, bffConfig } from '@/server/bff-runtime';

function ssrTransport(locale: string, timezone?: string): Transport {
  const config = bffConfig();
  return async (req) => {
    if (req.host !== 'api') throw new Error(`${req.opId}: server rendering calls the api host only`);
    const send = async (cred: Credential) => {
      const headers = new Headers(req.headers);
      headers.set('authorization', `${cred.scheme} ${cred.accessToken}`);
      // CarPal-Client must name the token's client: cp-ssr, or cp-web-consumer for the anonymous fallback.
      headers.set('carpal-client', clientHeader(cred.kind === 'ssr' ? config.ssrClientId : config.clientId, config.clientVersion));
      headers.set('accept-language', locale);
      if (timezone) headers.set('carpal-timezone', timezone);
      if (cred.dpopKey)
        headers.set(
          'dpop',
          await dpopProof(cred.dpopKey, { method: req.method, url: `${config.apiAudience}${req.path}`, accessToken: cred.accessToken }),
        );
      return fetch(`${config.apiUrl}${req.path}${req.search}`, {
        method: req.method,
        headers,
        cache: 'no-store',
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    };
    const tokens = bff().ssr;
    let res = await send(await tokens.ssr());
    if (res.status === 401) {
      // Expired early or refused for cp-ssr: a fresh cp-ssr token first, then the anonymous fallback.
      res = await send(await tokens.ssr(true));
      if (res.status === 401) res = await send(await tokens.anonymous());
    }
    return res;
  };
}

const clients = new Map<string, ApiClient>();

/** The server client for one UI locale (Accept-Language); one instance per locale keeps the 503 pause state. */
export function ssrApi(locale: string, timezone?: string): ApiClient {
  const key = `${locale}|${timezone ?? ''}`;
  let c = clients.get(key);
  if (!c) {
    c = createApiClient({ transport: ssrTransport(locale, timezone) });
    clients.set(key, c);
  }
  return c;
}
