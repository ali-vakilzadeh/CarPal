import { describe, expect, it } from 'vitest';
import { canCall, canCallAny, staffRolesOf } from './index';

describe('role checks (GD-09)', () => {
  it('maps RoleMembership.role values to staff roles', () => {
    expect(staffRolesOf(['platform_moderator', 'provider_owner', 'platform_moderator', 'platform_admin'])).toEqual(['MOD', 'ADM']);
  });

  it('follows the STF(...) sets of the contract', () => {
    expect(canCall('admin.review_approval_decide', ['CRV'])).toBe(true);
    expect(canCall('admin.review_approval_decide', ['SUP'])).toBe(false);
    expect(canCall('admin.audit_search', ['MOD'])).toBe(false);
    expect(canCall('admin.exchange_rate_update', ['ADM'])).toBe(true);
    expect(canCallAny(['admin.audit_search', 'admin.cases_list'], ['MOD'])).toBe(true);
  });

  it('lets any staff member call the GD-07 api reads, and nobody without a staff role', () => {
    expect(canCall('me.get', ['SUP'])).toBe(true);
    expect(canCall('me.get', [])).toBe(false);
  });
});
