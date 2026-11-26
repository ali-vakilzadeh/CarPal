// PW1 (unit): provider businesses from memberships, the active business, Workshop and Web UI addresses, and the
// Today rules (safety first, oldest waiting, page counts, finish-your-profile items, jobs ready for photos).
import type { Appointment, Membership } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  finishItems,
  isPlus,
  jobsReadyForPhotos,
  oldestWaitingMinutes,
  pageCount,
  pickBusiness,
  portalHref,
  providerBusinesses,
  safetyFirst,
  splitMinutes,
  waitingForCustomer,
  workshopPath,
  workshopTabOf,
} from './model';

const org = (id: string, name = `Shop ${id}`, type: 'provider' | 'hybrid_provider_vendor' | 'fleet' = 'provider') => ({
  id,
  name,
  organization_type: type,
  slug: null,
  logo_url: null,
  status: 'active' as const,
  verification_status: 'pending' as const,
});

const m = (o: Partial<Membership>): Membership =>
  ({
    id: 'm',
    created_at: '',
    updated_at: '',
    version: 1,
    role: 'provider_owner',
    status: 'active',
    joined_at: null,
    organization: org('a'),
    ...o,
  }) as Membership;

const appt = (o: Partial<Appointment>): Appointment =>
  ({
    id: 'x',
    status: 'requested',
    safety_flag: false,
    urgency_level: 'medium',
    confirmed_start_at: null,
    proposed_start_at: null,
    created_at: '2026-11-25T08:00:00Z',
    ...o,
  }) as Appointment;

describe('providerBusinesses', () => {
  it('keeps active provider memberships, one per organization with the highest role', () => {
    const list = providerBusinesses([
      m({ role: 'individual', organization: null }),
      m({ role: 'fleet_driver', organization: org('f', 'Fleet', 'fleet') }),
      m({ role: 'provider_staff', organization: org('a', 'Reza Auto') }),
      m({ role: 'provider_owner', organization: org('a', 'Reza Auto') }),
      m({ role: 'provider_manager', organization: org('b'), status: 'invited' }),
      m({ role: 'vendor_staff', organization: org('h', 'Hybrid', 'hybrid_provider_vendor') }),
      m({ role: 'provider_staff', organization: org('c', 'Second shop') }),
    ]);
    expect(list.map((b) => [b.orgId, b.role])).toEqual([
      ['a', 'provider_owner'],
      ['c', 'provider_staff'],
    ]);
    expect(isPlus(list[0]!)).toBe(true);
    expect(isPlus(list[1]!)).toBe(false);
  });

  it('picks the requested business, then the stored one, then the first', () => {
    const list = providerBusinesses([m({ organization: org('a') }), m({ organization: org('b') })]);
    expect(pickBusiness(list, 'b', 'a')?.orgId).toBe('b');
    expect(pickBusiness(list, 'zz', 'b')?.orgId).toBe('b');
    expect(pickBusiness(list, null, 'zz')?.orgId).toBe('a');
    expect(pickBusiness([], 'a', 'a')).toBeNull();
  });
});

describe('addresses', () => {
  it('builds Workshop paths and finds the tab', () => {
    expect(workshopPath('fa')).toBe('/fa/provider/today');
    expect(workshopPath('en', 'requests')).toBe('/en/provider/requests');
    expect(workshopTabOf('/fa/provider/requests/123')).toBe('requests');
    expect(workshopTabOf('/fa/provider/start')).toBeNull();
    expect(workshopTabOf('/fa/garage')).toBeNull();
  });

  it('opens the Web UI in the same language with the organization', () => {
    expect(portalHref('https://web.carpals.ir', 'fa', 'org-1')).toBe('https://web.carpals.ir/fa/provider/dashboard?org=org-1');
    expect(portalHref('https://web.carpals.ir/', 'en', null, '/reviews')).toBe('https://web.carpals.ir/en/provider/reviews');
  });
});

describe('Today rules', () => {
  it('puts safety-critical requests first, then the earliest', () => {
    const sorted = safetyFirst([
      appt({ id: 'late', confirmed_start_at: '2026-11-25T12:00:00Z' }),
      appt({ id: 'early', confirmed_start_at: '2026-11-25T08:00:00Z' }),
      appt({ id: 'unsafe', urgency_level: 'safety_critical', confirmed_start_at: '2026-11-25T15:00:00Z' }),
      appt({ id: 'flag', safety_flag: true, confirmed_start_at: '2026-11-25T16:00:00Z' }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['unsafe', 'flag', 'early', 'late']);
  });

  it('measures the oldest waiting request', () => {
    const now = Date.parse('2026-11-25T19:00:00Z');
    expect(
      oldestWaitingMinutes(
        [
          appt({ created_at: '2026-11-25T08:00:00Z' }),
          appt({ created_at: '2026-11-25T18:20:00Z', status: 'provider_reviewing' }),
          appt({ created_at: '2026-11-20T08:00:00Z', status: 'confirmed' }),
        ],
        now,
      ),
    ).toBe(660);
    expect(oldestWaitingMinutes([appt({ status: 'confirmed' })], now)).toBeNull();
    expect(splitMinutes(130)).toEqual({ h: 2, m: 10 });
  });

  it('counts one page and says when there are more', () => {
    const n = (x: number) => String(x);
    expect(pageCount(undefined, n)).toBeNull();
    expect(pageCount({ items: [1, 2], next_cursor: null }, n)).toBe('2');
    expect(pageCount({ items: [1, 2], next_cursor: 'c' }, n)).toBe('2+');
  });

  it('lists the profile gaps the shop can act on, in order', () => {
    expect(finishItems(['reviews_received', 'portfolio_items', 'hours_set', 'location_verified']).map((i) => i.gap)).toEqual([
      'hours_set',
      'portfolio_items',
    ]);
  });

  it('finds completed jobs without a showcase and showcases waiting for the customer', () => {
    const ready = jobsReadyForPhotos(
      [appt({ id: 'a', status: 'completed' }), appt({ id: 'b', status: 'completed' }), appt({ id: 'c', status: 'cancelled' })],
      [{ appointment_id: 'a' }, {}],
    );
    expect(ready.map((a) => a.id)).toEqual(['b']);
    expect(waitingForCustomer({ customer_consent_status: 'requested', status: 'draft' })).toBe(true);
    expect(waitingForCustomer({ customer_consent_status: 'granted', status: 'published' })).toBe(false);
  });
});
