import { describe, expect, it } from 'vitest';
import { addDays, counts, issueTransitionAllowed, maxModelYear, profileCompleteness, reminderStatus, type ReminderState } from './rules.js';
import { checkDigit, checkDigitRequired, modelYear, vinLast4, vinValid } from './vin.js';

describe('VIN (52 §8, ISO 3779)', () => {
  it('computes the check digit and requires it only where it is mandatory', () => {
    expect(checkDigit('1HGCM82633A004352')).toBe('3');
    expect(vinValid('1HGCM82633A004352')).toBe(true);
    expect(vinValid('1HGCM82643A004352')).toBe(false); // North America: wrong check digit
    expect(checkDigitRequired('NAAN01CA9EK123456')).toBe(false);
    expect(vinValid('NAAN01CA9EK123456')).toBe(true); // pilot region (Iran, WMI NA*): position 9 is free
    expect(vinValid('LSGPC52U6AF102179')).toBe(checkDigit('LSGPC52U6AF102179') === '6'); // China: required
    expect(vinValid('1HGCM82633A00435')).toBe(false);
    expect(vinValid('1HGCM82633A00435O')).toBe(false); // O is not allowed
    expect(vinLast4('1HGCM82633A004352')).toBe('4352');
  });

  it('decodes the model year (30-year cycle) as the latest year not after next year', () => {
    expect(modelYear('1HGCM82633A004352', 2026)).toBe(2003);
    expect(modelYear('NAAN01CA9EK123456', 2026)).toBe(2014); // E → 1984 / 2014
    expect(modelYear('NAAN01CA9YK123456', 2026)).toBe(2000); // Y → 2000 / 2030 (after 2027)
    expect(modelYear('NAAN01CA9UK123456', 2026)).toBeNull(); // U is not a year code
  });
});

describe('vehicle rules', () => {
  it('counts active and in_repair vehicles toward the limit (52 §21)', () => {
    expect(['active', 'in_repair', 'inactive', 'sold', 'archived'].filter(counts)).toEqual(['active', 'in_repair']);
  });

  it('scores profile completeness with equal weights (brand/model/year always met)', () => {
    const none = {
      vinPresent: false,
      licensePlate: false,
      nickname: false,
      series: false,
      engineType: false,
      fuelType: false,
      transmission: false,
      bodyStyle: false,
      color: false,
      mileage: false,
      ownershipStart: false,
      photo: false,
    };
    expect(profileCompleteness(none)).toBe(8);
    expect(profileCompleteness({ ...none, vinPresent: true, mileage: true, photo: true })).toBe(31);
    expect(profileCompleteness(Object.fromEntries(Object.keys(none).map((k) => [k, true])) as typeof none)).toBe(100);
    expect(maxModelYear(new Date('2026-10-12T00:00:00Z'))).toBe(2028);
  });

  it('moves reminders upcoming → due → overdue by date or mileage; snoozed stay upcoming', () => {
    const r = (o: Partial<ReminderState>): ReminderState => ({
      status: 'upcoming',
      due_by_date: null,
      due_by_mileage_km: null,
      snoozed_until: null,
      ...o,
    });
    const today = '2026-10-12';
    expect(reminderStatus(r({ due_by_date: '2026-11-30' }), null, today)).toBe('upcoming');
    expect(reminderStatus(r({ due_by_date: addDays(today, 14) }), null, today)).toBe('due');
    expect(reminderStatus(r({ due_by_date: '2026-10-11' }), null, today)).toBe('overdue');
    expect(reminderStatus(r({ due_by_mileage_km: 60_000 }), 59_600, today)).toBe('due');
    expect(reminderStatus(r({ due_by_mileage_km: 60_000 }), 60_000, today)).toBe('overdue');
    expect(reminderStatus(r({ due_by_mileage_km: 60_000 }), null, today)).toBe('upcoming');
    expect(reminderStatus(r({ due_by_date: '2026-10-01', snoozed_until: '2026-10-20' }), null, today)).toBe('upcoming');
    expect(reminderStatus(r({ due_by_date: '2026-10-01', status: 'dismissed' }), null, today)).toBe('dismissed');
  });

  it('allows the issue transitions of 40 §12.2 only', () => {
    expect(issueTransitionAllowed('open', 'investigating')).toBe(true);
    expect(issueTransitionAllowed('scheduled', 'resolved')).toBe(true);
    expect(issueTransitionAllowed('investigating', 'open')).toBe(false);
    expect(issueTransitionAllowed('resolved', 'cancelled')).toBe(false);
  });
});
