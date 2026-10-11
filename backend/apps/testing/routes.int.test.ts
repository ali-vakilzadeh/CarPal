// S2 acceptance: "A request to every registered op returns either its real
// response or 501 NOT_IMPLEMENTED, never an unregistered 404" — on all three
// HTTP hosts, through the full pipeline with a caller the route allows. The
// same sweep runs the BFLA/BOLA matrix of every route (libs/testing).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRegistry } from '#libs/contract/index.js';
import { FlagService } from '#libs/flags/index.js';
import type { HttpHostName } from '#libs/runtime/index.js';
import { routeMatrix, type MaterializedRequest } from '#libs/testing/index.js';
import { createTestApp, type TestApp } from './test-app.js';

const hosts: HttpHostName[] = ['api', 'admin-api', 'auth'];
const apps = new Map<HttpHostName, TestApp>();

beforeAll(async () => {
  for (const host of hosts) apps.set(host, await createTestApp({ host }));
});
afterAll(async () => {
  for (const app of apps.values()) await app.close();
});

function bodyFor(encoding: string, method: string): { body?: unknown; headers?: Record<string, string> } {
  if (encoding === 'json') return { body: {} };
  if (encoding === 'form') return { body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  return method === 'GET' || method === 'DELETE' ? {} : {};
}

async function call(app: TestApp, method: string, encoding: string, r: MaterializedRequest) {
  const b = bodyFor(encoding, method);
  return app.request({
    method,
    path: r.path,
    ...(r.token ? { token: r.token } : {}),
    client: r.client,
    headers: { ...r.headers, ...b.headers },
    ...(b.body !== undefined ? { body: b.body } : {}),
  });
}

describe('every contract route is registered on its host and passes the pipeline', () => {
  it('covers all 449 HTTP routes of the registry (the storage PUT is not an API route)', () => {
    const total = [...apps.values()].reduce((n, a) => n + a.http.routes.entries.length, 0);
    const registry = loadRegistry();
    expect(total).toBe(registry.routeCount - registry.operations.flatMap((o) => o.routes).filter((r) => r.host === 'storage').length);
  });

  for (const host of hosts) {
    it(`${host}: allowed callers reach the handler (501 until implemented); denied callers get 401/404`, async () => {
      const app = apps.get(host)!;
      const flags = app.app.get(FlagService, { strict: false });
      const problems: string[] = [];
      let checked = 0;
      for (const entry of app.http.routes.entries) {
        const { op, route } = entry;
        const label = `${op.opId} ${route.method} ${route.path}`;
        const matrix = routeMatrix(op, route);
        // Registered: the router matches the concrete path.
        const sample = await app.principals.request(matrix.allowed[0]!, route);
        if (app.http.routes.match(route.method, sample.path).kind !== 'match')
          problems.push(`${label}: router does not match ${sample.path}`);
        if (app.http.implemented.has(op.opId)) continue; // real responses are tested per operation

        let expected = 501;
        let expectedCode = 'NOT_IMPLEMENTED';
        for (const t of route.security.tags.filter((x) => x.tag === 'FLAG' && !x.qualifier)) {
          for (const key of t.args) {
            if (!(await flags.isEnabled(key))) {
              const ai = (await flags.type(key)) === 'ai_feature' || key.startsWith('ai.');
              expected = ai ? 503 : 403;
              expectedCode = ai ? 'AI_UNAVAILABLE' : 'FEATURE_DISABLED';
            }
          }
        }
        for (const spec of matrix.allowed) {
          const res = await call(app, route.method, op.inputEncoding, await app.principals.request(spec, route));
          checked++;
          if (res.status !== expected || (res.body as { code?: string }).code !== expectedCode) {
            problems.push(
              `${label} as ${JSON.stringify(spec)}: ${res.status} ${(res.body as { code?: string }).code ?? res.text.slice(0, 80)} (want ${expected} ${expectedCode})`,
            );
          }
        }
        for (const d of matrix.denied) {
          const res = await call(app, route.method, op.inputEncoding, await app.principals.request(d.spec, route));
          checked++;
          if (res.status !== d.status)
            problems.push(
              `${label} denied ${JSON.stringify(d.spec)} (${d.why}): ${res.status} ${(res.body as { code?: string }).code} (want ${d.status})`,
            );
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(app.http.routes.entries.length);
      console.log(`${host}: ${app.http.routes.entries.length} routes, ${checked} pipeline checks`);
    });
  }
});
