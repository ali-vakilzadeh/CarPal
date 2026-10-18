import { describe, expect, it } from 'vitest';
import {
  completeness,
  defaultSlug,
  insightsPeriod,
  isFutureDate,
  openNow,
  PROVIDER_COMPLETENESS,
  providerPublishUnmet,
  validateHours,
  vendorPublishUnmet,
  type ProviderFacts,
  type VendorFacts,
} from './profile-rules.js';
import { mayGrant, mayInvite, mayRemove, ownerRoleFor, roleFitsOrg, roleRank } from './roles.js';

describe('organization roles (40 §0.5, §7.2)', () => {
  it('ranks roles and gives creators the owner role of their type', () => {
    expect(roleRank('provider_owner')).toBeGreaterThan(roleRank('provider_manager'));
    expect(roleRank('fleet_manager')).toBeGreaterThan(roleRank('fleet_maintenance_coordinator'));
    expect(roleRank('fleet_maintenance_coordinator')).toBeGreaterThan(roleRank('fleet_driver'));
    expect(ownerRoleFor('vendor')).toBe('vendor_owner');
    expect(ownerRoleFor('fleet')).toBe('fleet_owner');
    expect(ownerRoleFor('hybrid_provider_vendor')).toBe('provider_owner');
    expect(roleFitsOrg('vendor_staff', 'hybrid_provider_vendor')).toBe(true);
    expect(roleFitsOrg('fleet_driver', 'provider')).toBe(false);
  });

  it('invites never above the inviter and only roles of the organization type', () => {
    expect(mayInvite('provider_manager', 'provider_staff', 'provider')).toBe(true);
    expect(mayInvite('provider_manager', 'provider_owner', 'provider')).toBe(false);
    expect(mayInvite('provider_owner', 'fleet_driver', 'provider')).toBe(false);
    expect(mayInvite('fleet_maintenance_coordinator', 'fleet_driver', 'fleet')).toBe(true);
  });

  it('grants owner and manager roles by an owner only; managers remove lower roles only', () => {
    expect(mayGrant('provider_owner', 'provider_manager', 'provider')).toBe(true);
    expect(mayGrant('provider_manager', 'provider_manager', 'provider')).toBe(false);
    expect(mayGrant('fleet_manager', 'fleet_driver', 'fleet')).toBe(true);
    expect(mayRemove('provider_manager', 'provider_staff')).toBe(true);
    expect(mayRemove('provider_manager', 'provider_manager')).toBe(false);
    expect(mayRemove('provider_owner', 'provider_owner')).toBe(true);
  });
});

describe('hours (40 HoursSpec) and open_now', () => {
  it('requires close after open and consistent exceptions', () => {
    expect(validateHours({ weekly: [{ day_of_week: 1, open: '09:00', close: '18:00' }] })).toEqual([]);
    expect(
      validateHours({
        weekly: [{ day_of_week: 1, open: '18:00', close: '09:00' }],
        exceptions: [
          { date: '2026-12-31', closed: true, open: '10:00' },
          { date: '2027-01-01', closed: false },
          { date: '2027-01-01', closed: true },
        ],
      }),
    ).toEqual([
      { pointer: '/hours/weekly/0/close', code: 'order' },
      { pointer: '/hours/exceptions/0/open', code: 'conditional_forbidden' },
      { pointer: '/hours/exceptions/1/open', code: 'conditional_required' },
      { pointer: '/hours/exceptions/1/close', code: 'conditional_required' },
      { pointer: '/hours/exceptions/2/date', code: 'not_unique' },
    ]);
  });

  it('evaluates opening hours in the location time zone, exceptions first', () => {
    const hours = { weekly: [{ day_of_week: 6, open: '09:00', close: '18:00' }], exceptions: [{ date: '2026-10-17', closed: true }] };
    // 2026-10-10 is a Saturday; 06:00Z = 09:30 in Tehran (+03:30).
    expect(openNow(hours, 'Asia/Tehran', new Date('2026-10-10T06:00:00Z'))).toBe(true);
    expect(openNow(hours, 'Asia/Tehran', new Date('2026-10-10T05:00:00Z'))).toBe(false);
    expect(openNow(hours, 'Asia/Tehran', new Date('2026-10-17T06:00:00Z'))).toBe(false);
    expect(openNow(null, 'Asia/Tehran', new Date())).toBeNull();
  });
});

const provider = (o: Partial<ProviderFacts> = {}): ProviderFacts => ({
  orgStatus: 'draft',
  hasProfile: true,
  publicStatus: 'draft',
  descriptionSet: true,
  contactChannels: 1,
  activeLocations: 1,
  verifiedLocations: 0,
  hoursSet: false,
  activeServiceCategories: 1,
  activeCoverage: 1,
  portfolioItems: 0,
  activeCertifications: 0,
  appointmentCapacityEnabled: false,
  reviewCount: 0,
  responseRateKnown: false,
  ...o,
});

describe('publish rules (52 §21) and completeness (MVP Module C)', () => {
  it('lists every unmet provider requirement', () => {
    expect(providerPublishUnmet(provider())).toEqual([]);
    expect(
      providerPublishUnmet(
        provider({ orgStatus: 'suspended', hasProfile: false, activeLocations: 0, activeServiceCategories: 0, activeCoverage: 0 }),
      ),
    ).toEqual(['organization_active', 'provider_profile', 'active_location', 'service_category', 'supported_brand']);
    expect(providerPublishUnmet(provider({ publicStatus: 'suspended' }))).toEqual(['profile_not_suspended']);
  });

  it('lets a vendor publish with an active item or "catalog coming soon"', () => {
    const v: VendorFacts = {
      orgStatus: 'active',
      hasProfile: true,
      publicStatus: 'draft',
      descriptionSet: false,
      activeLocations: 1,
      verifiedLocations: 0,
      hoursSet: false,
      returnPolicySet: false,
      warrantyPolicySet: false,
      responseTargetSet: false,
      activeCoverage: 0,
      catalogComingSoon: false,
      activeItems: 0,
    };
    expect(vendorPublishUnmet(v)).toEqual(['active_item_or_coming_soon']);
    expect(vendorPublishUnmet({ ...v, catalogComingSoon: true })).toEqual([]);
    expect(vendorPublishUnmet({ ...v, activeItems: 3 })).toEqual([]);
  });

  it('scores completeness with equal weights and names the gaps', () => {
    const c = completeness(PROVIDER_COMPLETENESS, provider());
    expect(c.gaps).toEqual([
      'location_verified',
      'hours_set',
      'portfolio_items',
      'reviews_received',
      'response_rate',
      'appointment_availability',
      'certifications',
    ]);
    expect(c.score).toBe(22);
  });

  it('bounds insight periods and future dates', () => {
    expect(insightsPeriod('2026-01-01', '2026-12-31')).toEqual([]);
    expect(insightsPeriod('2025-01-01', '2026-12-31')[0]).toMatchObject({ code: 'out_of_range', limit: '366' });
    expect(insightsPeriod('2026-02-01', '2026-01-01')[0]).toMatchObject({ code: 'order' });
    expect(isFutureDate('2999-01-01')).toBe(true);
    expect(isFutureDate('2020-01-01')).toBe(false);
  });

  it('derives a default slug from the name and the id (S9b)', () => {
    const id = '01a14d07-04d0-7779-bae8-0bbc0ea7ec35';
    expect(defaultSlug('Réza Auto & Suspension', id)).toBe('reza-auto-suspension-0bbc0ea7ec35');
    expect(defaultSlug('تعمیرگاه رضا', id)).toBe('org-0bbc0ea7ec35');
    const long = defaultSlug('a'.repeat(59) + ' b'.repeat(10), id);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/);
  });
});
