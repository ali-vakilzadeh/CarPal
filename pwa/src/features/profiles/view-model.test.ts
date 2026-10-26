// P5 view models: week order (BA-28), hours rows, the capability matrix, "Fit for your car", ratings and media pairs.
import { describe, expect, it } from 'vitest';
import { capability, media, providerProfile } from '../../../tests/support/public-fixtures';
import {
  beforeAfter,
  bestFit,
  capabilitiesForVehicle,
  capabilityMatrix,
  distributionShares,
  hoursRows,
  localNow,
  previewImage,
  primaryLocation,
  slotDays,
  topCapability,
  weekOrder,
} from './view-model';

describe('opening hours', () => {
  it('starts on Saturday in fa and the ir-pilot region, on the locale first day elsewhere', () => {
    expect(weekOrder('fa', 'ir-pilot')).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(weekOrder('en', 'ir-pilot')).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(weekOrder('en', 'other')[0]).toBeTypeOf('number');
    expect(new Set(weekOrder('en', 'other')).size).toBe(7);
  });

  it('reads weekday and date in the location time zone (0 = Sunday)', () => {
    // 2026-10-25 22:00 UTC = Monday 01:30 in Tehran.
    expect(localNow('Asia/Tehran', Date.UTC(2026, 9, 25, 22, 0))).toEqual({ day: 1, time: '01:30', date: '2026-10-26' });
  });

  it('builds rows with today, closed days and a date exception', () => {
    const hours = {
      weekly: [
        { day_of_week: 1, open: '14:00:00', close: '18:00:00' },
        { day_of_week: 1, open: '08:00:00', close: '12:00:00' },
      ],
      exceptions: [{ date: '2026-10-26', closed: true }],
    };
    const rows = hoursRows(hours, [6, 0, 1], { day: 0, date: '2026-10-25' });
    expect(rows.map((r) => r.ranges.length)).toEqual([0, 0, 2]);
    expect(rows[2]!.ranges[0]).toEqual({ open: '08:00', close: '12:00' });
    expect(rows[1]!.today).toBe(true);
    expect(hoursRows(hours, [1], { day: 1, date: '2026-10-26' })[0]!.ranges).toEqual([]);
  });

  it('picks the location with a point first', () => {
    const p = providerProfile();
    const noPoint = { ...p.locations[0]!, id: 'x', point: null };
    expect(primaryLocation({ locations: [noPoint, p.locations[0]!] })?.id).toBe(p.locations[0]!.id);
    expect(primaryLocation({ locations: [] })).toBeNull();
  });
});

describe('capabilities', () => {
  const caps = providerProfile().provider!.capabilities;

  it('groups by vehicle and service system, keeping the strongest level per cell', () => {
    const m = capabilityMatrix([...caps, capability({ confidence_level: 'low_evidence', evidence_count: 1 })], 'All models');
    expect(m.systems).toEqual(['Suspension', 'Brakes']);
    expect(m.rows.map((r) => r.vehicle)).toEqual(['BMW', 'BMW 3 Series E90', 'Toyota Corolla']);
    expect(m.rows[1]!.cells['Suspension']).toEqual({ level: 'strong_evidence', evidence: 19 });
  });

  it('keeps the capabilities that apply to the visitor car and finds the best fit', () => {
    const car = { brand: 'bmw', model: '3 Series', series: 'E90' };
    expect(capabilitiesForVehicle(caps, car)).toHaveLength(2);
    expect(bestFit(caps, car)?.service_system.text).toBe('Suspension');
    expect(bestFit(caps, { brand: 'Peugeot' })).toBeNull();
    expect(topCapability(caps)?.confidence_level).toBe('strong_evidence');
  });
});

describe('ratings, media and slots', () => {
  it('turns the distribution into shares', () => {
    const shares = distributionShares(providerProfile().rating_summary);
    expect(shares[0]).toEqual({ stars: 5, count: 104, share: 83 });
    expect(shares.reduce((n, s) => n + s.count, 0)).toBe(126);
  });

  it('pairs before and after photos and picks the after photo as preview', () => {
    const items = [
      media({ role: 'gallery', display_order: 3 }),
      media({ role: 'before', display_order: 1 }),
      media({ role: 'after', display_order: 2 }),
    ];
    const pair = beforeAfter(items);
    expect(pair.before?.role).toBe('before');
    expect(pair.after?.role).toBe('after');
    expect(pair.rest.map((m) => m.role)).toEqual(['gallery']);
    expect(previewImage([media({ role: 'before', url: 'b' }), media({ role: 'after', url: 'a' })])).toBe('a');
    expect(previewImage([media({ url: null })])).toBeNull();
  });

  it('groups slots by day', () => {
    const slot = (start_at: string) => ({ start_at, end_at: start_at, location_id: 'l', appointment_types: [] });
    const days = slotDays([slot('2026-10-26T08:00'), slot('2026-10-26T09:00'), slot('2026-10-27T08:00')], (iso) => iso.slice(0, 10));
    expect(days.map((d) => [d.label, d.slots.length])).toEqual([
      ['2026-10-26', 2],
      ['2026-10-27', 1],
    ]);
  });
});
