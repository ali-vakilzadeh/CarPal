// The request pipeline (41 §5) for one host. Order:
//   1  router            unknown route 404, wrong method 405, path params (404)
//   2  load shedding     503 OVERLOADED by priority (SEC-RL-2)
//   3  transport         method-override headers, CarPal-Client, CarPal-Timezone,
//                        content type (415), body ≤ 64 KiB (413), strict JSON (400),
//                        SEC-IN-4 normalization (422)
//   4  authentication    token, audience, CarPal-Client = client_id, live session (401)
//   5  rate limit        caller-scoped windows of the default and RL(...) buckets (429)
//   6  authorization     principals, ORG/DRV/STF, step-up, PURP, ATT (404 / 401)
//      rate limit        organization-scoped windows, after the organization is authorized
//   7  feature flags     FLAG(key) (403 / 503)
//      501 NOT_IMPLEMENTED when no handler is bound (GD-05, dev only)
//   8  validation        query (400/422) and body against the closed schemas (422),
//                        signed cursor (400 CURSOR_MISMATCH)
//      idempotency       IDEM (428/422/409/replay); ETAG If-Match (428/412)
//   9  handler           use case; transactions through ctx.tx (L5)
//  10  response          projection check (dev/test), ETag, Cache-Control, headers
// Deviation from 41 §5 step 3: closed-schema validation runs after
// authorization (unauthorized callers learn nothing about input rules and
// unimplemented operations answer 501 before validation).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { principalKey, type Authenticator, type Principal } from '#libs/auth/index.js';
import type { AccessGrant, Authorizer } from '#libs/authz/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError, isApiError, type Host } from '#libs/contract/index.js';
import { formatEtag, parseIfMatch } from '#libs/concurrency/index.js';
import type { CryptoServices } from '#libs/crypto/index.js';
import type { FlagContext, FlagService } from '#libs/flags/index.js';
import { IdempotencyStore, requestHash, type StoredResponse } from '#libs/idempotency/index.js';
import { resolveLocale, type Locale } from '#libs/i18n/index.js';
import { appMetrics, ipPrefix as toIpPrefix, resolveRequestId, type Logger } from '#libs/observability/index.js';
import { routeBuckets, shedPriority, type LoadShedder, type RateLimiter, type RateSubject } from '#libs/rate-limit/index.js';
import type { TxRunner, TenancyContext } from '#libs/tenancy/index.js';
import { AUDIT_MARK } from '#libs/audit/index.js';
import {
  CONTRACT_VERSION,
  METHOD_OVERRIDE_HEADERS,
  parseClientHeader,
  parseTimezone,
  SECURITY_HEADERS,
  type ClientInfo,
} from './headers.js';
import { normalizeInput, normalizeString } from './normalize.js';
import type { OperationContext, OperationHandler, OperationResult } from './operation.js';
import { toProblem } from './problem.js';
import type { RouteEntry, RouteTable } from './router.js';
import { parseStrictJson } from './strict-json.js';
import type { ContractValidator } from './validation.js';

export const MAX_BODY_BYTES = 64 * 1024;

export interface PipelineDeps {
  host: Exclude<Host, 'storage'>;
  config: CarpalConfig;
  routes: RouteTable;
  handlers: ReadonlyMap<string, OperationHandler>;
  validator: ContractValidator;
  authenticator: Authenticator;
  authorizer: Authorizer;
  rateLimiter: RateLimiter;
  shedder: LoadShedder;
  flags: FlagService;
  idempotency: IdempotencyStore;
  tx: TxRunner;
  crypto: CryptoServices;
  logger: Logger;
  locales: readonly Locale[];
}

interface Exchange {
  requestId: string;
  locale: Locale;
  started: number;
  entry?: RouteEntry;
  principal: Principal;
  client?: ClientInfo;
  ipPrefix: string;
  extraHeaders: Record<string, string>;
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
};

/** Every alternative is PUB(no token) (optionally with LNK): no token is read at all. */
const noTokenRoute = (e: RouteEntry): boolean =>
  e.route.security.principals.every((alt) => alt.some((t) => t.tag === 'PUB' && t.qualifier === 'no token'));

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) throw new ApiError('PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new ApiError('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mediaType(req: IncomingMessage): { type: string; charset?: string } | undefined {
  const ct = header(req, 'content-type');
  if (!ct) return undefined;
  const [type = '', ...params] = ct.split(';').map((s) => s.trim().toLowerCase());
  const charset = params
    .find((p) => p.startsWith('charset='))
    ?.slice(8)
    .replace(/"/g, '');
  return { type, ...(charset ? { charset } : {}) };
}

export class HttpPipeline {
  constructor(private readonly d: PipelineDeps) {}

  /** node:http request listener. Never throws. */
  readonly listener = (req: IncomingMessage, res: ServerResponse): void => {
    void this.#handle(req, res);
  };

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const x: Exchange = {
      requestId: resolveRequestId(header(req, 'carpal-request-id')),
      locale: resolveLocale(header(req, 'accept-language'), this.d.locales),
      started: performance.now(),
      principal: { kind: 'none' },
      ipPrefix: toIpPrefix(req.socket.remoteAddress),
      extraHeaders: {},
    };
    let release: (() => void) | undefined;
    let status = 500;
    let errorCode: string | undefined;
    try {
      const result = await this.#run(req, x, (r) => (release = r));
      status = result.status;
      this.#send(res, x, result.status, result.body, result.headers, 'application/json');
    } catch (err) {
      const e = this.#toApiError(err, x);
      status = e.status;
      errorCode = e.code;
      if (e.status >= 500 && e.status !== 501)
        this.d.logger.error({ err: e.cause ?? e, request_id: x.requestId, op: x.entry?.op.opId, detail: e.detail }, 'request failed');
      const headers: Record<string, string> = { ...x.extraHeaders, ...e.headers };
      if (e.retryAfterMs !== undefined) {
        headers['carpal-retry-after-ms'] = String(e.retryAfterMs);
        headers['retry-after'] = String(Math.ceil(e.retryAfterMs / 1000));
      }
      if (req.complete === false) headers.connection = 'close';
      this.#send(res, x, e.status, toProblem(e, x.requestId, x.locale), headers, 'application/problem+json');
      if (e.code === 'PAYLOAD_TOO_LARGE') req.resume();
    } finally {
      release?.();
      const latency = performance.now() - x.started;
      const user =
        x.principal.kind === 'user' || x.principal.kind === 'staff'
          ? this.d.crypto.hmac.digest('log-pseudonym', x.principal.userId).toString('hex').slice(0, 16)
          : undefined;
      // SEC-LOG-1: route template, never the raw URL; no bodies, tokens or personal data.
      this.d.logger.info(
        {
          request_id: x.requestId,
          op: x.entry?.op.opId,
          route: x.entry ? `${x.entry.route.method} ${x.entry.route.path}` : `${req.method} (unmatched)`,
          status,
          latency_ms: Math.round(latency),
          client_id: x.client?.clientId,
          user,
          ip: x.ipPrefix,
          error_code: errorCode,
        },
        'request',
      );
      appMetrics.requestDuration.record(latency, { op: x.entry?.op.opId ?? 'unmatched', status });
      appMetrics.requests.add(1, { op: x.entry?.op.opId ?? 'unmatched', status });
    }
  }

  #toApiError(err: unknown, x: Exchange): ApiError {
    if (isApiError(err)) return err;
    return new ApiError('INTERNAL', { detail: `${(err as Error)?.message ?? err} (${x.requestId})`, cause: err });
  }

  #send(res: ServerResponse, x: Exchange, status: number, body: unknown, headers: Record<string, string>, contentType: string): void {
    if (res.headersSent) return;
    const out: Record<string, string> = {
      ...SECURITY_HEADERS,
      'carpal-request-id': x.requestId,
      'carpal-contract': CONTRACT_VERSION,
      'cache-control': 'no-store',
      ...headers,
    };
    if (body === undefined || status === 204 || status === 302) {
      res.writeHead(status, out).end();
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    out['content-type'] = contentType;
    out['content-length'] = String(payload.length);
    if (contentType === 'application/problem+json') out['content-language'] ??= x.locale;
    res.writeHead(status, out).end(payload);
  }

  async #run(
    req: IncomingMessage,
    x: Exchange,
    onAdmit: (release: () => void) => void,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const d = this.d;
    const method = req.method ?? 'GET';
    const [rawPath = '/', rawQuery = ''] = (req.url ?? '/').split('?', 2) as [string, string?];

    // 1. Router
    const m = d.routes.match(method, rawPath);
    if (m.kind === 'not_found') throw new ApiError('NOT_FOUND', { detail: 'no such route' });
    if (m.kind === 'method_not_allowed') throw new ApiError('METHOD_NOT_ALLOWED', { headers: { allow: m.allow.join(', ') } });
    const { entry, params } = m;
    x.entry = entry;
    const { op, route } = entry;
    const tags = (name: string) => route.security.tags.filter((t) => t.tag === name);

    // 2. Load shedding
    onAdmit(d.shedder.enter(shedPriority(op.opId, method)));

    // 3. Transport
    for (const h of METHOD_OVERRIDE_HEADERS)
      if (req.headers[h] !== undefined) throw new ApiError('MALFORMED_REQUEST', { detail: `${h} is not accepted` });
    x.client = parseClientHeader(header(req, 'carpal-client'), d.config.http.clientMinVersions);
    const tokenless = noTokenRoute(entry);
    // CarPal-Client is required everywhere except token-less GETs (discovery documents, the hosted sign-in redirect, health).
    if (!x.client && !(tokenless && method === 'GET')) throw new ApiError('MALFORMED_REQUEST', { detail: 'CarPal-Client required' });
    const timezone = parseTimezone(header(req, 'carpal-timezone'));
    const rawBody = await readBody(req, MAX_BODY_BYTES);
    const body = this.#parseBody(req, method, op.inputEncoding, rawBody);

    // 4. Authentication
    if (!tokenless && header(req, 'authorization') !== undefined) {
      if (d.host === 'auth') throw new ApiError('UNAUTHENTICATED', { detail: 'the auth host takes no access tokens' });
      x.principal = await d.authenticator.authenticate({
        host: d.host,
        authorization: header(req, 'authorization'),
        dpop: header(req, 'dpop'),
        clientId: x.client?.clientId,
        method,
        htu: `${d.config.http.audiences[d.host]}${rawPath}`,
      });
    }

    // 5. Rate limit (caller scopes)
    const subject: RateSubject = {
      kind: x.principal.kind,
      ...(x.principal.kind === 'user' || x.principal.kind === 'staff'
        ? { id: x.principal.userId }
        : x.principal.kind === 'anonymous'
          ? { id: x.principal.anonKey }
          : {}),
      ipPrefix: x.ipPrefix,
    };
    const buckets = routeBuckets(route, subject);
    Object.assign(x.extraHeaders, (await d.rateLimiter.check(buckets, subject, 'caller')).headers);

    // 6. Authorization
    const grant = await d.authorizer.authorize({
      route,
      opId: op.opId,
      principal: x.principal,
      params,
      purposeHeader: header(req, 'carpal-access-purpose'),
      attestation: {
        ...(header(req, 'carpal-attestation') ? { attestation: header(req, 'carpal-attestation') } : {}),
        ...(header(req, 'carpal-pow') ? { pow: header(req, 'carpal-pow') } : {}),
        ...(x.client ? { clientId: x.client.clientId } : {}),
      },
    });
    if (grant.org) Object.assign(x.extraHeaders, (await d.rateLimiter.check(buckets, { ...subject, orgId: grant.org.id }, 'org')).headers);

    // 7. Feature flags
    const flagCtx = this.#flagContext(x.principal, grant);
    for (const t of tags('FLAG')) if (!t.qualifier) for (const key of t.args) await d.flags.require(key, flagCtx);

    const handler = d.handlers.get(op.opId);
    if (!handler) return this.#notImplemented(x);

    // 8. Validation
    const query = d.validator.parseQuery(op.opId, op.successStatus, rawQuery);
    if (op.inputEncoding === 'json') d.validator.validateBody(op.opId, op.successStatus, body);
    const pKey = principalKey(x.principal);
    const binding = this.#queryBinding(op.opId, route.path, params, query);
    let cursor: unknown;
    if (typeof query.cursor === 'string') {
      const c = d.crypto.cursors.verify(query.cursor, pKey, binding);
      if (!c.ok) throw new ApiError('CURSOR_MISMATCH', { detail: `cursor ${c.reason}` });
      cursor = c.position;
    }

    // Idempotency and If-Match
    let idem: { slot: string; hash: string } | undefined;
    const idemTag = tags('IDEM')[0];
    if (idemTag && (idemTag.qualifier !== 'if new' || header(req, 'idempotency-key') !== undefined)) {
      const key = IdempotencyStore.parseKey(header(req, 'idempotency-key'));
      const hash = requestHash(method, rawPath, rawQuery, rawBody);
      const begun = await d.idempotency.begin(pKey === 'none' ? `ip:${x.ipPrefix}` : pKey, op.opId, key, hash);
      if (begun.kind === 'replay')
        return { ...begun.response, headers: { ...x.extraHeaders, ...begun.response.headers, 'idempotent-replayed': 'true' } };
      idem = { slot: begun.slot, hash };
    }
    const etagTag = tags('ETAG')[0];
    const ifMatch = etagTag ? parseIfMatch(header(req, 'if-match'), etagTag.qualifier !== 'if exists') : undefined;

    // 9. Handler
    const marks = new Set<string>();
    const ctx = this.#context({
      x,
      entry,
      params,
      query,
      body,
      rawBody,
      req,
      grant,
      ifMatch,
      cursor,
      timezone,
      marks,
      binding,
      pKey,
      flagCtx,
    });
    let result: OperationResult;
    try {
      result = await handler.handle(ctx);
    } catch (err) {
      if (idem) {
        const e = this.#toApiError(err, x);
        if (e.status >= 500) await d.idempotency.abandon(idem.slot);
        else
          await d.idempotency.complete(idem.slot, idem.hash, {
            status: e.status,
            headers: e.headers,
            body: toProblem(e, x.requestId, x.locale),
          });
      }
      throw err;
    }

    // 10. Response
    const response = this.#response(entry, result, x, marks);
    if (idem) await d.idempotency.complete(idem.slot, idem.hash, response);
    return { ...response, headers: { ...x.extraHeaders, ...response.headers } };
  }

  #parseBody(req: IncomingMessage, method: string, encoding: string, raw: Buffer): unknown {
    if (method === 'GET' || method === 'DELETE') {
      if (raw.length > 0) throw new ApiError('MALFORMED_REQUEST', { detail: `${method} takes no body` });
      return undefined;
    }
    const mt = mediaType(req);
    if (encoding === 'form') {
      if (mt?.type !== 'application/x-www-form-urlencoded') throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
      const form: Record<string, string> = {};
      const errors: { pointer: string; code: 'forbidden_character' }[] = [];
      for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
        // RFC 6749 §3.1: parameters must not be included more than once.
        if (k in form) throw new ApiError('MALFORMED_REQUEST', { detail: `repeated form parameter ${k.slice(0, 40)}` });
        const n = normalizeString(v, true);
        if (!n.ok) errors.push({ pointer: `/${k}`, code: 'forbidden_character' });
        form[k] = n.value;
      }
      if (errors.length) throw ApiError.validation(errors);
      return form;
    }
    if (raw.length === 0) {
      if (encoding === 'json') throw new ApiError('MALFORMED_REQUEST', { detail: 'JSON body required' });
      return undefined;
    }
    if (mt?.type !== 'application/json' || (mt.charset !== undefined && mt.charset !== 'utf-8'))
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
    const n = normalizeInput(parseStrictJson(raw));
    if (n.errors.length) throw ApiError.validation(n.errors);
    if (encoding === 'none') {
      // `in: -`: an empty object is tolerated, anything else is an unknown field.
      if (n.value === null || typeof n.value !== 'object' || Array.isArray(n.value))
        throw new ApiError('VALIDATION_FAILED', { errors: [{ pointer: '/', code: 'type' }] });
      const keys = Object.keys(n.value);
      if (keys.length)
        throw ApiError.validation(
          keys.slice(0, 50).map((k) => ({ pointer: `/${k}`, code: 'unknown_field' })),
          'UNKNOWN_FIELD',
        );
      return undefined;
    }
    return n.value;
  }

  #notImplemented(x: Exchange): never {
    // GD-05: an operation of the contract without a handler (dev-only deviation from 40 §4.3).
    throw new NotImplemented(x.entry!.op.opId);
  }

  #flagContext(principal: Principal, grant: AccessGrant): FlagContext {
    return {
      ...(principal.kind === 'user' || principal.kind === 'staff' ? { userId: principal.userId } : {}),
      ...(principal.kind === 'anonymous' ? { anonKey: principal.anonKey } : {}),
      ...(grant.org ? { orgId: grant.org.id } : {}),
      roles: [...(grant.org ? [grant.org.role] : []), ...grant.platformRoles],
      region: this.d.config.region,
    };
  }

  #queryBinding(opId: string, path: string, params: Record<string, string>, query: Record<string, unknown>): string {
    const q = Object.entries(query)
      .filter(([k]) => k !== 'cursor' && k !== 'limit')
      .sort(([a], [b]) => a.localeCompare(b));
    const p = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([opId, path, p, q]);
  }

  #context(a: {
    x: Exchange;
    entry: RouteEntry;
    params: Record<string, string>;
    query: Record<string, unknown>;
    body: unknown;
    rawBody: Buffer;
    req: IncomingMessage;
    grant: AccessGrant;
    ifMatch: number | undefined;
    cursor: unknown;
    timezone: string | undefined;
    marks: Set<string>;
    binding: string;
    pKey: string;
    flagCtx: FlagContext;
  }): OperationContext {
    const d = this.d;
    const { x, grant } = a;
    const p = x.principal;
    const tenancy: TenancyContext = {
      actorType: p.kind === 'staff' ? 'staff' : p.kind === 'user' ? 'user' : 'anonymous',
      userId: p.kind === 'user' || p.kind === 'staff' ? p.userId : null,
      orgId: grant.org?.id ?? null,
      role: grant.org?.role ?? grant.platformRoles[0] ?? null,
      requestId: x.requestId,
      anonKey: p.kind === 'anonymous' ? p.anonKey : null,
    };
    return {
      op: a.entry.op,
      route: a.entry.route,
      requestId: x.requestId,
      principal: p,
      access: grant,
      params: a.params,
      query: a.query,
      body: a.body,
      rawBody: a.rawBody,
      headers: a.req.headers,
      locale: x.locale,
      timezone: a.timezone,
      client: x.client,
      ipPrefix: x.ipPrefix,
      ifMatch: a.ifMatch,
      cursor: a.cursor,
      tx: (fn, options) =>
        d.tx.run(
          tenancy,
          async (scope) => {
            try {
              return await fn(scope);
            } finally {
              for (const mark of scope.marks) a.marks.add(mark);
            }
          },
          options,
        ),
      authorizeOrg: (orgId, groups) => d.authorizer.authorizeOrg(p, orgId, groups),
      requireAssurance: (level) => d.authenticator.requireAssurance(p, level),
      flagEnabled: (key) => d.flags.isEnabled(key, a.flagCtx),
      rateLimit: async (bucket, scope, key, cost) => {
        Object.assign(x.extraHeaders, (await d.rateLimiter.consume(bucket, scope, key, cost)).headers);
      },
      page: (items, next) => ({
        items,
        next_cursor: next === null || next === undefined ? null : d.crypto.cursors.sign(a.pKey, a.binding, next),
      }),
    };
  }

  #response(entry: RouteEntry, result: OperationResult, x: Exchange, marks: Set<string>): StoredResponse {
    const { op, route } = entry;
    const status = result.status ?? op.successStatus;
    const headers: Record<string, string> = { ...result.headers };
    const body = result.body;
    if (this.d.config.pipeline.validateResponses) {
      const expected = [op.successStatus, ...(op.alternateResponses ?? []).map((r) => r.status)];
      if (!expected.includes(status))
        throw new ApiError('INTERNAL', { detail: `${op.opId} answered ${status}, contract says ${expected.join('/')}` });
      const errors = this.d.validator.checkResponse(op.opId, op.successStatus, status, body);
      if (errors.length)
        throw new ApiError('INTERNAL', { detail: `${op.opId} response violates the contract: ${JSON.stringify(errors.slice(0, 5))}` });
      // DoD: an AUD operation writes its audit entry (analytics.write_audit) when it succeeds.
      if (route.security.tags.some((t) => t.tag === 'AUD') && !marks.has(AUDIT_MARK))
        throw new ApiError('INTERNAL', { detail: `${op.opId} is AUD but wrote no audit entry` });
    }
    // SEC-IC-3: versioned resources carry ETag "v<version>".
    if (body && typeof body === 'object' && Number.isInteger((body as { version?: unknown }).version))
      headers.etag = formatEtag((body as { version: number }).version);
    const pii = route.security.tags.some((t) => t.tag === 'PII');
    if (result.cache && result.cache !== 'no-store' && !pii && x.principal.kind !== 'user' && x.principal.kind !== 'staff') {
      headers['cache-control'] = `public, max-age=${result.cache.public}`;
      headers.vary = 'Accept-Language';
    } else {
      headers['cache-control'] = 'no-store';
    }
    if (result.contentLanguage) headers['content-language'] = result.contentLanguage;
    return { status, headers, body };
  }
}

/** 501 for contract operations without a handler (GD-05). Rendered like a Problem with code NOT_IMPLEMENTED. */
export class NotImplemented extends ApiError {
  constructor(opId: string) {
    super('INTERNAL', { detail: `${opId} not implemented` });
    Object.defineProperty(this, 'status', { value: 501 });
    Object.defineProperty(this, 'code', { value: 'NOT_IMPLEMENTED' });
  }
}
