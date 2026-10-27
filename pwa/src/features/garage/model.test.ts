// P7: garage view models — list groups and chips, plan line, mileage input, history order and the duplicate check,
// document expiry, reminder groups, issue safety and urgency, transfers, completeness.
import type {
  MaintenanceReminder,
  ServiceRecord,
  Subscription,
  Vehicle,
  VehicleDocument,
  VehicleIssue,
  VehicleTransfer,
} from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  canEditRecord,
  completenessEstimate,
  expiryTone,
  findDuplicate,
  groupByYear,
  groupReminders,
  groupVehicles,
  isTab,
  mileageDrop,
  nextReminders,
  parseAmount,
  parseMileage,
  pendingTransfers,
  planLine,
  recordPath,
  recurringCount,
  safetyIssue,
  sortDocuments,
  sortRecords,
  urgencyStyle,
  vehicleChips,
} from './model';

const vehicle = (o: Partial<Vehicle> = {}): Vehicle =>
  ({ id: 'v1', status: 'active', open_issue_count: 0, next_reminder_due: null, profile_completeness: 60, ...o }) as Vehicle;
const record = (o: Partial<ServiceRecord> = {}): ServiceRecord =>
  ({
    id: 'r1',
    created_at: '2026-01-01T00:00:00Z',
    service_date: '2026-03-01',
    service_system_node_id: 'brakes',
    status: 'active',
    verification_status: 'self_reported',
    created_by_type: 'user',
    source_type: 'user_manual',
    evidence: [],
    ...o,
  }) as ServiceRecord;

describe('vehicles', () => {
  it('groups in-use and parked vehicles and shows status chips', () => {
    const list = [
      vehicle({ id: 'a' }),
      vehicle({ id: 'b', status: 'sold' }),
      vehicle({ id: 'c', status: 'in_repair' }),
      vehicle({ id: 'd', status: 'inactive' }),
    ];
    const g = groupVehicles(list);
    expect(g.inUse.map((v) => v.id)).toEqual(['a', 'c']);
    expect(g.parked.map((v) => v.id)).toEqual(['b', 'd']);
    expect(vehicleChips(vehicle({ status: 'in_repair', open_issue_count: 2, next_reminder_due: '2026-11-10' }), '2026-10-26')).toEqual([
      'inRepair',
      'openIssue',
      'serviceDue',
    ]);
    expect(vehicleChips(vehicle({ next_reminder_due: '2027-02-01' }), '2026-10-26')).toEqual([]);
  });

  it('reads the plan line from the subscription, else the vehicles in use', () => {
    const sub = { plan: { max_vehicles: 5, plan_key: 'individual_free' }, usage: { active_vehicles: 5 } } as unknown as Subscription;
    expect(planLine(sub, [])).toEqual({ used: 5, max: 5, atLimit: true });
    expect(planLine(undefined, [vehicle(), vehicle({ status: 'sold' })])).toEqual({ used: 1, max: null, atLimit: false });
  });

  it('parses typed mileage in Latin and Persian digits and warns when it goes down', () => {
    expect(parseMileage('152,400')).toBe(152400);
    expect(parseMileage('۱۵۲٬۴۰۰')).toBe(152400);
    expect(parseMileage('12.5')).toBe(125); // a thousands dot
    expect(parseMileage('-3')).toBeNull();
    expect(parseMileage('2000001')).toBeNull();
    expect(mileageDrop(152400, 15240)).toBe(true);
    expect(mileageDrop(undefined, 1)).toBe(false);
  });

  it('estimates completeness for the live preview', () => {
    expect(completenessEstimate({})).toBe(40);
    expect(completenessEstimate({ vin: 'x', nickname: 'Silver', color: '' })).toBe(49);
  });

  it('routes', () => {
    expect(isTab('history')).toBe(true);
    expect(isTab('edit')).toBe(false);
    expect(recordPath('fa', 'v1', 'new')).toBe('/fa/garage/v1/records/new');
    expect(recordPath('en', 'v1', 'r9')).toBe('/en/garage/v1/records/r9/edit');
  });
});

describe('service history', () => {
  const list = [
    record({ id: 'a', service_date: '2025-04-02', mileage_km: 120000, cost: { amount: '300', currency: 'USD' } }),
    record({ id: 'b', service_date: '2026-10-15', mileage_km: 151000 }),
    record({ id: 'c', service_date: '2026-03-01', mileage_km: 140000, cost: { amount: '90', currency: 'USD' } }),
  ];

  it('sorts by date, mileage or cost and groups the timeline by year', () => {
    expect(sortRecords(list, 'date', 'desc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortRecords(list, 'mileage', 'asc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(sortRecords(list, 'cost', 'desc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(groupByYear(list).map((g) => [g.year, g.records.map((r) => r.id)])).toEqual([
      [2026, ['b', 'c']],
      [2025, ['a']],
    ]);
  });

  it('finds a record with the same date and category, and counts repeats in two years', () => {
    expect(findDuplicate(list, { service_date: '2026-03-01', service_system_node_id: 'brakes' })?.id).toBe('c');
    expect(findDuplicate(list, { service_date: '2026-03-01', service_system_node_id: 'brakes' }, 'c')).toBeNull();
    expect(findDuplicate(list, { service_date: '2026-03-02', service_system_node_id: 'brakes' })).toBeNull();
    expect(recurringCount(list, 'brakes', '2026-10-20')).toBe(3);
    expect(recurringCount(list, 'brakes', '2028-10-20')).toBe(0);
  });

  it('lets users edit only records they added', () => {
    expect(canEditRecord(record())).toBe(true);
    expect(canEditRecord(record({ created_by_type: 'organization', source_type: 'provider_logged' }))).toBe(false);
    expect(canEditRecord(record({ source_type: 'appointment_completed', created_by_type: 'system' }))).toBe(false);
  });

  it('parses amounts', () => {
    expect(parseAmount('1,250,000')).toBe('1250000');
    expect(parseAmount('۱۲٫۵')).toBe('12.5');
    expect(parseAmount('12.345')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('documents, reminders, issues, transfers', () => {
  it('colours expiry and sorts by nearest expiry', () => {
    expect(expiryTone('2026-10-01', '2026-10-26')).toBe('expired');
    expect(expiryTone('2026-11-10', '2026-10-26')).toBe('soon');
    expect(expiryTone('2027-06-01', '2026-10-26')).toBe('ok');
    expect(expiryTone(undefined, '2026-10-26')).toBe('none');
    const doc = (id: string, expires_at?: string, status: 'active' | 'removed' = 'active') =>
      ({ id, expires_at, status, created_at: `2026-0${id.length}-01T00:00:00Z` }) as VehicleDocument;
    expect(
      sortDocuments([doc('a'), doc('b', '2027-01-01'), doc('c', '2026-11-01'), doc('d', '2026-01-01', 'removed')]).map((d) => d.id),
    ).toEqual(['c', 'b', 'a']);
  });

  it('groups reminders as Overdue, Due soon, Upcoming and picks the next two', () => {
    const r = (id: string, status: MaintenanceReminder['status'], due?: string) =>
      ({ id, status, due_by_date: due }) as MaintenanceReminder;
    const list = [
      r('u', 'upcoming', '2027-01-01'),
      r('o', 'overdue', '2026-09-01'),
      r('d', 'due', '2026-11-01'),
      r('x', 'completed'),
      r('y', 'dismissed'),
    ];
    const g = groupReminders(list);
    expect([g.overdue, g.due, g.upcoming].map((l) => l.map((x) => x.id))).toEqual([['o'], ['d'], ['u']]);
    expect(nextReminders(list).map((x) => x.id)).toEqual(['o', 'd']);
  });

  it('shows the safety banner for an active safety-critical or flagged issue only', () => {
    const i = (o: Partial<VehicleIssue>) => ({ status: 'open', urgency_level: 'low', safety_flag: false, ...o }) as VehicleIssue;
    expect(safetyIssue([i({ urgency_level: 'high' })])).toBeNull();
    expect(safetyIssue([i({ safety_flag: true })])).not.toBeNull();
    expect(safetyIssue([i({ urgency_level: 'safety_critical', status: 'resolved' })])).toBeNull();
    expect(urgencyStyle('safety_critical')).toBe('critical');
    expect(urgencyStyle('low')).toBe('ok');
  });

  it('splits pending ownership requests by direction', () => {
    const t = (id: string, direction: VehicleTransfer['direction'], status: VehicleTransfer['status'] = 'pending') =>
      ({ id, direction, status }) as VehicleTransfer;
    const p = pendingTransfers([t('a', 'incoming'), t('b', 'outgoing'), t('c', 'incoming', 'expired')]);
    expect(p.incoming.map((x) => x.id)).toEqual(['a']);
    expect(p.outgoing.map((x) => x.id)).toEqual(['b']);
  });
});
