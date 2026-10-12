import { describe, expect, it } from 'vitest';
import { ApiError } from '#libs/contract/index.js';
import { requireConsent, NoConsentChecker } from '#libs/consent-gate/index.js';
import { requireEntitlement, UnconfiguredEntitlementChecker, EntitlementChecker } from '#libs/entitlements/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { EmptySafetyLexicon, SafetyCheck, SafetyLexicon, type SafetyTerm } from './index.js';

class Lexicon extends SafetyLexicon {
  async terms(): Promise<SafetyTerm[]> {
    return [
      { termNormalized: 'brake failure', nodeId: 'n-brake', urgency: 'safety_critical' },
      { termNormalized: 'ترمز نمی گیره', nodeId: 'n-brake', urgency: 'safety_critical' },
      { termNormalized: 'smoke', nodeId: 'n-smoke', urgency: 'high' },
    ];
  }
}

describe('SafetyCheck', () => {
  it('matches normalized whole phrases and reports the highest urgency', async () => {
    const check = new SafetyCheck(new Lexicon());
    expect(await check.check('Sudden BRAKE   failure on highway')).toEqual({
      safety_flag: true,
      urgency: 'safety_critical',
      matched_node_ids: ['n-brake'],
    });
    // Arabic yeh/kaf and ZWNJ variants normalize to the Persian term.
    expect((await check.check('ماشینم ترمز نمی‌گيره')).safety_flag).toBe(true);
    expect(await check.check('smokey bacon')).toEqual({ safety_flag: false, urgency: null, matched_node_ids: [] });
    expect((await new SafetyCheck(new EmptySafetyLexicon()).check('brake failure')).safety_flag).toBe(false);
  });

  it('never lets AI lower the rule-based urgency (SEC-AI-7)', () => {
    expect(SafetyCheck.merge('safety_critical', 'low')).toBe('safety_critical');
    expect(SafetyCheck.merge('medium', 'high')).toBe('high');
    expect(SafetyCheck.merge(null, 'low')).toBe('low');
  });
});

describe('guard shells', () => {
  const scope = {} as TxScope;
  it('consent gate fails closed until identity provides the checker', async () => {
    await expect(
      requireConsent(new NoConsentChecker(), scope, { consentType: 'vehicle_data_sharing', subject: { type: 'user', id: 'u' } }),
    ).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      status: 403,
    });
  });

  it('entitlements fail loudly when unbound and report limit codes', async () => {
    await expect(
      requireEntitlement(new UnconfiguredEntitlementChecker(), scope, { type: 'user', id: 'u' }, 'max_vehicles', 1),
    ).rejects.toBeInstanceOf(ApiError);
    class Deny extends EntitlementChecker {
      async check() {
        return { allowed: false, limit: 5 };
      }
    }
    await expect(requireEntitlement(new Deny(), scope, { type: 'user', id: 'u' }, 'max_vehicles', 1)).rejects.toMatchObject({
      code: 'VEHICLE_LIMIT_REACHED',
      status: 409,
    });
    await expect(requireEntitlement(new Deny(), scope, { type: 'organization', id: 'o' }, 'export_enabled')).rejects.toMatchObject({
      code: 'ENTITLEMENT_REQUIRED',
    });
  });
});
