// P12.T4 driver rules: fleets from memberships, the report's urgency and title, validation, approval words and the
// per-user drafts and offline queue.
import type { Membership } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STORE,
  MAX_QUEUE,
  approvalKey,
  driverFleets,
  parseStore,
  reportTitle,
  reportUrgency,
  storeKey,
  validateReport,
  withDraft,
  withQueued,
  withoutDraft,
  withoutQueued,
  type ReportDraft,
} from './model';

const org = (id: string, name: string) =>
  ({
    id,
    name,
    organization_type: 'fleet',
    slug: null,
    logo_url: null,
    status: 'active',
    verification_status: 'unverified',
  }) as Membership['organization'];
const m = (o: Partial<Membership>): Membership =>
  ({
    id: 'm',
    created_at: '',
    updated_at: '',
    organization: null,
    role: 'individual',
    status: 'active',
    joined_at: null,
    ...o,
  }) as Membership;

const draft = (o: Partial<ReportDraft> = {}): ReportDraft => ({
  id: 'r1',
  orgId: 'o1',
  vehicleId: 'v1',
  shortcut: null,
  description: 'Grinding noise when braking',
  urgency: 'medium',
  unsafe: false,
  mileage: '',
  savedAt: '2026-10-31T10:00:00Z',
  ...o,
});

describe('driver fleets', () => {
  it('lists active fleet_driver memberships only, once per fleet', () => {
    const fleets = driverFleets([
      m({ role: 'individual' }),
      m({ role: 'fleet_driver', organization: org('o1', 'Tehran Taxi') }),
      m({ role: 'fleet_driver', organization: org('o1', 'Tehran Taxi') }),
      m({ role: 'fleet_driver', status: 'invited', organization: org('o2', 'Invited') }),
      m({ role: 'fleet_manager', organization: org('o3', 'Managed') }),
    ]);
    expect(fleets).toEqual([{ orgId: 'o1', name: 'Tehran Taxi' }]);
  });
});

describe('issue report', () => {
  it('raises the urgency for "feels unsafe" and an accepted suggestion, never lowers it', () => {
    expect(reportUrgency('low', false)).toBe('low');
    expect(reportUrgency('low', true)).toBe('safety_critical');
    expect(reportUrgency('low', false, 'high')).toBe('high');
    expect(reportUrgency('high', false, 'low')).toBe('high');
    expect(reportUrgency('medium', true, 'low')).toBe('safety_critical');
  });

  it('titles the report by the shortcut or the first words of the description', () => {
    expect(reportTitle('anything', 'Brakes feel wrong')).toBe('Brakes feel wrong');
    expect(reportTitle('  Grinding   noise when braking ', null)).toBe('Grinding noise when braking');
    const long = 'The engine makes a loud knocking sound every morning when I start it and it gets worse uphill';
    const t = reportTitle(long, null);
    expect(t.endsWith('…')).toBe(true);
    expect([...t].length).toBeLessThanOrEqual(61);
  });

  it('needs a vehicle, 10 characters of description (BA-29) and a valid odometer when one is typed', () => {
    expect(validateReport(draft(), null)).toEqual([]);
    expect(validateReport(draft({ vehicleId: '', description: 'short' }), null)).toEqual(['vehicle', 'description']);
    expect(validateReport(draft({ mileage: 'abc' }), null)).toEqual(['mileage']);
    expect(validateReport(draft({ mileage: '152400' }), 152400)).toEqual([]);
  });

  it('names the fleet approval of a report', () => {
    expect(approvalKey({ fleet_approval_status: 'pending' })).toBe('pending');
    expect(approvalKey({ fleet_approval_status: null })).toBeNull();
  });
});

describe('drafts and the offline queue', () => {
  it('keeps one draft per vehicle and moves it to the queue when sending must wait', () => {
    let s = withDraft(EMPTY_STORE, draft());
    expect(s.drafts.v1?.description).toContain('Grinding');
    s = withQueued(s, draft({ id: 'q1' }));
    expect(s.drafts.v1).toBeUndefined();
    expect(s.queue.map((q) => q.id)).toEqual(['q1']);
    s = withQueued(s, draft({ id: 'q1', description: 'updated text here' }));
    expect(s.queue).toHaveLength(1);
    s = withoutQueued(s, 'q1');
    expect(s.queue).toEqual([]);
    expect(withoutDraft(withDraft(EMPTY_STORE, draft()), 'v1').drafts).toEqual({});
  });

  it('caps the queue and reads stored data defensively, per user', () => {
    let s = EMPTY_STORE;
    for (let i = 0; i < MAX_QUEUE + 5; i++) s = withQueued(s, draft({ id: `q${i}`, vehicleId: `v${i}` }));
    expect(s.queue).toHaveLength(MAX_QUEUE);
    expect(s.queue[0]!.id).toBe('q5');
    expect(parseStore('nope')).toEqual(EMPTY_STORE);
    expect(parseStore(JSON.stringify({ drafts: {}, queue: [{ nope: 1 }, draft()] })).queue).toHaveLength(1);
    expect(storeKey('u1')).toBe('cp:drive:u1');
  });
});
