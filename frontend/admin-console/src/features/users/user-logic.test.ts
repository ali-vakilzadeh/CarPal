// AC10.T1-T3 unit tests of the user rules: the one-identifier search body (Persian digits, Iranian mobile numbers,
// UUIDs), platform roles from memberships, grantable roles, onboarding flows and status changes.
import { describe, expect, it } from 'vitest';
import type { Membership } from '@carpal/api-contracts';
import { grantableRoles, lookupBody, onboardingFlows, platformRoles, statusChanges } from './user-logic';

const m = (role: Membership['role'], o: Partial<Membership> = {}): Membership => ({
  id: `m-${role}`,
  created_at: '2026-11-01T08:00:00Z',
  updated_at: '2026-11-01T08:00:00Z',
  version: 1,
  organization: null,
  role,
  status: 'active',
  joined_at: '2026-11-01T08:00:00Z',
  ...o,
});
const ORG = {
  id: 'o1',
  name: 'Pars',
  organization_type: 'provider',
  slug: null,
  logo_url: null,
  status: 'active',
  verification_status: 'verified',
} as const;

describe('lookupBody (Docs/40 UserSearch: exactly one identifier)', () => {
  it('normalises email, phone, name and id; rejects malformed input', () => {
    expect(lookupBody('email', '  Sara@Example.COM ')).toEqual({ body: { email: 'sara@example.com' } });
    expect(lookupBody('email', 'sara')).toEqual({ problem: 'invalid' });
    expect(lookupBody('phone', '۰۹۱۲ ۳۴۵ ۶۷۸۹')).toEqual({ body: { phone: '+989123456789' } });
    expect(lookupBody('phone', '+98 (912) 345-6789')).toEqual({ body: { phone: '+989123456789' } });
    expect(lookupBody('phone', '00989123456789')).toEqual({ body: { phone: '+989123456789' } });
    expect(lookupBody('phone', '12345')).toEqual({ problem: 'invalid' });
    expect(lookupBody('name', 'سارا')).toEqual({ body: { name: 'سارا' } });
    expect(lookupBody('name', 'x')).toEqual({ problem: 'invalid' });
    expect(lookupBody('user_id', '0193A3C4-5D6E-7F80-9A1B-0000000000A1')).toEqual({
      body: { user_id: '0193a3c4-5d6e-7f80-9a1b-0000000000a1' },
    });
    expect(lookupBody('user_id', 'abc')).toEqual({ problem: 'invalid' });
    expect(lookupBody('email', '   ')).toEqual({ problem: 'required' });
  });
});

describe('roles and flows', () => {
  const ms = [
    m('individual'),
    m('platform_moderator'),
    m('platform_support', { status: 'suspended' }),
    m('platform_admin', { status: 'removed' }),
    m('provider_owner', { organization: ORG }),
  ];
  it('platform roles are memberships without an organization; removed ones are history', () => {
    expect(platformRoles(ms)).toEqual([
      { role: 'platform_moderator', status: 'active' },
      { role: 'platform_support', status: 'suspended' },
    ]);
    expect(grantableRoles(ms)).toEqual(['platform_admin', 'platform_community_reviewer']);
  });

  it('onboarding flows: personal, plus the business kinds the user owns or runs', () => {
    expect(onboardingFlows(ms)).toEqual(['individual', 'provider']);
    expect(onboardingFlows([m('fleet_driver', { organization: ORG })])).toEqual(['individual']);
    expect(
      onboardingFlows([m('fleet_manager', { organization: ORG }), m('vendor_owner', { organization: ORG, status: 'removed' })]),
    ).toEqual(['individual', 'fleet']);
  });

  it('status changes: suspend active accounts, reactivate suspended ones, nothing for deleted or deactivated', () => {
    expect(statusChanges('active')).toEqual(['suspend']);
    expect(statusChanges('pending_verification')).toEqual(['suspend']);
    expect(statusChanges('suspended')).toEqual(['reactivate']);
    expect(statusChanges('deleted')).toEqual([]);
    expect(statusChanges('deactivated')).toEqual([]);
  });
});
