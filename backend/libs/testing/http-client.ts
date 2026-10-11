// Minimal HTTP client for tests (node:http): any method, raw bytes, repeated
// query parameters and invalid UTF-8 can be sent, which fetch() normalizes away.
import { request as httpRequest } from 'node:http';

export const TEST_CLIENT = 'cp-mobile/1.0.0 (ios 17.4)';

export interface TestRequest {
  method?: string;
  path: string;
  /** Object → JSON; string/Buffer → sent as-is. */
  body?: unknown;
  /** Access token (sent as `DPoP <token>`). */
  token?: string;
  headers?: Record<string, string | undefined>;
  /** CarPal-Client header; null omits it. */
  client?: string | null;
}

export interface TestResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
  text: string;
}

export function send<T = unknown>(baseUrl: string, r: TestRequest): Promise<TestResponse<T>> {
  const url = new URL(baseUrl);
  const headers: Record<string, string> = {};
  if (r.client !== null) headers['carpal-client'] = r.client ?? TEST_CLIENT;
  if (r.token) headers.authorization = `DPoP ${r.token}`;
  let payload: Buffer | undefined;
  if (r.body !== undefined) {
    if (Buffer.isBuffer(r.body)) payload = r.body;
    else if (typeof r.body === 'string') payload = Buffer.from(r.body, 'utf8');
    else {
      payload = Buffer.from(JSON.stringify(r.body), 'utf8');
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    headers['content-length'] = String(payload.length);
  }
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    if (v === undefined) delete headers[k.toLowerCase()];
    else headers[k.toLowerCase()] = v;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method: r.method ?? 'GET', path: r.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        if (/json/.test(String(res.headers['content-type'] ?? '')) && text) body = JSON.parse(text);
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode ?? 0, headers: flat, body: body as T, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
