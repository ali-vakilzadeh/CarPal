// Contract sweep runner (S9b, 40 Appendix C): for every route of a module the
// resolver builds the owner's call, and the runner derives from the registry
// what else must hold around it:
//   1. schema conformance  unknown body field → 422 UNKNOWN_FIELD, unknown
//                          query parameter → 400 UNKNOWN_QUERY_PARAM; the
//                          success response is checked by the pipeline
//                          (CARPAL_VALIDATE_RESPONSES: status, closed schema,
//                          AUD audit entry, PII read-audit for staff)
//   2. admin mechanics     PURP without / with a foreign purpose → 400 / 404,
//                          RSN DELETE without CarPal-Reason → 422, 4EYES → 202
//                          PendingChange (pending)
//   3. BFLA (insiders)     on organization routes, colleagues of the owner
//                          with every role outside the sec line send the
//                          owner's exact request → 404 (401 below the step-up)
//      fleet drivers       on {flt} vehicle and appointment routes a driver
//                          of the owner's fleet without an assignment sends
//                          the owner's request → 404 (SEC-AZ-7); on lists
//                          the driver sees none of the owner's records
//   4. BOLA                another user / a member of another organization
//                          with the same role → 404 NOT_FOUND or 422
//                          REFERENCE_NOT_FOUND, never data; the owner's call
//                          still succeeds afterwards (no side effect). Other
//                          refusals by design (CURSOR_MISMATCH, CONSENT_REQUIRED,
//                          LINK_RECIPIENT_MISMATCH) name their code, carry no
//                          data and answer a non-existent record the same way
//   5. kill switch         FLAG(ai.*) routes → 503 AI_UNAVAILABLE on the
//                          kill-switch host; every other route of the sweep
//                          runs its owner call on that host and must succeed
//   6. projection          SEC-OUT-1 fields, full VINs, trade prices
// The guard-level BFLA matrix (every role outside the sec line in a foreign
// organization, anonymous and consumer callers, staff roles, consumer vs
// staff hosts) is swept for every route by routes.int.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRegistry, loadSchemas, type Operation, type Route } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { rolesFor } from '#libs/authz/index.js';
import { routeMatrix, TEST_CLIENT, type TestRequest, type TestResponse } from '#libs/testing/index.js';
import type { TestApp } from '../test-app.js';
import { Harness, type BolaSpec, type Caller, type Case, type Json, type Resolvers } from './harness.js';
import { projectionViolations } from './projection.js';

export type RouteRef = readonly [opId: string, method: string, path: string];

interface Stats {
  routes: number;
  owner: number;
  skipped: string[];
  negatives: number;
  bola: number;
  bolaSkipped: number;
  bfla: number;
  driver: number;
  oracle: number;
  killSwitch: number;
  admin: number;
}

const has = (route: Route, tag: string) => route.security.tags.some((t) => t.tag === tag);

const ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/** Path parameters that name a record (Id schema; not Slug/enum/key parameters, not the tenant organization). */
function objectParams(op: Operation, route: Route): string[] {
  const schemas = loadSchemas().operations[op.opId]?.pathParams as Record<string, { pattern?: string }> | undefined;
  return route.pathParams.filter((p) => p !== 'org_id' && schemas?.[p]?.pattern === ID_PATTERN);
}

const tenantRoute = (route: Route) =>
  route.pathParams.includes('org_id') && route.security.principals.some((alt) => alt.some((t) => t.tag === 'ORG'));

/** {flt} vehicle and appointment routes whose sec line admits fleet drivers (F*, ANY or DRV): only assigned vehicles (SEC-AZ-7). */
const driverRoute = (route: Route) =>
  /^\/v1\/orgs\/\{org_id\}\/fleet\/(vehicles|appointments)(\/|$)/.test(route.path) &&
  route.security.principals.some((alt) =>
    alt.some((t) => {
      if (t.tag === 'DRV') return true;
      if (t.tag !== 'ORG') return false;
      const { roles, anyMember } = rolesFor(t.args, 'fleet');
      return anyMember || roles.has('fleet_driver');
    }),
  );

const ids = (res: TestResponse<Json>): string[] =>
  Array.isArray(res.body?.items) ? (res.body.items as Json[]).map((i) => String(i.id)) : [];

function build(
  op: Operation,
  route: Route,
  c: Case,
  caller: Caller,
  o: {
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
    /** Replaces the case's query. */
    queryAll?: Record<string, string>;
    headers?: Record<string, string | undefined>;
  } = {},
): TestRequest {
  const params: Record<string, string> = {
    ...('org' in caller && caller.org && route.pathParams.includes('org_id') ? { org_id: caller.org.id } : {}),
    ...c.params,
    ...o.params,
  };
  let path = route.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`${op.opId}: no value for path parameter ${name}`);
    return encodeURIComponent(v);
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...(o.queryAll ?? c.query), ...o.query })) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else q.append(k, String(v));
  }
  if ([...q].length) path += `?${q.toString()}`;
  const headers: Record<string, string | undefined> = { ...c.headers };
  if (has(route, 'IDEM') && !headers['idempotency-key']) headers['idempotency-key'] = uuidv7();
  if (c.version !== undefined) headers['if-match'] = `"v${c.version}"`;
  Object.assign(headers, o.headers);
  let body = 'body' in o ? o.body : c.body;
  if (op.inputEncoding === 'form' && body !== undefined && typeof body === 'object') {
    body = new URLSearchParams(body as Record<string, string>).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  return {
    method: route.method,
    path,
    ...('token' in caller && caller.token ? { token: caller.token } : {}),
    client: c.client !== undefined && caller === c.as ? c.client : 'client' in caller ? caller.client : TEST_CLIENT,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/** Problem members a BOLA refusal may carry (40 §4.2): no data of the record. */
const PROBLEM_BASE = new Set(['type', 'title', 'status', 'code', 'request_id', 'consent_type']);

const code = (res: TestResponse<Json>) => (res.body && typeof res.body === 'object' ? (res.body.code as string | undefined) : undefined);
const brief = (res: TestResponse<Json>) => `${res.status} ${code(res) ?? ''} ${res.text.slice(0, 300)}`;

async function autoBola(h: Harness, op: Operation, route: Route, c: Case): Promise<BolaSpec | string> {
  const caller = c.as;
  if (caller.kind === 'staff') return 'staff plane: every staff role of the sec line sees every record (staff roles: BFLA matrix)';
  if (caller.kind === 'none' || caller.kind === 'anonymous') return 'public operation';
  const ids = objectParams(op, route);
  const tenant = tenantRoute(route);
  if (ids.length === 0 && !c.bodyRefs)
    return tenant ? 'collection route: tenant from the path (foreign members: routes.int.test.ts)' : 'no object reference';
  const attacker = tenant && caller.kind === 'member' ? await h.rival(caller.org!.type, caller.role!) : await h.stranger();
  return { attackers: [attacker] };
}

async function runRoute(h: Harness, op: Operation, route: Route, c: Case, stats: Stats): Promise<string[]> {
  const problems: string[] = [];
  const flagKeys = route.security.tags.filter((t) => t.tag === 'FLAG' && !t.qualifier).flatMap((t) => t.args);
  const ai = (await Promise.all(flagKeys.map((k) => h.aiFlag(k)))).some(Boolean);
  const app: TestApp = route.host === 'admin-api' ? h.admin : route.host === 'auth' ? h.auth : ai ? h.api : h.apiKill;
  const send = (r: TestRequest) => app.request<Json>(r);

  // 1. Closed schemas (the owner's request plus one unknown member).
  if (!c.negatives) {
    const bodyOk = op.inputEncoding === 'json' && c.body !== null && typeof c.body === 'object' && !Array.isArray(c.body);
    const emptyPost = op.inputEncoding === 'none' && route.method !== 'GET' && route.method !== 'DELETE';
    if (bodyOk || emptyPost) {
      const res = await send(build(op, route, c, c.as, { body: { ...(c.body as Json | undefined), zz_unknown_member: true } }));
      stats.negatives++;
      if (res.status !== 422 || code(res) !== 'UNKNOWN_FIELD') problems.push(`unknown body field: ${brief(res)} (want 422 UNKNOWN_FIELD)`);
    }
    if (op.inputEncoding !== 'form') {
      const res = await send(build(op, route, c, c.as, { query: { zz_unknown_param: '1' } }));
      stats.negatives++;
      if (res.status !== 400 || code(res) !== 'UNKNOWN_QUERY_PARAM')
        problems.push(`unknown query parameter: ${brief(res)} (want 400 UNKNOWN_QUERY_PARAM)`);
    }
  }

  // 2. Admin-plane mechanics.
  if (route.host === 'admin-api') {
    if (has(route, 'PURP')) {
      const missing = await send(build(op, route, c, c.as, { headers: { 'carpal-access-purpose': undefined } }));
      const foreign = await send(build(op, route, c, c.as, { headers: { 'carpal-access-purpose': `case:${uuidv7()}` } }));
      stats.admin += 2;
      if (missing.status !== 400) problems.push(`PURP without purpose: ${brief(missing)} (want 400)`);
      if (foreign.status !== 404) problems.push(`PURP with a purpose outside the caller's queue: ${brief(foreign)} (want 404)`);
    }
    if (has(route, 'RSN') && route.method === 'DELETE') {
      const res = await send(build(op, route, c, c.as, { headers: { 'carpal-reason': undefined } }));
      stats.admin++;
      if (res.status !== 422) problems.push(`RSN DELETE without CarPal-Reason: ${brief(res)} (want 422)`);
    }
  }

  // 3. BFLA with real records: lower roles of the owner's own organization.
  // (A driver on a DRV route with a path vehicle is one of them: the matrix denies drivers without an assignment.)
  const owner = c.as.kind === 'member' ? c.as : null;
  const bflaRoles =
    tenantRoute(route) && owner && c.bfla !== false
      ? routeMatrix(op, route)
          .denied.filter((d) => d.spec.kind === 'member' && !d.spec.foreignOrg && d.spec.orgType === owner.org!.type)
          .map((d) => (d.spec as { role: string }).role)
      : [];
  if (owner) {
    for (const role of bflaRoles) {
      const colleague = await h.colleague(owner, role);
      const res = await send(build(op, route, c, colleague));
      stats.bfla++;
      if (res.status !== 404 || code(res) !== 'NOT_FOUND')
        problems.push(`BFLA as ${role} of the same organization: ${brief(res)} (want 404 NOT_FOUND)`);
    }
  }

  // 3b. Fleet drivers without an assignment (records of a path vehicle or appointment; lists after the owner's call).
  const driver =
    driverRoute(route) && owner?.org?.type === 'fleet' && c.driver === undefined && !bflaRoles.includes('fleet_driver')
      ? await h.colleague(owner, 'fleet_driver')
      : null;
  if (driver && objectParams(op, route).length > 0) {
    const res = await send(build(op, route, c, driver));
    stats.driver++;
    if (res.status !== 404 || code(res) !== 'NOT_FOUND')
      problems.push(`fleet driver without an assignment: ${brief(res)} (want 404 NOT_FOUND)`);
  }

  // 4. BOLA.
  const bola = c.bola === undefined || c.bola === 'auto' ? await autoBola(h, op, route, c) : c.bola;
  if (typeof bola === 'string') stats.bolaSkipped++;
  else {
    for (const attacker of bola.attackers) {
      const swap: Record<string, string> = tenantRoute(route) && 'org' in attacker && attacker.org ? { org_id: attacker.org.id } : {};
      const res = await send(
        build(op, route, c, attacker, {
          params: { ...swap, ...bola.params },
          ...('body' in bola ? { body: bola.body } : {}),
          ...(bola.query ? { queryAll: bola.query } : {}),
        }),
      );
      stats.bola++;
      const okStatus = bola.expect
        ? bola.expect.includes(res.status) && (!bola.code || code(res) === bola.code)
        : (res.status === 404 && code(res) === 'NOT_FOUND') || (res.status === 422 && code(res) === 'REFERENCE_NOT_FOUND');
      if (!okStatus)
        problems.push(
          `BOLA as ${attacker.kind}: ${brief(res)} (want ${bola.expect?.join('/') ?? '404 NOT_FOUND / 422 REFERENCE_NOT_FOUND'}${bola.code ? ` ${bola.code}` : ''})`,
        );
      if (bola.expect) {
        const extra = Object.keys(res.body ?? {}).filter((k) => !PROBLEM_BASE.has(k));
        if (extra.length) problems.push(`BOLA as ${attacker.kind}: the refusal carries ${extra.join(', ')}`);
        if (bola.absent && typeof bola.absent === 'object') {
          const a = bola.absent;
          const none = await send(
            build(op, route, c, attacker, {
              params: { ...swap, ...bola.params, ...a.params },
              ...('body' in a ? { body: a.body } : 'body' in bola ? { body: bola.body } : {}),
              ...(a.query ? { queryAll: a.query } : bola.query ? { queryAll: bola.query } : {}),
            }),
          );
          stats.oracle++;
          if (none.status !== res.status || code(none) !== code(res))
            problems.push(`existence oracle as ${attacker.kind}: foreign record ${brief(res)} vs no record ${brief(none)}`);
        } else if (!bola.absent)
          problems.push(`BOLA as ${attacker.kind}: a refusal other than 404 needs an absent-record comparison or a reason`);
      }
    }
  }

  // 5. Kill switch: AI routes answer 503 AI_UNAVAILABLE while AI is off.
  if (ai && route.host === 'api') {
    const res = await h.apiKill.request<Json>(build(op, route, c, c.as));
    stats.killSwitch++;
    if (res.status !== 503 || code(res) !== 'AI_UNAVAILABLE') problems.push(`kill switch: ${brief(res)} (want 503 AI_UNAVAILABLE)`);
  }

  // 6. The owner's call: success (schema, audit and PII marks checked by the pipeline) and projection.
  const res = await send(build(op, route, c, c.as));
  stats.owner++;
  const want = c.status ?? op.successStatus;
  if (res.status !== want) {
    problems.push(`owner: ${brief(res)} (want ${want})`);
    return problems;
  }
  if (has(route, '4EYES') && res.status === 202 && res.body?.status !== 'pending') problems.push(`4EYES: ${res.text.slice(0, 200)}`);
  const tradeAllowed =
    !!c.trade ||
    ('org' in c.as &&
      !!c.as.org &&
      (c.as.org.type === 'vendor' || c.as.org.type === 'hybrid_provider_vendor') &&
      route.path.includes('/vendor/'));
  for (const v of projectionViolations(res.body, { opId: op.opId, vins: h.vins, tradeAllowed })) problems.push(`projection ${v}`);
  if (driver && objectParams(op, route).length === 0 && route.method === 'GET') {
    const owned = new Set(ids(res));
    const seen = await send(build(op, route, c, driver));
    stats.driver++;
    const leaked = ids(seen).filter((id) => owned.has(id));
    if (seen.status !== 200 || owned.size === 0 || leaked.length > 0)
      problems.push(
        `fleet driver list: ${seen.status}, ${leaked.length} of the owner's ${owned.size} records visible (want 200, none of a non-empty owner list)`,
      );
  }
  if (c.check) {
    try {
      await c.check(res);
    } catch (err) {
      problems.push(`check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** One generated suite per module: every route of the module, in registry order. */
export function contractSuite(module: string, resolvers: Resolvers, routes: readonly RouteRef[]): void {
  const registry = loadRegistry();
  const stats: Stats = {
    routes: 0,
    owner: 0,
    skipped: [],
    negatives: 0,
    bola: 0,
    bolaSkipped: 0,
    bfla: 0,
    driver: 0,
    oracle: 0,
    killSwitch: 0,
    admin: 0,
  };
  let h: Harness;

  beforeAll(async () => {
    h = await Harness.start();
  }, 180_000);
  afterAll(async () => {
    await h?.close();
    console.log(
      `contract sweep ${module}: ${stats.routes} routes, ${stats.owner} owner calls, ${stats.negatives} schema negatives, ` +
        `${stats.bfla} same-organization BFLA checks, ${stats.driver} fleet-driver checks, ${stats.bola} BOLA checks (${stats.bolaSkipped} n/a, ` +
        `${stats.oracle} existence-oracle checks), ` +
        `${stats.killSwitch} kill-switch checks, ${stats.admin} admin-plane checks` +
        (stats.skipped.length ? `; skipped: ${stats.skipped.join('; ')}` : ''),
    );
  });

  describe(`contract sweep: ${module}`, () => {
    it('the generated route list matches the registry and every operation has a resolver', () => {
      const expected = registry.operations
        .filter((o) => o.module === module)
        .flatMap((o) => o.routes.filter((r) => r.host !== 'storage').map((r) => `${o.opId} ${r.method} ${r.path}`));
      expect(routes.map((r) => r.join(' '))).toEqual(expected);
      expect([...new Set(routes.map((r) => r[0]))].filter((id) => !resolvers[id])).toEqual([]);
    });

    for (const [opId, method, path] of routes) {
      it(`${opId} ${method} ${path}`, async (ctx) => {
        const op = registry.operations.find((o) => o.opId === opId)!;
        const route = op.routes.find((r) => r.method === method && r.path === path)!;
        stats.routes++;
        const c = await resolvers[opId]!(h, route);
        if ('skip' in c) {
          stats.skipped.push(`${opId}: ${c.skip}`);
          ctx.skip(c.skip);
          return;
        }
        expect(await runRoute(h, op, route, c, stats)).toEqual([]);
      });
    }
  });
}
