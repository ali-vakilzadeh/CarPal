// S9c: shared/api-contracts/openapi.yaml is generated from the registry and
// must match it, the router of every host and the server-defined schemas.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '#libs/contract/index.js';
import { buildOpenApi, OPENAPI_FILE, renderOpenApi, routerProblems, structuralProblems } from './openapi.js';

// Building the document and compiling ~1,700 schemas takes seconds: more than the 5 s default under the parallel unit run.
const SLOW = 120_000;

describe('OpenAPI 3.1 file (pnpm openapi:check)', () => {
  const doc = buildOpenApi();

  it(
    'is up to date (pnpm openapi:generate)',
    () => {
      expect(existsSync(OPENAPI_FILE)).toBe(true);
      expect(readFileSync(OPENAPI_FILE, 'utf8').replace(/\r\n/g, '\n') === renderOpenApi()).toBe(true);
    },
    SLOW,
  );

  it(
    'is structurally sound: references resolve, operation ids are unique, every schema compiles',
    () => {
      expect(structuralProblems(doc)).toEqual([]);
    },
    SLOW,
  );

  it(
    'documents exactly the routes the router serves, on their hosts',
    () => {
      expect(routerProblems(doc)).toEqual([]);
    },
    SLOW,
  );

  it('marks deferred and storage operations and describes every server-defined Json<...> schema', () => {
    const ops = Object.values(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((item) =>
      Object.entries(item)
        .filter(([m]) => m !== 'servers')
        .map(([, o]) => o),
    );
    const byStatus = (s: string) => ops.filter((o) => o['x-carpal-status'] === s).map((o) => o['x-carpal-op-id']);
    expect(byStatus('deferred-post-mvp')).toEqual(['auth.social_start']);
    expect(byStatus('storage-listener')).toEqual(['media.upload_put']);
    expect(byStatus('not-implemented')).toEqual([]);
    expect(ops).toHaveLength(loadRegistry().routeCount);
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    const named = [...JSON.stringify(loadRegistry().operations.map((o) => [o.inputType, o.responseType])).matchAll(/Json<(\w+)>/g)];
    const server = readFileSync(OPENAPI_FILE, 'utf8').match(/x-server-schema/g);
    expect(server).toBeNull();
    for (const n of new Set([...named.map((m) => m[1]!), 'InsightPayload', 'SuggestionPayload', 'TargetSnapshot', 'BadgeEvaluation']))
      expect(schemas[n], n).toBeDefined();
  });
});
