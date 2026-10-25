import { CONTRACT, ENUMS, ERROR_CODES, OPERATIONS, type OperationInput, type OperationResponse } from '@carpal/api-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { generateFiles, staleFiles } from './generate';

describe('contract generation (GD-04)', () => {
  it('shared/api-contracts/generated is up to date with backend/libs/contract/generated', async () => {
    expect(staleFiles(await generateFiles())).toEqual([]);
  });

  it('exposes the operation map with routes and parsed sec tags', () => {
    expect(CONTRACT.operationCount).toBe(Object.keys(OPERATIONS).length);
    expect(OPERATIONS['health.get'].routes[0]).toMatchObject({ host: 'api', path: '/v1/health' });
    expect(OPERATIONS['config.client']).toMatchObject({ method: 'GET', rateLimit: 'public.read', idem: false });

    const create = OPERATIONS['vehicles.create'];
    expect(create.idem).toBe(true);
    expect(create.routes.map((r) => r.scope)).toEqual(['me', 'fleet']);
    expect(OPERATIONS['onboarding.update'].etag).toBe(true);
    expect(OPERATIONS['me.email_change'].aal).toBe('aal2');
    expect(OPERATIONS['questions.search'].featureFlags).toEqual(['qna.enabled']);
    // Fleet drivers reach their {flt} routes (GD-08 amendment): DRV is one of the principal alternatives.
    const driverRoute = OPERATIONS['vehicles.mileage_add'].routes.find((r) => r.scope === 'fleet');
    expect(driverRoute?.principals.some((alt) => alt.some((t) => t.tag === 'DRV'))).toBe(true);
  });

  it('carries enums and the error catalog', () => {
    expect(ENUMS.UrgencyLevel).toContain('safety_critical');
    expect(ERROR_CODES.AI_UNAVAILABLE.status).toBe(503);
  });

  it('types inputs and responses per operation', () => {
    expectTypeOf<OperationResponse<'health.get'>>().toEqualTypeOf<{ status: 'ok' }>();
    expectTypeOf<OperationInput<'vehicles.transfer_request'>>().toHaveProperty('vin');
    expectTypeOf<OperationInput<'health.get'>>().toEqualTypeOf<undefined>();
  });
});
