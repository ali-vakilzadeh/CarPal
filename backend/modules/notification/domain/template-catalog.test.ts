// Backend S17 (A-NOTIF-01, DQ-05): the template catalog (locks, channels, variables, translation flags, rendering with
// an override over the code text), the digest schedule and the staff notice routes.
import { describe, expect, it } from 'vitest';
import { digestDue, localClock } from './preferences.js';
import { route, ROUTED_EVENTS } from './routing.js';
import {
  catalog,
  catalogEntry,
  codeText,
  overrideMap,
  renderWith,
  sampleParams,
  translationFlags,
  unknownPlaceholders,
} from './template-catalog.js';
import { TEMPLATES } from './templates.js';

const ov = (template_key: string, channel: string, locale: string, subject: string | null, body: string) => ({
  template_key,
  channel,
  locale,
  subject,
  body,
});

describe('template catalog', () => {
  it('lists every code template once; transactional and critical ones are locked', () => {
    const all = catalog();
    expect(all.map((t) => t.key)).toEqual(Object.keys(TEMPLATES).sort());
    expect(catalogEntry('identity.password_reset')).toMatchObject({ kind: 'transactional', editable: false, channels: ['email'] });
    expect(catalogEntry('identity.otp_code')!.channels).toEqual(['email', 'sms']);
    expect(catalogEntry('system.security_alert')).toMatchObject({ kind: 'notification', alwaysDelivered: true, editable: false });
    expect(catalogEntry('inquiry.received')).toMatchObject({ editable: true, alwaysDelivered: false, channels: ['email', 'push'] });
    expect(catalogEntry('appointment.reminder')!.channels).toEqual(['email', 'push', 'sms']);
    // In-app only: the clients' dictionary, nothing to override here.
    expect(catalogEntry('staff.four_eyes_outcome')!.channels).toEqual([]);
    expect(catalogEntry('nope')).toBeUndefined();
  });

  it('offers the placeholders of the code text (and the router extras) as variables', () => {
    expect(catalogEntry('inventory.import_finished')!.variables).toEqual(['created_count', 'error_count', 'updated_count']);
    expect(catalogEntry('system.security_alert')!.variables).toEqual(['kind']);
    const entry = catalogEntry('inventory.import_finished')!;
    expect(unknownPlaceholders(entry, 'Done: {created_count}', '{vin} and {plate}')).toEqual(['vin', 'plate']);
    expect(unknownPlaceholders(entry, undefined, 'no placeholders')).toEqual([]);
  });

  it('flags a copied language as missing and an override in one language as outdated in the other', () => {
    const none = overrideMap([]);
    expect(translationFlags('inquiry.received', 'email', 'fa', none)).toEqual({ missing: false, outdated: false });
    const en = codeText('inquiry.received', 'email', 'en');
    const copied = overrideMap([ov('inquiry.received', 'email', 'fa', en.subject, en.body)]);
    expect(translationFlags('inquiry.received', 'email', 'fa', copied).missing).toBe(true);
    const enOnly = overrideMap([ov('inquiry.received', 'email', 'en', 'New inquiry', 'A customer asked.')]);
    expect(translationFlags('inquiry.received', 'email', 'fa', enOnly)).toEqual({ missing: false, outdated: true });
    expect(translationFlags('inquiry.received', 'email', 'en', enOnly)).toEqual({ missing: false, outdated: false });
  });

  it('renders the override of the channel and language, else the code text', () => {
    const o = overrideMap([
      ov('inventory.import_finished', 'email', 'en', 'Import {created_count}', 'Created {created_count}.'),
      ov('inventory.import_finished', 'sms', 'en', null, 'SMS {error_count}'),
    ]);
    const params = { created_count: 2, updated_count: 0, error_count: 1 };
    expect(renderWith('inventory.import_finished', 'en', 'email', params, o)).toMatchObject({ subject: 'Import 2', text: 'Created 2.' });
    expect(renderWith('inventory.import_finished', 'en', 'sms', params, o).text).toBe('SMS 1');
    // push and FA have no override: the code text.
    expect(renderWith('inventory.import_finished', 'en', 'push', params, o).title).toBe('Inventory import finished');
    expect(renderWith('inventory.import_finished', 'fa', 'email', params, o).subject).toBe('ورود کالاها تمام شد');
    expect(sampleParams(['created_count', 'organization_name'], { created_count: 5 })).toEqual({
      created_count: 5,
      organization_name: 'Sample Garage',
    });
  });
});

describe('digest schedule (52 NotificationRules)', () => {
  const at = (iso: string) => new Date(iso);
  const base = { timeZone: 'UTC', digestHour: 9, weeklyDigestDay: 6 };

  it('sends daily digests at the digest hour on the recipient clock, never later than a day', () => {
    expect(localClock(at('2026-11-14T05:40:00Z'), 'Asia/Tehran')).toEqual({ hour: 9, weekday: 6 });
    const oldest = at('2026-11-14T06:00:00Z');
    expect(digestDue({ ...base, now: at('2026-11-14T08:30:00Z'), oldest, weekly: false })).toBe(false);
    expect(digestDue({ ...base, now: at('2026-11-14T09:05:00Z'), oldest, weekly: false })).toBe(true);
    expect(
      digestDue({ ...base, timeZone: 'Asia/Tehran', now: at('2026-11-14T05:40:00Z'), oldest: at('2026-11-14T05:00:00Z'), weekly: false }),
    ).toBe(true);
    // Missed the hour: at most a day after the oldest message.
    expect(digestDue({ ...base, now: at('2026-11-15T06:00:00Z'), oldest, weekly: false })).toBe(true);
  });

  it('sends weekly digests on the weekly day only, never later than a week', () => {
    const oldest = at('2026-11-10T10:00:00Z'); // Tuesday
    expect(digestDue({ ...base, now: at('2026-11-13T09:00:00Z'), oldest, weekly: true })).toBe(false); // Friday 09:00
    expect(digestDue({ ...base, now: at('2026-11-14T09:00:00Z'), oldest, weekly: true })).toBe(true); // Saturday 09:00
    expect(digestDue({ ...base, weeklyDigestDay: 1, now: at('2026-11-17T10:00:00Z'), oldest, weekly: true })).toBe(true); // a week
  });
});

describe('staff notices (S17 routes)', () => {
  const e = (type: string, payload: Record<string, unknown>) => ({ type, aggregateType: 'x', aggregateId: 'agg-1', payload });

  it('routes every staff event', () => {
    for (const t of [
      'four_eyes.decided',
      'feature_flag.changed',
      'staff.recovery_requested',
      'staff.recovery_completed',
      'staff.break_glass',
    ])
      expect(ROUTED_EVENTS).toContain(t);
  });

  it('tells the requester the four-eyes outcome, in-app only', () => {
    const [i] = route(e('four_eyes.decided', { requested_by: 'u1', status: 'expired', op_id: 'admin.flag_update' }));
    expect(i).toMatchObject({
      audience: { kind: 'users', ids: ['u1'] },
      event_type: 'four_eyes_outcome',
      template_key: 'staff.four_eyes_outcome',
      params: { op_id: 'admin.flag_update', status: 'expired' },
      reference: { type: 'pending_change', id: 'agg-1' },
      channels: ['in_app'],
      priority: 'normal',
    });
    expect(route(e('four_eyes.decided', { requested_by: 'u1', status: 'pending' }))).toEqual([]);
  });

  it('tells administrators about the kill switch only, and about staff security without the member', () => {
    expect(route(e('feature_flag.changed', { key: 'map.enabled', enabled: false }))).toEqual([]);
    expect(route(e('feature_flag.changed', { key: 'ai.automation.kill_switch', enabled: true }))[0]).toMatchObject({
      audience: { kind: 'staff', roles: ['platform_admin'], except: null },
      event_type: 'ai_kill_switch_changed',
      priority: 'critical',
      params: { enabled: 'on' },
    });
    expect(route(e('staff.break_glass', { user_id: 'm1', staff_name: 'Mina' }))[0]).toMatchObject({
      audience: { kind: 'staff', roles: ['platform_admin'], except: 'm1' },
      event_type: 'staff_security_alert',
      template_key: 'staff.break_glass_notice',
      params: { staff_name: 'Mina' },
      reference: { type: 'user_account', id: 'm1' },
    });
    expect(route(e('staff.recovery_requested', { user_id: 'm1', staff_name: 'Mina' }))[0]!.template_key).toBe('staff.recovery_waiting');
    expect(route(e('staff.recovery_completed', { user_id: 'm1', staff_name: 'Mina' }))[0]!.template_key).toBe('staff.recovery_done');
  });
});
