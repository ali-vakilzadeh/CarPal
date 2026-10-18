// Unit checks of the contract sweep (S9b, no database): the generated suites
// are fresh, every HTTP route of the registry has a resolver, and no response
// schema can carry a SEC-OUT-1 field (closed response schemas: a field a
// schema does not declare cannot be returned), full VINs only from
// vehicles.vin_reveal and trade prices only to the vendor's own members.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry, loadSchemas } from '#libs/contract/index.js';
import { contractSuites, SUITE_DIR } from '#tools/contract/contract-tests.js';
import type { Resolvers } from './harness.js';
import { FORBIDDEN_KEYS, projectionViolations, schemaProperties, VIN_OPERATIONS } from './projection.js';

const registry = loadRegistry();

describe('generated contract sweep suites', () => {
  it('are up to date with operations.json (pnpm contract:tests)', () => {
    const expected = contractSuites(registry);
    const onDisk = readdirSync(SUITE_DIR).filter((f) => f.endsWith('.contract.int.test.ts'));
    expect(onDisk.sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) expect(readFileSync(join(SUITE_DIR, file), 'utf8'), file).toBe(content);
  });

  it('cover every HTTP route: each operation has a resolver in its module file', async () => {
    const missing: string[] = [];
    for (const module of new Set(registry.operations.map((o) => o.module))) {
      const { resolvers } = (await import(`./resolvers/${module}.ts`)) as { resolvers: Resolvers };
      for (const op of registry.operations.filter((o) => o.module === module && o.routes.some((r) => r.host !== 'storage')))
        if (!resolvers[op.opId]) missing.push(op.opId);
      const extra = Object.keys(resolvers).filter((id) => !registry.operations.some((o) => o.opId === id && o.module === module));
      expect(extra, `${module}: resolvers for unknown operations`).toEqual([]);
    }
    expect(missing).toEqual([]);
  }, 60_000);
});

describe('projection rules over every response schema (40 Appendix C.4)', () => {
  const schemas = loadSchemas();
  const defs = (schemas.root.$defs ?? {}) as Record<string, Record<string, unknown>>;
  const reachable = (opId: string) => {
    const s = schemas.operations[opId]!;
    return [s.response, ...Object.values(s.alternateResponses ?? {})].flatMap((r) => (r ? schemaProperties(r, defs) : []));
  };

  it('no response schema declares a SEC-OUT-1 field', () => {
    const hits = registry.operations.flatMap((o) =>
      reachable(o.opId)
        .filter((p) => FORBIDDEN_KEYS.has(p.name))
        .map((p) => `${o.opId}: ${p.path}`),
    );
    expect(hits).toEqual([]);
  });

  it('only vehicles.vin_reveal can return a full VIN (SEC-OUT-2)', () => {
    const hits = registry.operations
      .filter((o) => !VIN_OPERATIONS.has(o.opId) && reachable(o.opId).some((p) => p.name === 'vin'))
      .map((o) => o.opId);
    expect(hits).toEqual([]);
  });

  it('price_trade is reachable only on the vendor’s own inventory routes', () => {
    const hits = registry.operations
      .filter((o) => reachable(o.opId).some((p) => p.name === 'price_trade'))
      .filter((o) => o.routes.some((r) => !r.path.startsWith('/v1/orgs/{org_id}/vendor/')))
      .map((o) => o.opId);
    expect(hits).toEqual([]);
  });

  it('the dynamic scan finds forbidden fields, VINs, password hashes and unauthorized trade prices', () => {
    const vins = new Set(['NAAN01CA9EK123456']);
    const body = {
      items: [{ vin: 'NAAN01CA9EK123456', note: 'VIN NAAN01CA9EK123456', price_trade: '80.00' }],
      credential_reference: 'x',
      nested: { hash: '$argon2id$v=19$m=65536' },
    };
    expect(projectionViolations(body, { opId: 'vehicles.get', vins, tradeAllowed: false }).sort()).toEqual(
      [
        '/credential_reference: SEC-OUT-1 field',
        '/items/0/vin: full VIN outside vehicles.vin_reveal',
        '/items/0/vin: full VIN',
        '/items/0/note: full VIN',
        '/items/0/price_trade: trade price without trade access',
        '/nested/hash: password hash',
      ].sort(),
    );
    expect(projectionViolations({ vin: 'NAAN01CA9EK123456' }, { opId: 'vehicles.vin_reveal', vins, tradeAllowed: false })).toEqual([]);
    expect(projectionViolations({ price_trade: '80.00', price_public: null }, { opId: 'inventory.get', vins, tradeAllowed: true })).toEqual(
      [],
    );
  });
});
