// The generated contract artifacts are complete, current and usable by ajv.
import { describe, expect, it } from 'vitest';
import { generate } from '../../tools/contract/generate.js';
import { createContractAjv, ERROR_CODES, loadRegistry, loadSchemas, OPERATION_IDS, ROLE_GROUPS } from './index.js';

describe('generated contract', () => {
  it('is up to date with Docs/40 (same as pnpm contract:check)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of generate().files) {
      const onDisk = readFileSync(new URL(`./generated/${f.name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      expect(onDisk, `${f.name} is stale: run pnpm contract:generate`).toBe(f.content);
    }
  });

  it('declares 406 operations and 458 routes (S9: vehicle transfers, GD-33)', () => {
    const r = loadRegistry();
    expect(r.operationCount).toBe(406);
    expect(OPERATION_IDS).toHaveLength(406);
    expect(r.routeCount).toBe(458);
    for (const op of r.operations) {
      expect(op.routes.length, op.opId).toBeGreaterThan(0);
      for (const route of op.routes) {
        expect(route.path, op.opId).toMatch(/^(\/|<)/);
        if (route.host !== 'storage') expect(route.security.principals.length, op.opId).toBeGreaterThan(0);
      }
    }
  });

  it('puts admin operations on admin-api only and auth operations on the auth server only', () => {
    for (const op of loadRegistry().operations) {
      const hosts = new Set(op.routes.map((r) => r.host));
      if (op.opId.startsWith('admin.')) expect([...hosts], op.opId).toEqual(['admin-api']);
      if (op.opId.startsWith('auth.')) expect([...hosts], op.opId).toEqual(['auth']);
      for (const r of op.routes)
        if (r.host === 'admin-api')
          expect(
            r.security.principals.flat().every((t) => t.tag === 'STF'),
            op.opId,
          ).toBe(true);
    }
  });

  it('references only declared error codes and role groups', () => {
    for (const op of loadRegistry().operations) {
      for (const e of op.errors) {
        // OAuth endpoints use RFC 6749 / 9449 error codes (lowercase), 40 §4.4.
        if (/^[a-z_]+$/.test(e.code)) continue;
        expect(ERROR_CODES, `${op.opId} ${e.code}`).toHaveProperty(e.code);
      }
      for (const r of op.routes) {
        for (const t of r.security.principals.flat().filter((t) => t.tag === 'ORG' || t.tag === 'STF')) {
          for (const g of t.args) expect(ROLE_GROUPS, `${op.opId} ${t.tag}(${g})`).toHaveProperty(g);
        }
      }
    }
  });

  // Compiles > 1,000 schemas: slower than the default 5 s when the unit files run in parallel.
  it('compiles every operation schema with ajv in strict mode', { timeout: 60_000 }, () => {
    const ajv = createContractAjv();
    const { operations } = loadSchemas();
    let compiled = 0;
    for (const [opId, s] of Object.entries(operations)) {
      for (const schema of [s.input, s.response, s.query, ...Object.values(s.alternateResponses ?? {}), ...Object.values(s.pathParams)]) {
        if (!schema) continue;
        expect(() => ajv.compile(schema), opId).not.toThrow();
        compiled++;
      }
    }
    expect(compiled).toBeGreaterThan(1000);
  });

  it('validates a vehicle body: closed objects, bounds and patterns', () => {
    const validate = createContractAjv().compile(loadSchemas().operations['vehicles.create']!.input!);
    const ok = {
      brand_node_id: '01923456-7890-7abc-8def-0123456789ab',
      model_node_id: '01923456-7890-7abc-8def-0123456789ac',
      year: 2019,
      vin: '1HGCM82633A004352',
    };
    expect(validate(ok)).toBe(true);
    expect(validate({ ...ok, extra: 1 })).toBe(false); // unknown field (closed object)
    expect(validate({ ...ok, year: 1900 })).toBe(false); // Int<1950,2100>
    expect(validate({ ...ok, vin: '1HGCM82633A00435O' })).toBe(false); // VIN never contains O
    const { year: _year, ...missing } = ok;
    expect(validate(missing)).toBe(false); // required
  });
});
