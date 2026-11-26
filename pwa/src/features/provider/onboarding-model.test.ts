// PW2 (unit): where a returning owner resumes, which business is being set up, the publish requirements in the
// owner's words, and the working-hours preset with its rules.
import { describe, expect, it } from 'vitest';
import type { Business } from './model';
import {
  availabilityRules,
  badDays,
  dataStep,
  hoursSpec,
  pickDraft,
  presetHours,
  regionCountry,
  resumeStep,
  serviceModesFor,
  unmetItems,
  weekOrder,
} from './onboarding-model';

const full = { hasProfile: true, locations: 1, categories: 2, brands: 1 };

describe('resume (PW2.T2)', () => {
  it('starts a new business at step 1', () => {
    expect(resumeStep(undefined, null)).toBe('business');
    expect(resumeStep('hours', null)).toBe('business');
  });

  it('continues at the saved step: leaving after step 2 comes back at step 3', () => {
    expect(resumeStep('services', { ...full, categories: 0, brands: 0 })).toBe('services');
    expect(resumeStep('location', full)).toBe('location');
  });

  it('never skips missing data, whatever the saved step says', () => {
    expect(resumeStep('hours', { ...full, locations: 0 })).toBe('location');
    expect(resumeStep('services', { ...full, hasProfile: false })).toBe('business');
  });

  it('lets the data decide when the saved step is unusable (a completed flow of an earlier business)', () => {
    expect(resumeStep('done', full)).toBe('hours');
    expect(resumeStep('done', { ...full, brands: 0 })).toBe('services');
    expect(resumeStep(null, { ...full, locations: 0 })).toBe('location');
  });

  it('dataStep needs a profile, a location, a repair and a brand', () => {
    expect(dataStep({ hasProfile: false, locations: 0, categories: 0, brands: 0 })).toBe('business');
    expect(dataStep({ ...full, categories: 0 })).toBe('services');
    expect(dataStep(full)).toBe('hours');
  });
});

const biz = (orgId: string, o: Partial<Business> = {}): Business => ({
  orgId,
  name: orgId,
  role: 'provider_owner',
  orgStatus: 'draft',
  verification: 'unverified',
  ...o,
});

describe('pickDraft', () => {
  it('takes an unpublished business the user owns, the active one first', () => {
    const list = [biz('live', { orgStatus: 'active' }), biz('d1'), biz('d2')];
    expect(pickDraft(list, null)!.orgId).toBe('d1');
    expect(pickDraft(list, 'd2')!.orgId).toBe('d2');
    expect(pickDraft(list, 'live')!.orgId).toBe('d1');
  });

  it('never resumes a business the user only works for, or a live one', () => {
    expect(pickDraft([biz('m', { role: 'provider_manager' }), biz('s', { role: 'provider_staff' })], null)).toBeNull();
    expect(pickDraft([biz('a', { orgStatus: 'active' })], 'a')).toBeNull();
  });
});

describe('publish requirements (PW2.T4)', () => {
  it('maps each requirement to the step that fixes it, in step order, unknown ones last', () => {
    expect(unmetItems(['supported_brand', 'something_new', 'active_location', 'service_category', 'supported_brand'])).toEqual([
      { key: 'active_location', step: 'location', known: true },
      { key: 'supported_brand', step: 'services', known: true },
      { key: 'service_category', step: 'services', known: true },
      { key: 'something_new', step: null, known: false },
    ]);
    expect(unmetItems(['organization_active'])).toEqual([{ key: 'organization_active', step: null, known: true }]);
  });
});

describe('hours (PW2.T5)', () => {
  it('presets Saturday to Wednesday 08-18, Thursday 08-13, Friday closed', () => {
    const p = presetHours();
    expect(p.find((h) => h.day === 6)).toEqual({ day: 6, open: true, start: '08:00', end: '18:00' });
    expect(p.find((h) => h.day === 4)).toEqual({ day: 4, open: true, start: '08:00', end: '13:00' });
    expect(p.find((h) => h.day === 5)!.open).toBe(false);
    expect(badDays(p)).toEqual([]);
  });

  it('flags a close that is not after the open, or a broken time, on open days only', () => {
    const p = presetHours().map((h) =>
      h.day === 1 ? { ...h, end: '07:00' } : h.day === 2 ? { ...h, start: '8' } : h.day === 5 ? { ...h, end: '01:00' } : h,
    );
    expect(badDays(p)).toEqual([1, 2]);
  });

  it('writes one rule per open day with capacity 1 and no buffer, and the same hours on the location', () => {
    const p = presetHours();
    const rules = availabilityRules(p, 'loc-1');
    expect(rules).toHaveLength(6);
    expect(rules[0]).toEqual({
      location_id: 'loc-1',
      day_of_week: 0,
      start_time: '08:00',
      end_time: '18:00',
      slot_duration_minutes: 60,
      max_concurrent_appointments: 1,
    });
    expect(rules.some((r) => 'buffer_minutes' in r)).toBe(false);
    expect(hoursSpec(p).weekly).toHaveLength(6);
    expect(hoursSpec(p).weekly.find((w) => w.day_of_week === 4)).toEqual({ day_of_week: 4, open: '08:00', close: '13:00' });
  });

  it('orders the week by language', () => {
    expect(weekOrder('fa')[0]).toBe(6);
    expect(weekOrder('en')[0]).toBe(1);
  });
});

describe('small rules', () => {
  it('a mobile mechanic goes to the customer; the region key gives the country', () => {
    expect(serviceModesFor('mobile_mechanic')).toEqual(['mobile']);
    expect(serviceModesFor('garage')).toEqual(['in_shop']);
    expect(regionCountry('ir-pilot')).toBe('IR');
  });
});
